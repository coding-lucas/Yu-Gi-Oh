import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { Database, DbService } from '../db/db.service';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../db/schema';
import { err } from '../common/errors';

export type AccountKind = 'USER_WALLET' | 'HOUSE_BETS_HELD' | 'HOUSE_PNL' | 'PAYMENT_CLEARING' | 'WITHDRAWALS_PENDING';
export type Mode = 'SANDBOX' | 'REAL';
export type LedgerTxType =
  | 'DEPOSIT' | 'WITHDRAWAL_REQUEST' | 'WITHDRAWAL_COMPLETE' | 'WITHDRAWAL_REVERSAL'
  | 'REFUND_REQUEST' | 'REFUND_COMPLETE' | 'REFUND_REVERSAL'
  | 'BET_PLACE' | 'BET_SETTLE' | 'BET_RESETTLE_REVERSAL' | 'ADJUSTMENT';

export interface PostEntry {
  accountId: string;
  amount: bigint;
  /** reject the transaction if this account would go below zero (player-initiated debits) */
  requireNonNegative?: boolean;
}

export interface PostInput {
  type: LedgerTxType;
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: string;
  reversesId?: string;
  metadata?: Record<string, unknown>;
  entries: PostEntry[];
}

/**
 * Double-entry ledger. Invariants (enforced both here and by database triggers):
 *  • every transaction has ≥2 entries whose amounts sum to exactly zero;
 *  • entries/transactions are append-only (corrections are reversing transactions);
 *  • an idempotency key can only ever produce one transaction;
 *  • account balances are updated under row locks taken in a deterministic order (no deadlocks).
 * Sign convention: a positive USER_WALLET balance is money owed to the player; PAYMENT_CLEARING
 * goes negative as external money enters; HOUSE_PNL positive is operator gross gaming revenue.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly dbs: DbService) {}

  async userAccount(tx: Database, userId: string, currency: string, mode: Mode) {
    await tx.insert(ledgerAccounts)
      .values({ code: `USER:${userId}:${currency}:${mode}`, kind: 'USER_WALLET', userId, currency, mode, balance: 0n })
      .onConflictDoNothing();
    const [a] = await tx.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.userId, userId), eq(ledgerAccounts.currency, currency), eq(ledgerAccounts.mode, mode)));
    return a;
  }

  async houseAccount(tx: Database, kind: Exclude<AccountKind, 'USER_WALLET'>, currency: string, mode: Mode) {
    const code = `${kind}:${currency}:${mode}`;
    await tx.insert(ledgerAccounts).values({ code, kind, currency, mode, balance: 0n }).onConflictDoNothing();
    const [a] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.code, code));
    return a;
  }

  /** Must be called inside a DB transaction. Returns duplicate=true if the idempotency key was already used. */
  async post(tx: Database, input: PostInput): Promise<{ id: string; duplicate: boolean }> {
    const entries = input.entries.filter((e) => e.amount !== 0n);
    if (entries.length < 2) throw new Error('ledger transaction needs at least two non-zero entries');
    const sum = entries.reduce((s, e) => s + e.amount, 0n);
    if (sum !== 0n) throw new Error(`ledger transaction unbalanced by ${sum}`);

    const inserted = await tx.insert(ledgerTransactions).values({
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      reversesId: input.reversesId,
      metadata: input.metadata ?? {},
    }).onConflictDoNothing({ target: ledgerTransactions.idempotencyKey }).returning({ id: ledgerTransactions.id });
    if (inserted.length === 0) {
      const [existing] = await tx.select({ id: ledgerTransactions.id }).from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, input.idempotencyKey));
      return { id: existing.id, duplicate: true };
    }
    const txId = inserted[0].id;

    // aggregate per account, lock in id order
    const byAccount = new Map<string, { amount: bigint; nonNeg: boolean }>();
    for (const e of entries) {
      const cur = byAccount.get(e.accountId) ?? { amount: 0n, nonNeg: false };
      cur.amount += e.amount;
      cur.nonNeg ||= !!e.requireNonNegative;
      byAccount.set(e.accountId, cur);
    }
    const ids = [...byAccount.keys()].sort();
    await tx.execute(sql`SELECT id FROM ledger_accounts WHERE id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) ORDER BY id FOR UPDATE`);
    for (const id of ids) {
      const { amount, nonNeg } = byAccount.get(id)!;
      if (amount === 0n) continue;
      const [row] = await tx.update(ledgerAccounts).set({ balance: sql`${ledgerAccounts.balance} + ${amount.toString()}::bigint` })
        .where(eq(ledgerAccounts.id, id)).returning({ balance: ledgerAccounts.balance });
      if (nonNeg && row.balance < 0n) throw err.unprocessable('INSUFFICIENT_FUNDS');
      await tx.insert(ledgerEntries).values({ transactionId: txId, accountId: id, amount, balanceAfter: row.balance });
    }
    return { id: txId, duplicate: false };
  }

  /** Posts the exact negation of a previous transaction. */
  async reverse(tx: Database, originalId: string, type: LedgerTxType, idempotencyKey: string, metadata: Record<string, unknown> = {}) {
    const rows = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, originalId));
    if (rows.length === 0) throw new Error(`transaction ${originalId} not found`);
    const byAccount = new Map<string, bigint>();
    for (const r of rows) byAccount.set(r.accountId, (byAccount.get(r.accountId) ?? 0n) + r.amount);
    return this.post(tx, {
      type,
      idempotencyKey,
      reversesId: originalId,
      metadata,
      entries: [...byAccount].map(([accountId, amount]) => ({ accountId, amount: -amount })),
    });
  }

  async balanceOf(userId: string, currency: string, mode: Mode): Promise<bigint> {
    const [a] = await this.dbs.db.select({ b: ledgerAccounts.balance }).from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.userId, userId), eq(ledgerAccounts.currency, currency), eq(ledgerAccounts.mode, mode)));
    return a?.b ?? 0n;
  }

  /**
   * Reconciliation: cached balances equal the sum of entries, every transaction nets to zero and the
   * books balance globally per currency/mode.
   */
  async reconcile() {
    const db = this.dbs.db;
    const mismatched = await db.execute(sql`
      SELECT a.id, a.code, a.balance, COALESCE(SUM(e.amount),0) AS computed
      FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
      GROUP BY a.id HAVING a.balance <> COALESCE(SUM(e.amount),0)`);
    const unbalanced = await db.execute(sql`SELECT transaction_id, SUM(amount) s FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount) <> 0`);
    const totals = await db.execute(sql`SELECT a.currency, a.mode, SUM(a.balance) AS total FROM ledger_accounts a GROUP BY a.currency, a.mode`);
    const brokenLastBalance = await db.execute(sql`
      SELECT a.id FROM ledger_accounts a
      JOIN LATERAL (SELECT balance_after FROM ledger_entries e WHERE e.account_id = a.id ORDER BY e.id DESC LIMIT 1) l ON true
      WHERE l.balance_after <> a.balance`);
    const ok = mismatched.rows.length === 0 && unbalanced.rows.length === 0 && totals.rows.every((r: any) => BigInt(r.total) === 0n) && brokenLastBalance.rows.length === 0;
    return {
      ok,
      checkedAt: new Date().toISOString(),
      accountMismatches: mismatched.rows,
      unbalancedTransactions: unbalanced.rows,
      totals: totals.rows.map((r: any) => ({ currency: r.currency, mode: r.mode, total: String(r.total) })),
      lastBalanceMismatches: brokenLastBalance.rows,
    };
  }
}
