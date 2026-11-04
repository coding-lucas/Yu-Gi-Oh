import { Controller, Get, Header, Headers } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { Public } from '../common/auth';
import { DbService } from '../db/db.service';
import { err } from '../common/errors';

/** In-process HTTP counters, filled by the middleware registered in bootstrap. */
export const httpCounters = new Map<string, number>();
export function countRequest(method: string, status: number, ms: number) {
  const k = `${method}|${Math.floor(status / 100)}xx`;
  httpCounters.set(k, (httpCounters.get(k) ?? 0) + 1);
  httpCounters.set('__latency_sum', (httpCounters.get('__latency_sum') ?? 0) + ms);
  httpCounters.set('__latency_count', (httpCounters.get('__latency_count') ?? 0) + 1);
}

/** Prometheus exposition. Protected by METRICS_TOKEN when set. */
@ApiTags('health')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly dbs: DbService) {}

  @Public()
  @Get()
  @Header('content-type', 'text/plain; version=0.0.4')
  async metrics(@Headers('authorization') auth?: string) {
    const token = process.env.METRICS_TOKEN;
    if (token && auth !== `Bearer ${token}`) throw err.unauthorized();
    const r = (await this.dbs.db.execute(sql`SELECT
      (SELECT COUNT(*) FROM bets WHERE status='OPEN')::int open_bets,
      (SELECT COALESCE(SUM(potential_payout),0) FROM bets WHERE status='OPEN')::text open_liability,
      (SELECT COUNT(*) FROM markets WHERE status='OPEN')::int open_markets,
      (SELECT COUNT(*) FROM markets WHERE status='SUSPENDED')::int suspended_markets,
      (SELECT COUNT(*) FROM provider_sync_runs WHERE status IN ('FAILED','PARTIAL') AND started_at > now() - interval '1 hour')::int sync_errors_1h,
      (SELECT COUNT(*) FROM suspicious_activities WHERE status='OPEN')::int open_alerts,
      (SELECT COUNT(*) FROM ledger_transactions)::int ledger_transactions`)).rows[0] as any;
    const lines = [
      `athosbet_open_bets ${r.open_bets}`,
      `athosbet_open_liability_minor ${r.open_liability}`,
      `athosbet_markets{status="open"} ${r.open_markets}`,
      `athosbet_markets{status="suspended"} ${r.suspended_markets}`,
      `athosbet_provider_sync_errors_1h ${r.sync_errors_1h}`,
      `athosbet_open_risk_alerts ${r.open_alerts}`,
      `athosbet_ledger_transactions_total ${r.ledger_transactions}`,
      `process_resident_memory_bytes ${process.memoryUsage().rss}`,
      `process_uptime_seconds ${Math.round(process.uptime())}`,
    ];
    for (const [k, v] of httpCounters) {
      if (k.startsWith('__')) continue;
      const [method, cls] = k.split('|');
      lines.push(`http_requests_total{method="${method}",class="${cls}"} ${v}`);
    }
    lines.push(`http_request_duration_ms_sum ${httpCounters.get('__latency_sum') ?? 0}`, `http_request_duration_ms_count ${httpCounters.get('__latency_count') ?? 0}`);
    return lines.join('\n') + '\n';
  }
}
