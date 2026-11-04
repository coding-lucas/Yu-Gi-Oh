import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { MatchOutcome, parseMarketKey, settleBet, settleSelection, SelectionResult } from '@athosbet/shared';
import { Database, DbService } from '../db/db.service';
import { bets, betSelections, markets, matches, settlements } from '../db/schema';
import { LedgerService } from '../ledger/ledger.service';
import { EventBus } from '../realtime/events';
import { POSTPONEMENT_WINDOW_MS } from '../sports/sync.service';

type MatchRow = typeof matches.$inferSelect;

/**
 * Determines whether a match can be settled and how.
 *  FINISHED with score              → RESULT
 *  CANCELLED / ABANDONED            → VOID
 *  POSTPONED > 48h after kick-off   → VOID (rule GENERAL)
 *  re-scheduled > 48h from original → VOID (bets struck before the move)
 */
export function matchOutcome(m: MatchRow, now = new Date()): { outcome: MatchOutcome; reason?: string } | null {
  if (m.status === 'FINISHED' && m.homeGoals !== null && m.awayGoals !== null) return { outcome: { kind: 'RESULT', homeGoals: m.homeGoals, awayGoals: m.awayGoals } };
  if (m.status === 'CANCELLED' || m.status === 'ABANDONED') return { outcome: { kind: 'VOID' }, reason: m.status };
  if (m.status === 'POSTPONED' && now.getTime() - m.originalKickoffAt.getTime() > POSTPONEMENT_WINDOW_MS) return { outcome: { kind: 'VOID' }, reason: 'POSTPONED' };
  if (Math.abs(m.kickoffAt.getTime() - m.originalKickoffAt.getTime()) > POSTPONEMENT_WINDOW_MS) return { outcome: { kind: 'VOID' }, reason: 'RESCHEDULED' };
  return null;
}

export interface SettlementReport {
  matchId: string;
  legsSettled: number;
  betsSettled: number;
  betsResettled: number;
}

@Injectable()
export class SettlementService {
  private readonly log = new Logger(SettlementService.name);
  constructor(private readonly dbs: DbService, private readonly ledger: LedgerService, private readonly bus: EventBus) {}

  /**
   * Settles (or re-settles) every bet touching a match. Idempotent: running it twice for the same
   * match result version is a no-op; a corrected result re-settles via reversing ledger entries.
   */
  async settleMatch(matchId: string): Promise<SettlementReport> {
    const report: SettlementReport = { matchId, legsSettled: 0, betsSettled: 0, betsResettled: 0 };
    const settled: { betId: string; userId: string; status: string }[] = [];
    await this.dbs.tx(async (tx) => {
      const [m] = await tx.select().from(matches).where(eq(matches.id, matchId)).for('update');
      if (!m) return;
      const decision = matchOutcome(m);
      if (!decision) return;
      const rescheduled = decision.reason === 'RESCHEDULED';

      // 1. markets first (consistent lock order with bet placement: markets → accounts)
      const mks = await tx.select().from(markets).where(eq(markets.matchId, m.id)).orderBy(markets.id).for('update');
      if (!rescheduled) {
        for (const mk of mks) {
          await tx.update(markets).set({ status: decision.outcome.kind === 'VOID' ? 'VOID' : 'SETTLED', settledResultVersion: m.resultVersion, updatedAt: new Date() }).where(eq(markets.id, mk.id));
        }
      }

      // 2. legs that need (re)evaluation for this result version
      const legs = await tx.select().from(betSelections).where(and(
        eq(betSelections.matchId, m.id),
        isNull(betSelections.voidReason),
        or(eq(betSelections.result, 'PENDING'), rescheduled ? sql`false` : lt(sql`COALESCE(${betSelections.resultVersion}, -1)`, m.resultVersion)),
      ));
      if (legs.length === 0) return;
      const betIds = [...new Set(legs.map((l) => l.betId))].sort();
      const lockedBets = await tx.select().from(bets).where(inArray(bets.id, betIds)).orderBy(bets.id).for('update');

      for (const leg of legs) {
        const { type, line } = parseMarketKey(leg.marketKey);
        const result: SelectionResult = settleSelection(type, line, leg.selection, decision.outcome);
        await tx.update(betSelections).set({
          result, resultVersion: m.resultVersion, voidReason: rescheduled ? 'RESCHEDULED' : decision.outcome.kind === 'VOID' ? decision.reason ?? 'VOID' : null,
        }).where(eq(betSelections.id, leg.id));
        report.legsSettled++;
      }

      for (const b of lockedBets) {
        const out = await this.settleBetIfComplete(tx, b);
        if (out === 'SETTLED') report.betsSettled++;
        if (out === 'RESETTLED') report.betsResettled++;
        if (out) settled.push({ betId: b.id, userId: b.userId, status: out });
      }

      if (rescheduled) {
        // the fixture becomes a new edition: suspended markets will be re-priced for new bets
        await tx.update(matches).set({ originalKickoffAt: m.kickoffAt, updatedAt: new Date() }).where(eq(matches.id, m.id));
        await tx.update(markets).set({ status: 'SUSPENDED', suspensionReason: 'RESCHEDULED', updatedAt: new Date() }).where(and(eq(markets.matchId, m.id), inArray(markets.status, ['OPEN', 'CLOSED'])));
      }
    });
    for (const s of settled) {
      this.bus.emit({ type: 'bet.settled', betId: s.betId, userId: s.userId, status: s.status });
      this.bus.emit({ type: 'wallet.updated', userId: s.userId });
    }
    return report;
  }

