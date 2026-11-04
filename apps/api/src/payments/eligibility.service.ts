import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Database, DbService } from '../db/db.service';
import { paymentMethodEligibility } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { config } from '../config';
import { err } from '../common/errors';
import { PAYMENT_METHODS, PaymentDirection, PaymentMethod, PaymentProvider, ProviderMode } from './provider';
import { PaymentProviderRegistry } from './provider.registry';

type Row = typeof paymentMethodEligibility.$inferSelect;

export interface ResolvedRoute {
  provider: PaymentProvider;
  row: Row;
}

/**
 * A payment method is offered to a player only when, for (provider, method, country, mode):
 *  1. AthosBet eligibility, regulatory approval and gateway commercial approval are all recorded;
 *  2. the row is enabled (DB constraint forbids enabling without the three approvals);
 *  3. the provider is technically configured and supports the method/direction;
 *  4. for REAL mode: REAL_MONEY_ENABLED and a LICENSED jurisdiction (checked by ComplianceService).
 * Country-specific rows take precedence over the '*' wildcard; lower priority wins.
 */
@Injectable()
export class EligibilityService {
  constructor(private readonly dbs: DbService, private readonly registry: PaymentProviderRegistry, private readonly audit: AuditService) {}

  async seedDefaults() {
    const rows: (typeof paymentMethodEligibility.$inferInsert)[] = [];
    // internal simulator — AthosBet's own sandbox, no external processing
    for (const method of PAYMENT_METHODS) {
      rows.push({ provider: 'sandbox', method, country: '*', mode: 'SANDBOX', currency: 'ATH', priority: 1000, athosbetEligible: true, regulatoryApproved: true, gatewayApproved: true, enabled: true, minAmount: 100n, maxAmount: 1_000_000n, evidence: 'Internal simulator: fictitious money, no external processing' });
    }
    // Paysafe sandbox — seeded DISABLED: every approval must be recorded by an administrator
    const paysafe: [PaymentMethod, string, string][] = [
      ['PIX', 'BR', 'BRL'], ['BOLETO', 'BR', 'BRL'], ['CREDIT_CARD', '*', 'EUR'], ['DEBIT_CARD', '*', 'EUR'],
      ['BANK_TRANSFER', '*', 'EUR'], ['CRYPTO', '*', 'EUR'], ['CREDIT_CARD', 'BR', 'BRL'], ['DEBIT_CARD', 'BR', 'BRL'],
    ];
    for (const [method, country, currency] of paysafe) {
      rows.push({ provider: 'paysafe', method, country, mode: 'SANDBOX', currency, priority: 10, minAmount: 100n, maxAmount: 1_000_000n, evidence: null });
    }
    await this.dbs.db.insert(paymentMethodEligibility).values(rows).onConflictDoNothing();
  }

  private async rows(method: PaymentMethod, country: string, mode: ProviderMode, tx?: Database) {
    return (tx ?? this.dbs.db).select().from(paymentMethodEligibility)
      .where(and(eq(paymentMethodEligibility.method, method), eq(paymentMethodEligibility.mode, mode), inArray(paymentMethodEligibility.country, [country, '*'])))
      .orderBy(asc(paymentMethodEligibility.priority));
  }

  isOffered(r: Row, direction: PaymentDirection): boolean {
    const p = this.registry.get(r.provider);
    if (!p || !p.isConfigured() || !p.supports(r.method as PaymentMethod, direction) || p.mode !== r.mode) return false;
    if (r.mode === 'REAL' && !config().REAL_MONEY_ENABLED) return false;
    return r.enabled && r.athosbetEligible && r.regulatoryApproved && r.gatewayApproved && r.directions.includes(direction);
  }

  /** Best route for a new operation, or null if the method is not offered to this player. */
  async resolve(method: PaymentMethod, direction: PaymentDirection, country: string, mode: ProviderMode, tx?: Database): Promise<ResolvedRoute | null> {
    const rows = await this.rows(method, country, mode, tx);
    // country-specific first, then wildcard; within each, by priority
    rows.sort((a, b) => (a.country === '*' ? 1 : 0) - (b.country === '*' ? 1 : 0) || a.priority - b.priority);
    for (const row of rows) {
      if (this.isOffered(row, direction)) return { provider: this.registry.get(row.provider)!, row };
    }
    return null;
  }

  async offered(country: string, mode: ProviderMode) {
    const out = [];
    for (const method of PAYMENT_METHODS) {
      const dep = await this.resolve(method, 'DEPOSIT', country, mode);
      const wd = await this.resolve(method, 'WITHDRAWAL', country, mode);
      out.push({ method, deposit: !!dep, withdrawal: !!wd, provider: dep?.provider.name ?? wd?.provider.name ?? null, currency: dep?.row.currency ?? null, min: dep ? dep.row.minAmount.toString() : null, max: dep ? dep.row.maxAmount.toString() : null });
    }
    return out;
  }

  list() {
    return this.dbs.db.select().from(paymentMethodEligibility).orderBy(paymentMethodEligibility.provider, paymentMethodEligibility.method, paymentMethodEligibility.country);
  }

  async update(id: string, patch: Partial<Pick<Row, 'athosbetEligible' | 'regulatoryApproved' | 'gatewayApproved' | 'enabled' | 'priority' | 'evidence' | 'directions'>> & { minAmount?: bigint; maxAmount?: bigint }, actor: { id: string; role: string }, ip?: string | null) {
    const [before] = await this.dbs.db.select().from(paymentMethodEligibility).where(eq(paymentMethodEligibility.id, id));
    if (!before) throw err.notFound();
    const next = { ...before, ...patch };
    const approvals = next.athosbetEligible && next.regulatoryApproved && next.gatewayApproved;
    if (patch.enabled === true) {
      if (!approvals) throw err.unprocessable('APPROVALS_MISSING');
      if (!next.evidence?.trim()) throw err.unprocessable('EVIDENCE_REQUIRED');
      if (before.mode === 'REAL' && !config().REAL_MONEY_ENABLED) throw err.forbidden('REAL_MONEY_DISABLED');
    }
    // revoking any approval disables the method immediately
    const enabled = next.enabled && approvals;
    const [after] = await this.dbs.db.update(paymentMethodEligibility).set({ ...patch, enabled, updatedBy: actor.id, updatedAt: new Date() }).where(eq(paymentMethodEligibility.id, id)).returning();
    await this.audit.log({ actorId: actor.id, actorRole: actor.role, action: 'payments.eligibility.update', entityType: 'payment_method_eligibility', entityId: id, before, after, ip });
    return after;
  }
}
