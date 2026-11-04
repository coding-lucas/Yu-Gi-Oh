import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { createHash } from 'node:crypto';

/**
 * Minimal, deterministic SQL migrator: applies migrations/*.sql in lexical order, each in its own
 * transaction, and records a checksum so that edited, already-applied migrations are detected.
 */
export async function migrate(databaseUrl: string, dir = path.resolve(__dirname, '../../migrations'), log = console.log) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map<string, string>((await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(path.join(dir, file), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(file)) {
        if (applied.get(file) !== sum) throw new Error(`Migration ${file} was modified after being applied`);
        continue;
      }
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [file, sum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    await client.end();
  }
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { config } = require('../config');
  migrate(config().DATABASE_URL).then(() => { console.log('migrations up to date'); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
}
