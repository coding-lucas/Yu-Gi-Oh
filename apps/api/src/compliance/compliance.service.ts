import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, isNull, or, sql, gt } from 'drizzle-orm';
import {
  ageInYears, DEFAULT_JURISDICTION_STATUS, DEFAULT_JURISDICTIONS, gateBetting, JurisdictionStatus, WalletMode,
} from '@athosbet/shared';
import { Database, DbService } from '../db/db.service';
import { jurisdictions, rgLimits, selfExclusions, suspiciousActivities, users } from '../db/schema';
import { config } from '../config';
import { err } from '../common/errors';
import { AuditService } from '../audit/audit.service';

export const LIMIT_FIELDS = ['depositDaily', 'depositWeekly', 'depositMonthly', 'lossDaily', 'lossWeekly', 'lossMonthly', 'maxStake'] as const;
export type LimitField = (typeof LIMIT_FIELDS)[number];
export const LIMIT_COOLING_HOURS = 24;

const WINDOWS: Record<'Daily' | 'Weekly' | 'Monthly', string> = { Daily: '1 day', Weekly: '7 days', Monthly: '30 days' };

@Injectable()
export class ComplianceService {
  constructor(private readonly dbs: DbService, private readonly audit: AuditService) {}

  async jurisdictionStatus(country: string, tx?: Database): Promise<JurisdictionStatus> {
    const [row] = await (tx ?? this.dbs.db).select().from(jurisdictions).where(eq(jurisdictions.country, country.toUpperCase()));
    return row?.status ?? DEFAULT_JURISDICTION_STATUS;
  }

  async seedJurisdictions() {
    for (const j of DEFAULT_JURISDICTIONS) {
      await this.dbs.db.insert(jurisdictions).values({ country: j.country, status: j.status, note: j.note }).onConflictDoNothing();
    }
  }

  async activeExclusion(userId: string, tx?: Database) {
    const now = new Date();
    const [row] = await (tx ?? this.dbs.db).select().from(selfExclusions)
      .where(and(eq(selfExclusions.userId, userId), sql`${selfExclusions.startsAt} <= now()`, or(isNull(selfExclusions.endsAt), gt(selfExclusions.endsAt, now))))
      .orderBy(desc(selfExclusions.endsAt)).limit(1);
    return row ?? null;
  }

  /**
   * Gate applied to every bet, deposit and withdrawal request. Territory comes from the verified
   * request country; account country (KYC/registration) is also checked — the stricter wins.
   */
  async assertCanPlay(tx: Database, userId: string, requestCountry: string, mode: WalletMode, action: 'BET' | 'DEPOSIT' | 'WITHDRAW') {
    const [u] = await tx.select().from(users).where(eq(users.id, userId));
    if (!u) throw err.unauthorized();
    if (u.status !== 'ACTIVE') throw err.forbidden('ACCOUNT_NOT_ACTIVE');
    const statuses = await Promise.all([this.jurisdictionStatus(requestCountry, tx), this.jurisdictionStatus(u.country, tx)]);
    const rank = { BLOCKED: 0, SANDBOX_ONLY: 1, LICENSED: 2 } as const;
    const jurisdiction = statuses.sort((a, b) => rank[a] - rank[b])[0];
    const exclusion = await this.activeExclusion(userId, tx);
    const denial = gateBetting({
      mode,
      realMoneyEnabled: config().REAL_MONEY_ENABLED,
      jurisdiction,
      kycVerified: u.kycStatus === 'VERIFIED',
      selfExcludedUntil: exclusion ? exclusion.endsAt ?? new Date(8.64e15) : null,
      now: new Date(),
      ageYears: ageInYears(new Date(u.dateOfBirth), new Date()),
    });
    // withdrawals of existing balances remain possible while self-excluded
    if (denial && !(action === 'WITHDRAW' && denial === 'SELF_EXCLUDED')) throw err.forbidden(denial);
    return u;
  }

