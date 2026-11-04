import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DEFAULT_PRICING_CONFIG, PricingConfig } from '@athosbet/odds-engine';
import { DbService } from '../db/db.service';
import { settings } from '../db/schema';
import { AuditService } from '../audit/audit.service';

export interface RiskSettings {
  minStake: number; // minor units
  maxStake: number;
  maxPayout: number; // per bet
  maxLiabilityPerSelection: number; // house exposure cap per market selection
  maxLegs: number;
  largeWithdrawalReview: number; // withdrawals above this need manual review
  largeDepositFlag: number; // AML flag threshold
}

export const DEFAULT_RISK: RiskSettings = {
  minStake: 100,
  maxStake: 500_000,
  maxPayout: 10_000_000,
  maxLiabilityPerSelection: 20_000_000,
  maxLegs: 12,
  largeWithdrawalReview: 1_000_000,
  largeDepositFlag: 1_000_000,
};

export interface Defaults {
  pricing: PricingConfig;
  risk: RiskSettings;
}

const DEFAULTS: Defaults = { pricing: DEFAULT_PRICING_CONFIG, risk: DEFAULT_RISK };

@Injectable()
export class SettingsService {
  private cache = new Map<string, { v: unknown; at: number }>();
  constructor(private readonly dbs: DbService, private readonly audit: AuditService) {}

  async get<K extends keyof Defaults>(key: K): Promise<Defaults[K]> {
    const c = this.cache.get(key);
    if (c && Date.now() - c.at < 5_000) return c.v as Defaults[K];
    const [row] = await this.dbs.db.select().from(settings).where(eq(settings.key, key));
    const v = { ...DEFAULTS[key], ...((row?.value as object) ?? {}) } as Defaults[K];
    if (key === 'pricing') (v as PricingConfig).margins = { ...DEFAULT_PRICING_CONFIG.margins, ...((row?.value as any)?.margins ?? {}) };
    this.cache.set(key, { v, at: Date.now() });
    return v;
  }

  async set<K extends keyof Defaults>(key: K, patch: Partial<Defaults[K]>, actor: { id: string; role: string }, ip?: string | null) {
    const before = await this.get(key);
    const after = { ...before, ...patch } as Defaults[K];
    if (key === 'pricing' && (patch as any).margins) (after as any).margins = { ...(before as any).margins, ...(patch as any).margins };
    await this.dbs.db.insert(settings).values({ key, value: after as object, updatedBy: actor.id })
      .onConflictDoUpdate({ target: settings.key, set: { value: after as object, updatedBy: actor.id, updatedAt: new Date() } });
    this.cache.delete(key);
    await this.audit.log({ actorId: actor.id, actorRole: actor.role, action: `settings.${key}.update`, entityType: 'settings', entityId: key, before, after, ip });
    return after;
  }

  clearCache() {
    this.cache.clear();
  }
}
