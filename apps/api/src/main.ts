import { createApp } from './bootstrap';
import { config } from './config';
import { migrate } from './db/migrate';
import { ComplianceService } from './compliance/compliance.service';
import { SyncService } from './sports/sync.service';

async function main() {
  if (process.env.MIGRATE_ON_START !== 'false') await migrate(config().DATABASE_URL);
  const app = await createApp();
  await app.get(ComplianceService).seedJurisdictions();
  await app.get(SyncService).syncCatalog();
  await app.listen(config().PORT, '0.0.0.0');
  console.log(`AthosBet API listening on :${config().PORT} (provider=${config().SPORTS_PROVIDER}, realMoney=${config().REAL_MONEY_ENABLED})`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