  // ── responsible gambling limits ──
  async getLimits(userId: string, tx?: Database) {
    await this.applyPending(userId, tx);
    const [row] = await (tx ?? this.dbs.db).select().from(rgLimits).where(eq(rgLimits.userId, userId));
    return row ?? null;
  }

  /**
   * Decreasing a limit is immediate. Increasing or removing a limit only takes effect after a
   * cooling-off period, so that limits cannot be lifted impulsively.
   */
  async setLimits(userId: string, patch: Partial<Record<LimitField, bigint | null>>, ip?: string | null) {
    return this.dbs.tx(async (tx) => {
      await tx.insert(rgLimits).values({ userId }).onConflictDoNothing();
      const [cur] = await tx.select().from(rgLimits).where(eq(rgLimits.userId, userId)).for('update');
      const immediate: Partial<Record<LimitField, bigint | null>> = {};
      const pending: Record<string, string | null> = { ...(cur.pending ?? {}) };
      for (const f of LIMIT_FIELDS) {
        if (!(f in patch)) continue;
        const next = patch[f] ?? null;
        const now = cur[f] as bigint | null;
        const stricter = next !== null && (now === null || next <= now);
        if (stricter) {
          immediate[f] = next;
          delete pending[f];
        } else {
          pending[f] = next === null ? null : next.toString();
        }
      }
      const hasPending = Object.keys(pending).length > 0;
      await tx.update(rgLimits).set({
        ...immediate,
        pending: hasPending ? pending : null,
        pendingEffectiveAt: hasPending ? new Date(Date.now() + LIMIT_COOLING_HOURS * 3600_000) : null,
        updatedAt: new Date(),
      }).where(eq(rgLimits.userId, userId));
      await this.audit.log({ actorId: userId, actorRole: 'USER', action: 'rg.limits.update', entityType: 'user', entityId: userId, before: cur, after: { immediate, pending }, ip }, tx);
      const [row] = await tx.select().from(rgLimits).where(eq(rgLimits.userId, userId));
      return row;
    });
  }

  private async applyPending(userId: string, tx?: Database) {
    const db = tx ?? this.dbs.db;
    const [cur] = await db.select().from(rgLimits).where(eq(rgLimits.userId, userId));
    if (!cur?.pending || !cur.pendingEffectiveAt || cur.pendingEffectiveAt > new Date()) return;
    const upd: Record<string, bigint | null> = {};
    for (const [k, v] of Object.entries(cur.pending)) upd[k] = v === null ? null : BigInt(v);
    await db.update(rgLimits).set({ ...upd, pending: null, pendingEffectiveAt: null, updatedAt: new Date() }).where(eq(rgLimits.userId, userId));
  }

  /** Deposit limits: sum of completed + pending deposits in rolling windows. */
  async assertDepositWithinLimits(tx: Database, userId: string, amount: bigint) {
    const l = await this.getLimits(userId, tx);
    if (!l) return;
    for (const w of ['Daily', 'Weekly', 'Monthly'] as const) {
      const limit = l[`deposit${w}`] as bigint | null;
      if (limit === null) continue;
      const r = await tx.execute(sql`SELECT COALESCE(SUM(amount),0)::bigint s FROM payments WHERE user_id = ${userId} AND direction='DEPOSIT' AND status IN ('PENDING','COMPLETED','REQUIRES_REVIEW') AND created_at > now() - ${WINDOWS[w]}::interval`);
      const used = BigInt((r.rows[0] as any).s);
      if (used + amount > limit) throw err.forbidden('DEPOSIT_LIMIT_EXCEEDED', { window: w, limit: limit.toString(), used: used.toString() });
    }
  }

