import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { LOCALES, toMinor } from '@athosbet/shared';
import { AuthUser, Client, ClientInfo, CurrentUser } from '../common/auth';
import { ZodPipe } from '../common/zod';
import { ComplianceService, LIMIT_FIELDS, LimitField } from '../compliance/compliance.service';
import { DbService } from '../db/db.service';
import { users } from '../db/schema';
import { isValidTz } from '../common/time';
import { err } from '../common/errors';
import { toPublic } from '../auth/auth.service';

const ProfileSchema = z.object({ locale: z.enum(LOCALES).optional(), timezone: z.string().max(64).optional(), displayName: z.string().trim().min(2).max(40).optional() });
const LimitsSchema = z.object(Object.fromEntries(LIMIT_FIELDS.map((f) => [f, z.union([z.string(), z.number(), z.null()]).optional()])) as Record<LimitField, z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodNull]>>>);
const ExclusionSchema = z.object({ kind: z.enum(['COOL_OFF', 'SELF_EXCLUSION']), days: z.number().int().positive().nullable() });

const ser = (row: any) => row && JSON.parse(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

@ApiTags('account')
@Controller('account')
export class AccountController {
  constructor(private readonly dbs: DbService, private readonly compliance: ComplianceService) {}

  @Patch('profile')
  async profile(@CurrentUser() u: AuthUser, @Body(new ZodPipe(ProfileSchema)) b: z.infer<typeof ProfileSchema>) {
    if (b.timezone && !isValidTz(b.timezone)) throw err.badRequest('INVALID_TIMEZONE');
    // NB: changing the language never changes the jurisdiction (country) used for compliance.
    const [row] = await this.dbs.db.update(users).set({ ...b, updatedAt: new Date() }).where(eq(users.id, u.id)).returning();
    return toPublic(row);
  }

  @Get('limits')
  async limits(@CurrentUser() u: AuthUser) {
    return ser(await this.compliance.getLimits(u.id)) ?? {};
  }

  @Patch('limits')
  async setLimits(@CurrentUser() u: AuthUser, @Client() c: ClientInfo, @Body(new ZodPipe(LimitsSchema)) b: Record<string, string | number | null | undefined>) {
    const patch: Partial<Record<LimitField, bigint | null>> = {};
    for (const f of LIMIT_FIELDS) {
      if (b[f] === undefined) continue;
      if (b[f] === null) patch[f] = null;
      else {
        const v = toMinor(b[f] as any);
        if (v <= 0n) throw err.badRequest('INVALID_LIMIT');
        patch[f] = v;
      }
    }
    return ser(await this.compliance.setLimits(u.id, patch, c.ip));
  }

  @Get('exclusion')
  async exclusion(@CurrentUser() u: AuthUser) {
    return { active: await this.compliance.activeExclusion(u.id) };
  }

  @Post('exclusion')
  exclude(@CurrentUser() u: AuthUser, @Client() c: ClientInfo, @Body(new ZodPipe(ExclusionSchema)) b: z.infer<typeof ExclusionSchema>) {
    return this.compliance.selfExclude(u.id, b.kind, b.days, c.ip);
  }

  @Get('jurisdiction')
  async jurisdiction(@CurrentUser() u: AuthUser, @Client() c: ClientInfo) {
    const [row] = await this.dbs.db.select({ country: users.country }).from(users).where(eq(users.id, u.id));
    return { requestCountry: c.country, accountCountry: row.country, request: await this.compliance.jurisdictionStatus(c.country), account: await this.compliance.jurisdictionStatus(row.country), realMoneyAvailable: false };
  }
}
