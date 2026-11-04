import { Pool, types } from 'pg';
import { walkForwardBacktest, HistoricalMatch } from '@athosbet/odds-engine';
import { config } from '../config';

types.setTypeParser(20, (v) => BigInt(v));

/** Walk-forward backtest over the finished matches stored in the database. */
async function main() {
  const pool = new Pool({ connectionString: config().DATABASE_URL });
  const r = await pool.query(`SELECT home_team_id, away_team_id, home_goals, away_goals, kickoff_at, neutral, c.slug
    FROM matches m JOIN competitions c ON c.id = m.competition_id WHERE m.status='FINISHED' ORDER BY kickoff_at`);
  await pool.end();
  const filter = process.argv[2];
  const hist: HistoricalMatch[] = r.rows.filter((x) => !filter || x.slug === filter).map((x) => ({ homeId: x.home_team_id, awayId: x.away_team_id, homeGoals: x.home_goals, awayGoals: x.away_goals, date: new Date(x.kickoff_at), neutral: x.neutral }));
  const rep = walkForwardBacktest(hist, { warmup: Math.floor(hist.length * 0.4), refitEvery: 50, minTeamMatches: 8 });
  console.log(JSON.stringify({ scope: filter ?? 'all', matches: hist.length, ...rep, calibration: rep.calibration.filter((b) => b.count > 0) }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
