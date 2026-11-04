import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, PoolClient, types } from 'pg';
import * as schema from './schema';
import { config } from '../config';

// BIGINT (int8) -> JS bigint, NUMERIC stays string; never coerce money to float.
types.setTypeParser(20, (v) => BigInt(v));

export type Tx = NodePgDatabase<typeof schema> & { $client: PoolClient | Pool };
export type Database = NodePgDatabase<typeof schema>;

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;
  readonly db: Database;

  constructor() {
    this.pool = new Pool({ connectionString: config().DATABASE_URL, max: 20 });
    this.db = drizzle(this.pool, { schema });
  }

  /**
   * Runs fn inside a transaction. Serialization failures and deadlocks are retried with jittered
   * back-off so that concurrent money movements are safe and eventually succeed or fail cleanly.
   */
  async tx<T>(fn: (tx: Database, client: PoolClient) => Promise<T>, opts: { isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'; retries?: number } = {}): Promise<T> {
    const retries = opts.retries ?? 5;
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${opts.isolation ?? 'READ COMMITTED'}`);
        const txDb = drizzle(client, { schema });
        const out = await fn(txDb, client);
        await client.query('COMMIT');
        return out;
      } catch (e: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (RETRYABLE.has(e?.code) && attempt < retries) {
          await new Promise((r) => setTimeout(r, 10 * 2 ** attempt + Math.random() * 20));
          continue;
        }
        throw e;
      } finally {
        client.release();
      }
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
