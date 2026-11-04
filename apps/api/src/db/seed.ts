import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { config } from '../config';
import { migrate } from './migrate';
import { DbService } from './db.service';
import { encrypt, hashPassword, totp } from '../common/crypto';
import { ComplianceService } from '../compliance/compliance.service';
import { SyncService } from '../sports/sync.service';
import { PricingService } from '../odds/pricing.service';
import { AuthService } from '../auth/auth.service';
import { EligibilityService } from '../payments/eligibility.service';

/**
 * Seeds a demo environment: jurisdictions, competitions, history, fixtures, prices, a demo player and
 * an MFA-protected administrator. Refuses to run in production.
 */
async function main() {
  if (config().NODE_ENV === 'production') throw new Error('seed is disabled in production');
  process.env.SCHEDULER_ENABLED = 'false';
  await migrate(config().DATABASE_URL);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const dbs = app.get(DbService);
  await app.get(ComplianceService).seedJurisdictions();
  const sync = app.get(SyncService);
  await sync.syncCatalog();
  await app.get(EligibilityService).seedDefaults();
  console.log('history…', await sync.syncHistory().then((s) => s.upserted));
  console.log('fixtures…', await sync.syncFixtures().then((s) => s.upserted));
  console.log('priced matches:', await app.get(PricingService).priceUpcoming());

  const secret = process.env.DEMO_ADMIN_TOTP_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const adminEmail = 'admin@athosbet.dev';
  const adminPass = process.env.DEMO_ADMIN_PASSWORD ?? 'AthosAdmin2026';
  await dbs.pool.query(
    `INSERT INTO users(email,password_hash,display_name,role,date_of_birth,country,mfa_secret_enc,mfa_enabled,kyc_status)
     VALUES ($1,$2,'AthosBet Admin','ADMIN','1985-01-01','PT',$3,true,'VERIFIED') ON CONFLICT (email) DO NOTHING`,
    [adminEmail, await hashPassword(adminPass), encrypt(secret, config().DATA_ENCRYPTION_KEY)],
  );
  const demoEmail = 'demo@athosbet.dev';
  const exists = await dbs.pool.query('SELECT 1 FROM users WHERE email=$1', [demoEmail]);
  if (!exists.rowCount) {
    await app.get(AuthService).register({ email: demoEmail, password: 'DemoPlayer2026', displayName: 'Demo', dateOfBirth: '1995-06-15', country: 'PT', locale: 'pt', timezone: 'America/Sao_Paulo' }, null, 'XX');
  }
  console.log(`\nDemo player : ${demoEmail} / DemoPlayer2026`);
  console.log(`Admin       : ${adminEmail} / ${adminPass}`);
  console.log(`Admin TOTP  : secret ${secret} (current code ${totp(secret)}) — add it to an authenticator app\n`);
  await app.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
