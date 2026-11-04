import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import {
  acceptsPriceChange, combinedOddsK, DEMO_CURRENCY, OddsChangePolicy, potentialPayout, validateSlip,
} from '@athosbet/shared';
import { Database, DbService } from '../db/db.service';
import { bets, betSelections, competitions, markets, matches, odds, teams } from '../db/schema';
import { LedgerService } from '../ledger/ledger.service';
import { ComplianceService } from '../compliance/compliance.service';
import { SettingsService } from '../settings/settings.service';
import { err } from '../common/errors';
import { ClientInfo } from '../common/auth';
import { EventBus } from '../realtime/events';

export interface PlaceBetInput {
  legs: { oddsId: number; oddsK: number }[];
  stake: bigint; // minor units
  idempotencyKey: string;
  oddsPolicy: OddsChangePolicy;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function betCode() {
  const b = randomBytes(8);
  return 'AB-' + Array.from(b, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}

@Injectable()
export class BetsService {
  constructor(
    private readonly dbs: DbService,
    private readonly ledger: LedgerService,
    private readonly compliance: ComplianceService,
    private readonly settings: SettingsService,
    private readonly bus: EventBus,
  ) {}

  /**
   * Atomic bet acceptance: compliance gate, price confirmation, risk checks, stake debit and bet
   * creation happen in one database transaction. Prices are locked (FOR SHARE on markets) so the
   * odds cannot be re-published between confirmation and commit.
   */
  async place(userId: string, client: ClientInfo, input: PlaceBetInput) {
    const mode = 'SANDBOX' as const;
    const currency = DEMO_CURRENCY;
    const risk = await this.settings.get('risk');
    if (input.stake < BigInt(risk.minStake)) throw err.unprocessable('STAKE_BELOW_MINIMUM', { min: risk.minStake });
    if (input.stake > BigInt(risk.maxStake)) throw err.unprocessable('STAKE_ABOVE_MAXIMUM', { max: risk.maxStake });
    if (input.legs.length > risk.maxLegs) throw err.unprocessable('TOO_MANY_LEGS', { max: risk.maxLegs });
    if (new Set(input.legs.map((l) => l.oddsId)).size !== input.legs.length) throw err.unprocessable('DUPLICATE_SELECTION');

    const existing = await this.findByKey(userId, input.idempotencyKey);
    if (existing) return this.assertSameRequest(existing, input);

    try {
      const betId = await this.dbs.tx(async (tx) => {
        await this.compliance.assertCanPlay(tx, userId, client.country, mode, 'BET');
        await this.compliance.assertStakeWithinLimits(tx, userId, input.stake);

        const shown = await tx.select({ o: odds, mk: markets, m: matches, c: competitions }).from(odds)
          .innerJoin(markets, eq(markets.id, odds.marketId))
          .innerJoin(matches, eq(matches.id, markets.matchId))
          .innerJoin(competitions, eq(competitions.id, matches.competitionId))
          .where(inArray(odds.id, input.legs.map((l) => l.oddsId)));
        if (shown.length !== input.legs.length) throw err.unprocessable('SELECTION_NOT_FOUND');

        const slipErrors = validateSlip(shown.map((s) => ({ matchId: s.m.id, marketKey: s.mk.key, selection: s.o.selection })));
        if (slipErrors.length) throw err.unprocessable('INVALID_SLIP', slipErrors);

        // lock markets (shared) in id order, then serialise liability checks per market
        const marketIds = [...new Set(shown.map((s) => s.mk.id))].sort();
        const locked = await tx.select().from(markets).where(inArray(markets.id, marketIds)).orderBy(markets.id).for('share');
        for (const id of marketIds) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'mkt:' + id}))`);

        const current = await tx.select().from(odds).where(and(inArray(odds.marketId, marketIds), eq(odds.isCurrent, true)));
        const changes: { oddsId: number; shownK: number; currentK: number; currentOddsId: number }[] = [];
        const legs = input.legs.map((l) => {
          const s = shown.find((x) => x.o.id === l.oddsId)!;
          const mk = locked.find((x) => x.id === s.mk.id)!;
          const now = new Date();
          if (mk.status !== 'OPEN') throw err.unprocessable('MARKET_NOT_OPEN', { marketId: mk.id, status: mk.status });
          if (s.m.status !== 'SCHEDULED' || s.m.kickoffAt <= now) throw err.unprocessable('MATCH_NOT_OPEN', { matchId: s.m.id });
          if (!s.c.enabled || !s.c.bettingEnabled) throw err.unprocessable('COMPETITION_NOT_AVAILABLE');
          const cur = current.find((x) => x.marketId === mk.id && x.selection === s.o.selection);
          if (!cur) throw err.unprocessable('SELECTION_NOT_PRICED');
          if (cur.oddsK !== l.oddsK) changes.push({ oddsId: l.oddsId, shownK: l.oddsK, currentK: cur.oddsK, currentOddsId: cur.id });
          if (!acceptsPriceChange(input.oddsPolicy, l.oddsK, cur.oddsK)) return null;
          return { s, mk, cur };
        });
        if (legs.some((x) => x === null)) throw err.conflict('ODDS_CHANGED', { changes });

        const accepted = legs as NonNullable<(typeof legs)[number]>[];
        const ks = accepted.map((x) => x.cur.oddsK);
        const combined = combinedOddsK(ks);
        const payout = potentialPayout(input.stake, ks);
        if (payout > BigInt(risk.maxPayout)) throw err.unprocessable('MAX_PAYOUT_EXCEEDED', { max: risk.maxPayout });

        // house exposure per selection (worst case: every open bet containing it wins)
        for (const x of accepted) {
          const r = await tx.execute(sql`
            SELECT COALESCE(SUM(b.potential_payout),0)::bigint AS liability FROM bet_selections bs JOIN bets b ON b.id = bs.bet_id
            WHERE bs.market_id = ${x.mk.id} AND bs.selection = ${x.cur.selection} AND b.status = 'OPEN'`);
          const liability = BigInt((r.rows[0] as any).liability);
          if (liability + payout > BigInt(risk.maxLiabilityPerSelection)) throw err.unprocessable('LIABILITY_LIMIT_REACHED', { marketId: x.mk.id, selection: x.cur.selection });
        }

        const [bet] = await tx.insert(bets).values({
          code: betCode(), userId, type: accepted.length === 1 ? 'SINGLE' : 'MULTIPLE', stake: input.stake, currency, mode,
          combinedOddsK: combined, potentialPayout: payout, status: 'OPEN', idempotencyKey: input.idempotencyKey,
          oddsPolicy: input.oddsPolicy, country: client.country === 'XX' ? null : client.country, ip: client.ip,
        }).returning();
        await tx.insert(betSelections).values(accepted.map((x) => ({
          betId: bet.id, matchId: x.s.m.id, marketId: x.mk.id, oddsId: x.cur.id, marketKey: x.mk.key, selection: x.cur.selection, oddsK: x.cur.oddsK,
        })));

        const wallet = await this.ledger.userAccount(tx, userId, currency, mode);
        const held = await this.ledger.houseAccount(tx, 'HOUSE_BETS_HELD', currency, mode);
        await this.ledger.post(tx, {
          type: 'BET_PLACE', idempotencyKey: `bet:${bet.id}:place`, referenceType: 'bet', referenceId: bet.id,
          entries: [{ accountId: wallet.id, amount: -input.stake, requireNonNegative: true }, { accountId: held.id, amount: input.stake }],
        });
        return bet.id;
      });
      this.bus.emit({ type: 'wallet.updated', userId });
      return this.get(userId, betId);
    } catch (e: any) {
      // concurrent duplicate submission with the same idempotency key
      if (e?.code === '23505' && String(e?.constraint ?? '').includes('idempotency')) {
        const again = await this.findByKey(userId, input.idempotencyKey);
        if (again) return this.assertSameRequest(again, input);
      }
      throw e;
    }
  }

  private async findByKey(userId: string, key: string) {
    const [b] = await this.dbs.db.select({ id: bets.id }).from(bets).where(and(eq(bets.userId, userId), eq(bets.idempotencyKey, key)));
    return b ? this.get(userId, b.id) : null;
  }

  private assertSameRequest(existing: Awaited<ReturnType<BetsService['get']>>, input: PlaceBetInput) {
    if (BigInt(existing.stake) !== input.stake || existing.legs.length !== input.legs.length) throw err.conflict('IDEMPOTENCY_KEY_REUSED');
    return { ...existing, idempotentReplay: true };
  }

  async get(userId: string | null, betId: string, tx?: Database) {
    const db = tx ?? this.dbs.db;
    const [b] = await db.select().from(bets).where(userId ? and(eq(bets.id, betId), eq(bets.userId, userId)) : eq(bets.id, betId));
    if (!b) throw err.notFound('BET_NOT_FOUND');
    const legs = await db.select({ s: betSelections, m: matches }).from(betSelections).innerJoin(matches, eq(matches.id, betSelections.matchId)).where(eq(betSelections.betId, b.id));
    const teamIds = [...new Set(legs.flatMap((l) => [l.m.homeTeamId, l.m.awayTeamId]))];
    const tm = teamIds.length ? await db.select().from(teams).where(inArray(teams.id, teamIds)) : [];
    const name = (id: string) => tm.find((t) => t.id === id)?.name ?? '?';
    return {
      id: b.id, code: b.code, type: b.type, status: b.status, stake: b.stake.toString(), currency: b.currency, mode: b.mode,
      combinedOdds: Number(b.combinedOddsK) / 1000, potentialPayout: b.potentialPayout.toString(), payout: b.payout?.toString() ?? null,
      placedAt: b.placedAt, settledAt: b.settledAt, settlementVersion: b.settlementVersion,
      legs: legs.map(({ s, m }) => ({
        id: s.id, matchId: m.id, home: name(m.homeTeamId), away: name(m.awayTeamId), kickoffAt: m.kickoffAt, matchStatus: m.status,
        score: m.homeGoals === null ? null : `${m.homeGoals}-${m.awayGoals}`, marketKey: s.marketKey, selection: s.selection, odds: s.oddsK / 1000, result: s.result, voidReason: s.voidReason,
      })),
    };
  }

  async list(userId: string, status?: 'OPEN' | 'SETTLED', limit = 50) {
    const where = [eq(bets.userId, userId)];
    if (status === 'OPEN') where.push(eq(bets.status, 'OPEN'));
    if (status === 'SETTLED') where.push(inArray(bets.status, ['WON', 'LOST', 'VOID']));
    const rows = await this.dbs.db.select({ id: bets.id }).from(bets).where(and(...where)).orderBy(desc(bets.placedAt)).limit(Math.min(limit, 200));
    return Promise.all(rows.map((r) => this.get(userId, r.id)));
  }

  async oddsHistory(marketId: string) {
    return this.dbs.db.select({ selection: odds.selection, odds: odds.oddsK, version: odds.version, at: odds.createdAt }).from(odds).where(eq(odds.marketId, marketId)).orderBy(odds.selection, odds.version);
  }
}