  private async settleBetIfComplete(tx: Database, b: typeof bets.$inferSelect): Promise<'SETTLED' | 'RESETTLED' | null> {
    const legs = await tx.select().from(betSelections).where(eq(betSelections.betId, b.id));
    if (legs.some((l) => l.result === 'PENDING')) return null;
    const { result, payoutMinor } = settleBet(b.stake, legs.map((l) => ({ oddsK: l.oddsK, result: l.result as SelectionResult })));
    const versions = Object.fromEntries(legs.map((l) => [l.matchId, l.resultVersion]));
    const wallet = await this.ledger.userAccount(tx, b.userId, b.currency, b.mode);
    const held = await this.ledger.houseAccount(tx, 'HOUSE_BETS_HELD', b.currency, b.mode);
    const pnl = await this.ledger.houseAccount(tx, 'HOUSE_PNL', b.currency, b.mode);

    if (b.status !== 'OPEN') {
      if (b.status === result && b.payout === payoutMinor) return null; // correction did not change the outcome
      const [prev] = await tx.select().from(settlements).where(and(eq(settlements.betId, b.id), eq(settlements.version, b.settlementVersion)));
      const next = b.settlementVersion + 1;
      const rev = await this.ledger.reverse(tx, prev.ledgerTxId!, 'BET_RESETTLE_REVERSAL', `bet:${b.id}:reverse:v${prev.version}`, { betId: b.id, version: prev.version });
      const tId = await this.postSettlement(tx, b, payoutMinor, next, wallet.id, held.id, pnl.id);
      await tx.insert(settlements).values({ betId: b.id, version: next, result, payout: payoutMinor, ledgerTxId: tId, reversalTxId: rev.id, reason: 'RESULT_CORRECTION', matchVersions: versions });
      await tx.update(bets).set({ status: result, payout: payoutMinor, settlementVersion: next, settledAt: new Date() }).where(eq(bets.id, b.id));
      this.log.log(`bet ${b.code} re-settled ${b.status}->${result}`);
      return 'RESETTLED';
    }
    const tId = await this.postSettlement(tx, b, payoutMinor, 1, wallet.id, held.id, pnl.id);
    await tx.insert(settlements).values({ betId: b.id, version: 1, result, payout: payoutMinor, ledgerTxId: tId, reason: 'INITIAL', matchVersions: versions });
    await tx.update(bets).set({ status: result, payout: payoutMinor, settlementVersion: 1, settledAt: new Date() }).where(eq(bets.id, b.id));
    return 'SETTLED';
  }

  /**
   * Settlement entries: the held stake is released; the player receives the payout; the difference is
   * booked to house P&L (positive when the player loses).
   */
  private async postSettlement(tx: Database, b: typeof bets.$inferSelect, payout: bigint, version: number, walletId: string, heldId: string, pnlId: string) {
    const r = await this.ledger.post(tx, {
      type: 'BET_SETTLE', idempotencyKey: `bet:${b.id}:settle:v${version}`, referenceType: 'bet', referenceId: b.id,
      metadata: { version, payout: payout.toString() },
      entries: [
        { accountId: heldId, amount: -b.stake },
        { accountId: walletId, amount: payout },
        { accountId: pnlId, amount: b.stake - payout },
      ],
    });
    return r.id;
  }

  /** Finds matches that have unsettled bet legs and an available outcome. */
  async pendingMatches(): Promise<string[]> {
    const r = await this.dbs.db.execute(sql`
      SELECT DISTINCT m.id FROM matches m JOIN bet_selections bs ON bs.match_id = m.id
      WHERE (bs.result = 'PENDING' AND (m.status IN ('FINISHED','CANCELLED','ABANDONED','POSTPONED') OR abs(extract(epoch FROM m.kickoff_at - m.original_kickoff_at)) > 172800))
         OR (bs.result <> 'PENDING' AND bs.void_reason IS NULL AND COALESCE(bs.result_version,-1) < m.result_version)`);
    return (r.rows as any[]).map((x) => x.id);
  }

  async settlePending() {
    const out: SettlementReport[] = [];
    for (const id of await this.pendingMatches()) out.push(await this.settleMatch(id));
    return out;
  }
}