  /**
   * Loss limits: net loss in the window = stakes placed − payouts received (settled bets) and the
   * new stake is counted as a potential loss.
   */
  async assertStakeWithinLimits(tx: Database, userId: string, stake: bigint) {
    const l = await this.getLimits(userId, tx);
    if (!l) return;
    if (l.maxStake !== null && stake > l.maxStake) throw err.forbidden('STAKE_LIMIT_EXCEEDED', { limit: l.maxStake.toString() });
    for (const w of ['Daily', 'Weekly', 'Monthly'] as const) {
      const limit = l[`loss${w}`] as bigint | null;
      if (limit === null) continue;
      const r = await tx.execute(sql`SELECT COALESCE(SUM(stake - COALESCE(payout,0)),0)::bigint s FROM bets WHERE user_id = ${userId} AND placed_at > now() - ${WINDOWS[w]}::interval`);
      const net = BigInt((r.rows[0] as any).s);
      if (net + stake > limit) throw err.forbidden('LOSS_LIMIT_EXCEEDED', { window: w, limit: limit.toString(), current: net.toString() });
    }
  }

  async selfExclude(userId: string, kind: 'COOL_OFF' | 'SELF_EXCLUSION', days: number | null, ip?: string | null) {
    if (kind === 'COOL_OFF' && (days === null || days < 1 || days > 42)) throw err.badRequest('INVALID_PERIOD');
    if (kind === 'SELF_EXCLUSION' && days !== null && days < 180) throw err.badRequest('INVALID_PERIOD');
    const endsAt = days === null ? null : new Date(Date.now() + days * 86_400_000);
    const [row] = await this.dbs.db.insert(selfExclusions).values({ userId, kind, endsAt }).returning();
    await this.audit.log({ actorId: userId, actorRole: 'USER', action: `rg.${kind.toLowerCase()}`, entityType: 'user', entityId: userId, after: row, ip });
    return row;
  }

  async flag(userId: string | null, kind: string, severity: 'LOW' | 'MEDIUM' | 'HIGH', details: Record<string, unknown>, tx?: Database) {
    await (tx ?? this.dbs.db).insert(suspiciousActivities).values({ userId, kind, severity, details: JSON.parse(JSON.stringify(details, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) });
  }

  /** AML heuristics evaluated after money movements. */
  async amlChecks(tx: Database, userId: string, event: 'DEPOSIT' | 'WITHDRAWAL', amount: bigint, largeThreshold: number) {
    if (amount >= BigInt(largeThreshold)) await this.flag(userId, `LARGE_${event}`, 'MEDIUM', { amount }, tx);
    if (event === 'WITHDRAWAL') {
      // deposit → withdraw with little or no betting in between (possible laundering)
      const r = await tx.execute(sql`
        SELECT (SELECT COALESCE(SUM(amount),0) FROM payments WHERE user_id=${userId} AND direction='DEPOSIT' AND status='COMPLETED' AND created_at > now() - interval '7 days')::bigint dep,
               (SELECT COALESCE(SUM(stake),0) FROM bets WHERE user_id=${userId} AND placed_at > now() - interval '7 days')::bigint staked`);
      const { dep, staked } = r.rows[0] as any;
      if (BigInt(dep) > 0n && BigInt(staked) * 2n < BigInt(dep)) await this.flag(userId, 'LOW_TURNOVER_WITHDRAWAL', 'HIGH', { deposits7d: dep, staked7d: staked, amount }, tx);
    }
    const r2 = await tx.execute(sql`SELECT COUNT(*)::int n FROM payments WHERE user_id=${userId} AND direction='DEPOSIT' AND created_at > now() - interval '1 hour'`);
    if ((r2.rows[0] as any).n >= 10) await this.flag(userId, 'DEPOSIT_VELOCITY', 'MEDIUM', { lastHour: (r2.rows[0] as any).n }, tx);
  }

  async listSuspicious(status?: string) {
    return this.dbs.db.select().from(suspiciousActivities).where(status ? eq(suspiciousActivities.status, status as any) : undefined).orderBy(desc(suspiciousActivities.createdAt)).limit(200);
  }

  async recentFailedLogins(since: Date) {
    return this.dbs.db.select().from(users).where(and(gte(users.failedLogins, 5), gte(users.updatedAt, since)));
  }
}
