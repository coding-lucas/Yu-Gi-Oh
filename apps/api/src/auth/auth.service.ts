import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { ageInYears, DEMO_CURRENCY, isLocale, MIN_AGE } from '@athosbet/shared';
import { randomUUID } from 'node:crypto';
import { DbService } from '../db/db.service';
import { passwordResets, refreshTokens, users } from '../db/schema';
import { decrypt, encrypt, generateTotpSecret, hashPassword, randomToken, sha256, verifyPassword, verifyTotp } from '../common/crypto';
import { err } from '../common/errors';
import { AuthUser, Role, signAccess, STAFF_ROLES } from '../common/auth';
import { config } from '../config';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../ledger/ledger.service';
import { ComplianceService } from '../compliance/compliance.service';

export const REFRESH_TTL_DAYS = 30;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  dateOfBirth: string;
  country: string;
  locale: string;
  timezone: string;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

export type PublicUser = ReturnType<typeof toPublic>;
export function toPublic(u: typeof users.$inferSelect) {
  return {
    id: u.id, email: u.email, displayName: u.displayName, role: u.role, status: u.status, country: u.country,
    locale: u.locale, timezone: u.timezone, kycStatus: u.kycStatus, mfaEnabled: u.mfaEnabled, createdAt: u.createdAt,
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly compliance: ComplianceService,
  ) {}

  async register(input: RegisterInput, ip: string | null, requestCountry: string): Promise<Session> {
    const dob = new Date(input.dateOfBirth);
    if (Number.isNaN(dob.getTime()) || ageInYears(dob, new Date()) < MIN_AGE) throw err.forbidden('UNDERAGE');
    const country = input.country.toUpperCase();
    if ((await this.compliance.jurisdictionStatus(country)) === 'BLOCKED' || (await this.compliance.jurisdictionStatus(requestCountry)) === 'BLOCKED') {
      throw err.forbidden('JURISDICTION_BLOCKED');
    }
    const hash = await hashPassword(input.password);
    const user = await this.dbs.tx(async (tx) => {
      const existing = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.email.toLowerCase()));
      if (existing.length) throw err.conflict('EMAIL_TAKEN');
      const [u] = await tx.insert(users).values({
        email: input.email.toLowerCase(),
        passwordHash: hash,
        displayName: input.displayName,
        role: 'USER',
        status: 'ACTIVE',
        dateOfBirth: input.dateOfBirth,
        country,
        locale: isLocale(input.locale) ? input.locale : 'en',
        timezone: input.timezone || 'UTC',
        kycStatus: 'NONE',
        mfaEnabled: false,
        failedLogins: 0,
      }).returning();
      // sandbox wallet with fictitious starting balance (never convertible to real money)
      const wallet = await this.ledger.userAccount(tx, u.id, DEMO_CURRENCY, 'SANDBOX');
      const clearing = await this.ledger.houseAccount(tx, 'PAYMENT_CLEARING', DEMO_CURRENCY, 'SANDBOX');
      const grant = BigInt(config().SANDBOX_STARTING_BALANCE);
      if (grant > 0n) {
        await this.ledger.post(tx, {
          type: 'ADJUSTMENT', idempotencyKey: `sandbox-grant:${u.id}`, referenceType: 'user', referenceId: u.id,
          metadata: { reason: 'SANDBOX_WELCOME_BALANCE' },
          entries: [{ accountId: clearing.id, amount: -grant }, { accountId: wallet.id, amount: grant }],
        });
      }
      await this.audit.log({ actorId: u.id, actorRole: 'USER', action: 'auth.register', entityType: 'user', entityId: u.id, after: { email: u.email, country }, ip }, tx);
      return u;
    });
    return this.issue(user, false);
  }

  async login(email: string, password: string, totpCode: string | undefined, ip: string | null): Promise<Session> {
    const [u] = await this.dbs.db.select().from(users).where(eq(users.email, email.toLowerCase()));
    // constant-ish time: always run a hash verification
    const ok = u ? await verifyPassword(password, u.passwordHash) : (await hashPassword(password), false);
    if (!u) throw err.unauthorized('INVALID_CREDENTIALS');
    if (u.lockedUntil && u.lockedUntil > new Date()) throw err.forbidden('ACCOUNT_LOCKED');
    if (!ok) {
      const failed = u.failedLogins + 1;
      await this.dbs.db.update(users).set({
        failedLogins: failed,
        lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        updatedAt: new Date(),
      }).where(eq(users.id, u.id));
      await this.audit.log({ actorId: u.id, action: 'auth.login.failed', entityType: 'user', entityId: u.id, after: { failed }, ip });
      if (failed >= MAX_FAILED) await this.compliance.flag(u.id, 'BRUTE_FORCE_LOCKOUT', 'MEDIUM', { failed, ip });
      throw err.unauthorized('INVALID_CREDENTIALS');
    }
    if (u.status === 'CLOSED') throw err.forbidden('ACCOUNT_CLOSED');
    let mfa = false;
    if (u.mfaEnabled) {
      if (!totpCode) {
        if (STAFF_ROLES.includes(u.role as Role)) throw err.unauthorized('MFA_CODE_REQUIRED');
      } else {
        if (!verifyTotp(decrypt(u.mfaSecretEnc!, config().DATA_ENCRYPTION_KEY), totpCode)) throw err.unauthorized('INVALID_MFA_CODE');
        mfa = true;
      }
    }
    await this.dbs.db.update(users).set({ failedLogins: 0, lockedUntil: null, updatedAt: new Date() }).where(eq(users.id, u.id));
    await this.audit.log({ actorId: u.id, actorRole: u.role, action: 'auth.login', entityType: 'user', entityId: u.id, after: { mfa }, ip });
    return this.issue(u, mfa);
  }

  private async issue(u: typeof users.$inferSelect, mfa: boolean, family: string = randomUUID()): Promise<Session> {
    const refresh = randomToken(48);
    await this.dbs.db.insert(refreshTokens).values({
      userId: u.id, tokenHash: sha256(refresh), family, mfa, expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000),
    });
    const au: AuthUser = { id: u.id, role: u.role as Role, mfa };
    return { accessToken: signAccess(au), refreshToken: refresh, user: toPublic(u) };
  }

  /** Refresh-token rotation with reuse detection: replaying a rotated token revokes the whole family. */
  async refresh(token: string): Promise<Session> {
    const [rt] = await this.dbs.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(token)));
    if (!rt) throw err.unauthorized('INVALID_REFRESH');
    if (rt.revokedAt) {
      await this.dbs.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.family, rt.family), isNull(refreshTokens.revokedAt)));
      await this.audit.log({ actorId: rt.userId, action: 'auth.refresh.reuse_detected', entityType: 'user', entityId: rt.userId });
      throw err.unauthorized('REFRESH_REUSED');
    }
    if (rt.expiresAt < new Date()) throw err.unauthorized('REFRESH_EXPIRED');
    const rotated = await this.dbs.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.id, rt.id), isNull(refreshTokens.revokedAt))).returning();
    if (rotated.length === 0) throw err.unauthorized('REFRESH_REUSED');
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, rt.userId));
    if (!u || u.status === 'CLOSED') throw err.unauthorized();
    return this.issue(u, rt.mfa, rt.family);
  }

  async logout(token: string | undefined) {
    if (!token) return;
    const [rt] = await this.dbs.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(token)));
    if (rt) await this.dbs.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.family, rt.family));
  }

  async me(userId: string) {
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw err.unauthorized();
    return toPublic(u);
  }

  /** Always responds the same way to avoid account enumeration. Token is delivered by e-mail. */
  async forgotPassword(email: string): Promise<{ devToken?: string }> {
    const [u] = await this.dbs.db.select().from(users).where(eq(users.email, email.toLowerCase()));
    if (!u) return {};
    const token = randomToken(32);
    await this.dbs.db.insert(passwordResets).values({ userId: u.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * 60_000) });
    await this.audit.log({ actorId: u.id, action: 'auth.password.forgot', entityType: 'user', entityId: u.id });
    // Mailer integration point. In non-production the token is returned to ease testing.
    return config().NODE_ENV === 'production' ? {} : { devToken: token };
  }

  async resetPassword(token: string, password: string) {
    const hash = await hashPassword(password);
    await this.dbs.tx(async (tx) => {
      const [pr] = await tx.update(passwordResets).set({ usedAt: new Date() })
        .where(and(eq(passwordResets.tokenHash, sha256(token)), isNull(passwordResets.usedAt), sql`${passwordResets.expiresAt} > now()`)).returning();
      if (!pr) throw err.badRequest('INVALID_RESET_TOKEN');
      await tx.update(users).set({ passwordHash: hash, failedLogins: 0, lockedUntil: null, updatedAt: new Date() }).where(eq(users.id, pr.userId));
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, pr.userId), isNull(refreshTokens.revokedAt)));
      await this.audit.log({ actorId: pr.userId, action: 'auth.password.reset', entityType: 'user', entityId: pr.userId }, tx);
    });
  }

  async mfaSetup(userId: string) {
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, userId));
    if (u.mfaEnabled) throw err.conflict('MFA_ALREADY_ENABLED');
    const secret = generateTotpSecret();
    await this.dbs.db.update(users).set({ mfaSecretEnc: encrypt(secret, config().DATA_ENCRYPTION_KEY) }).where(eq(users.id, userId));
    return { secret, otpauthUrl: `otpauth://totp/AthosBet:${encodeURIComponent(u.email)}?secret=${secret}&issuer=AthosBet&digits=6&period=30` };
  }

  async mfaEnable(userId: string, code: string, ip: string | null): Promise<Session> {
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, userId));
    if (!u.mfaSecretEnc) throw err.badRequest('MFA_NOT_SET_UP');
    if (!verifyTotp(decrypt(u.mfaSecretEnc, config().DATA_ENCRYPTION_KEY), code)) throw err.unauthorized('INVALID_MFA_CODE');
    const [updated] = await this.dbs.db.update(users).set({ mfaEnabled: true, updatedAt: new Date() }).where(eq(users.id, userId)).returning();
    await this.audit.log({ actorId: userId, actorRole: u.role, action: 'auth.mfa.enable', entityType: 'user', entityId: userId, ip });
    return this.issue(updated, true);
  }
}
