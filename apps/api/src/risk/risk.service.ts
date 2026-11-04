import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';

const rows = (r: { rows: unknown[] }) => r.rows as any[];

@Injectable()
export class RiskService {
  constructor(private readonly dbs: DbService) {}

  /** Worst-case house liability by outcome: Σ potential payouts of open bets containing the selection. */
  async exposure(limit = 50) {
    return rows(await this.dbs.db.execute(sql`
      SELECT bs.match_id, bs.market_id, bs.market_key, bs.selection, ht.name AS home, at.name AS away, m.kickoff_at,
             COUNT(*)::int AS open_bets,
             SUM(CASE WHEN b.type='SINGLE' THEN b.stake ELSE 0 END)::text AS single_stakes,
             SUM(b.potential_payout)::text AS liability
      FROM bet_selections bs JOIN bets b ON b.id = bs.bet_id AND b.status = 'OPEN'
      JOIN matches m ON m.id = bs.match_id JOIN teams ht ON ht.id = m.home_team_id JOIN teams at ON at.id = m.away_team_id
      WHERE bs.result = 'PENDING'
      GROUP BY bs.match_id, bs.market_id, bs.market_key, bs.selection, ht.name, at.name, m.kickoff_at
      ORDER BY SUM(b.potential_payout) DESC LIMIT ${limit}`));
  }

  async kpis() {
    const one = async (q: ReturnType<typeof sql>) => rows(await this.dbs.db.execute(q))[0];
    const [users, bets, money, markets, matches, payments, sync, pnl] = await Promise.all([
      one(sql`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE created_at > now() - interval '1 day')::int new24h, COUNT(*) FILTER (WHERE role <> 'USER')::int staff FROM users`),
      one(sql`SELECT COUNT(*) FILTER (WHERE status='OPEN')::int open, COUNT(*) FILTER (WHERE status<>'OPEN')::int settled,
                 COALESCE(SUM(stake) FILTER (WHERE status='OPEN'),0)::text open_stake,
                 COALESCE(SUM(potential_payout) FILTER (WHERE status='OPEN'),0)::text open_liability,
                 COUNT(*) FILTER (WHERE placed_at > now() - interval '1 day')::int bets24h FROM bets`),
      one(sql`SELECT COALESCE(SUM(stake),0)::text volume,
                 COALESCE(SUM(stake) FILTER (WHERE placed_at > now() - interval '1 day'),0)::text volume24h,
                 COALESCE(SUM(stake) FILTER (WHERE placed_at > now() - interval '7 days'),0)::text volume7d,
                 COALESCE(SUM(payout) FILTER (WHERE status<>'OPEN'),0)::text payouts,
                 COALESCE(SUM(stake - payout) FILTER (WHERE status<>'OPEN'),0)::text ggr,
                 COALESCE(SUM(stake) FILTER (WHERE status<>'OPEN'),0)::text settled_stake FROM bets`),
      one(sql`SELECT COUNT(*) FILTER (WHERE status='OPEN')::int open, COUNT(*) FILTER (WHERE status='SUSPENDED')::int suspended,
                 COUNT(*) FILTER (WHERE status='CLOSED')::int closed, COUNT(*) FILTER (WHERE status IN ('SETTLED','VOID'))::int settled,
                 (SELECT COUNT(*) FROM odds WHERE is_current)::int current_prices FROM markets`),
      one(sql`SELECT COUNT(*) FILTER (WHERE status='SCHEDULED' AND kickoff_at > now() AND kickoff_at < now() + interval '7 days')::int upcoming7d,
                 COUNT(*) FILTER (WHERE status='LIVE')::int live, COUNT(*) FILTER (WHERE status IN ('POSTPONED','CANCELLED','ABANDONED') AND kickoff_at > now() - interval '7 days')::int disrupted FROM matches`),
      one(sql`SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DEPOSIT' AND status='COMPLETED'),0)::text deposits,
                 COALESCE(SUM(amount) FILTER (WHERE direction='WITHDRAWAL' AND status='COMPLETED'),0)::text withdrawals,
                 COUNT(*) FILTER (WHERE status='REQUIRES_REVIEW')::int pending_review, COUNT(*) FILTER (WHERE status='FAILED')::int failed FROM payments`),
      one(sql`SELECT COUNT(*) FILTER (WHERE status IN ('FAILED','PARTIAL') AND started_at > now() - interval '1 day')::int errors24h,
                 MAX(finished_at) FILTER (WHERE status='SUCCESS') last_success FROM provider_sync_runs`),
      one(sql`SELECT COALESCE(SUM(balance) FILTER (WHERE kind='HOUSE_PNL'),0)::text house_pnl, COALESCE(SUM(balance) FILTER (WHERE kind='USER_WALLET'),0)::text player_balances FROM ledger_accounts WHERE mode='SANDBOX'`),
    ]);
    const margin = BigInt(money.settled_stake) > 0n ? Number((BigInt(money.ggr) * 10000n) / BigInt(money.settled_stake)) / 100 : null;
    return { users, bets, money: { ...money, holdPercent: margin }, markets, matches, payments, sync, ledger: pnl, currency: 'ATH', mode: 'SANDBOX' };
  }

  async volumeSeries(days = 14) {
    return rows(await this.dbs.db.execute(sql`
      SELECT d::date AS day,
             COALESCE((SELECT SUM(stake) FROM bets WHERE placed_at >= d AND placed_at < d + interval '1 day'),0)::text AS volume,
             COALESCE((SELECT SUM(stake - payout) FROM bets WHERE status <> 'OPEN' AND settled_at >= d AND settled_at < d + interval '1 day'),0)::text AS ggr
      FROM generate_series(date_trunc('day', now()) - (${days - 1} || ' days')::interval, date_trunc('day', now()), interval '1 day') d ORDER BY d`));
  }
}
