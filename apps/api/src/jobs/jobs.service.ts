import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { SyncService } from '../sports/sync.service';
import { PricingService } from '../odds/pricing.service';
import { SettlementService } from '../settlement/settlement.service';
import { LedgerService } from '../ledger/ledger.service';
import { ComplianceService } from '../compliance/compliance.service';
import { EventBus } from '../realtime/events';

export const JOBS = {
  'sync-fixtures': 10 * 60_000,
  'sync-history': 6 * 3600_000,
  'sync-availability': 60 * 60_000,
  'external-odds': 30 * 60_000,
  price: 5 * 60_000,
  close: 60_000,
  settle: 2 * 60_000,
  reconcile: 60 * 60_000,
  'stale-check': 15 * 60_000,
} as const;
export type JobName = keyof typeof JOBS | 'settle-match';

/**
 * Background processing. With REDIS_URL, jobs run on BullMQ (repeatable jobs, de-duplicated
 * event-driven settlement, retries with back-off) and can be consumed by separate worker processes
 * (`node dist/worker.js`). Without Redis an in-process timer fallback is used (development only).
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(JobsService.name);
  private queue?: Queue;
  private worker?: Worker;
  private connection?: IORedis;
  private timers: NodeJS.Timeout[] = [];
  private running = new Set<string>();

  constructor(
    private readonly sync: SyncService,
    private readonly pricing: PricingService,
    private readonly settlement: SettlementService,
    private readonly ledger: LedgerService,
    private readonly compliance: ComplianceService,
    private readonly bus: EventBus,
  ) {}

  async run(name: JobName, data: any = {}) {
    switch (name) {
      case 'sync-fixtures': {
        const s = await this.sync.syncFixtures();
        await this.pricing.closeStarted();
        await this.settlement.settlePending();
        return s;
      }
      case 'sync-history': return this.sync.syncHistory();
      case 'sync-availability': return this.sync.syncAvailability();
      case 'external-odds': return this.pricing.syncExternalOdds();
      case 'price': return this.pricing.priceUpcoming();
      case 'close': return this.pricing.closeStarted();
      case 'settle': return this.settlement.settlePending();
      case 'settle-match': return this.settlement.settleMatch(data.matchId);
      case 'stale-check': {
        const stale = await this.sync.staleUpcoming();
        await this.pricing.suspendMatches(stale.map((s) => s.id), 'DATA_STALE');
        return stale.length;
      }
      case 'reconcile': {
        const r = await this.ledger.reconcile();
        if (!r.ok) {
          this.log.error(`LEDGER RECONCILIATION FAILED ${JSON.stringify(r)}`);
          await this.compliance.flag(null, 'LEDGER_RECONCILIATION_FAILED', 'HIGH', r as any);
        }
        return r.ok;
      }
    }
  }

  /** Guarded execution for the in-process scheduler (never runs the same job concurrently). */
  private async safeRun(name: JobName, data?: any) {
    const key = name === 'settle-match' ? `${name}:${data?.matchId}` : name;
    if (this.running.has(key)) return;
    this.running.add(key);
    try {
      await this.run(name, data);
    } catch (e: any) {
      this.log.error(`job ${name} failed: ${e?.message}`);
    } finally {
      this.running.delete(key);
    }
  }

  async enqueueSettlement(matchId: string, version: number) {
    if (this.queue) await this.queue.add('settle-match', { matchId }, { jobId: `settle-${matchId}-${version}`, attempts: 5, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000 });
    else void this.safeRun('settle-match', { matchId });
  }

  async onApplicationBootstrap() {
    this.bus.on('match.result', (e) => void this.enqueueSettlement(e.matchId, e.resultVersion));
    if (!config().SCHEDULER_ENABLED || config().NODE_ENV === 'test') return;
    const url = config().REDIS_URL;
    if (url) {
      this.connection = new IORedis(url, { maxRetriesPerRequest: null });
      this.queue = new Queue('athosbet', { connection: this.connection });
      for (const [name, every] of Object.entries(JOBS)) {
        await this.queue.upsertJobScheduler(name, { every }, { name, opts: { removeOnComplete: 100, removeOnFail: 500 } });
      }
      if (process.env.WORKER_INLINE !== 'false') this.startWorker();
      this.log.log('BullMQ scheduler started');
    } else {
      this.log.warn('REDIS_URL not set — using in-process scheduler (development only)');
      for (const [name, every] of Object.entries(JOBS)) this.timers.push(setInterval(() => void this.safeRun(name as JobName), every));
    }
    // warm start
    void (async () => {
      await this.safeRun('sync-history');
      await this.safeRun('sync-fixtures');
      await this.safeRun('price');
    })();
  }

  startWorker() {
    const conn = this.connection ?? new IORedis(config().REDIS_URL!, { maxRetriesPerRequest: null });
    this.worker = new Worker('athosbet', async (job) => this.run(job.name as JobName, job.data), { connection: conn, concurrency: 2 });
    this.worker.on('failed', (job, e) => this.log.error(`job ${job?.name} failed: ${e.message}`));
  }

  async onModuleDestroy() {
    this.timers.forEach(clearInterval);
    await this.worker?.close();
    await this.queue?.close();
    await this.connection?.quit().catch(() => undefined);
  }
}
