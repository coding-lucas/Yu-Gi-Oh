import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DbService } from './db/db.service';
import { AuditService } from './audit/audit.service';
import { AuthGuard } from './common/auth';
import { AllExceptionsFilter } from './common/exception.filter';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { LedgerService } from './ledger/ledger.service';
import { ComplianceService } from './compliance/compliance.service';
import { SettingsService } from './settings/settings.service';
import { WalletService } from './wallet/wallet.service';
import { WalletController } from './wallet/wallet.controller';
import { PaymentsService } from './payments/payments.service';
import { SyncService } from './sports/sync.service';
import { SportsService } from './sports/sports.service';
import { SportsController } from './sports/sports.controller';
import { createSportsProvider, SPORTS_PROVIDER } from './sports/sports-provider.factory';
import { PricingService } from './odds/pricing.service';
import { BetsService } from './bets/bets.service';
import { BetsController } from './bets/bets.controller';
import { SettlementService } from './settlement/settlement.service';
import { RiskService } from './risk/risk.service';
import { AdminController } from './admin/admin.controller';
import { AccountController } from './account/account.controller';
import { EventBus } from './realtime/events';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { JobsService } from './jobs/jobs.service';
import { HealthController } from './health/health.controller';
import { MetricsController } from './health/metrics.controller';

@Module({
  imports: [ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }], skipIf: () => process.env.NODE_ENV === 'test' && process.env.TEST_THROTTLE !== '1' })],
  controllers: [AuthController, WalletController, SportsController, BetsController, AdminController, AccountController, HealthController, MetricsController],
  providers: [
    DbService, AuditService, LedgerService, ComplianceService, SettingsService, AuthService, WalletService, PaymentsService,
    SyncService, SportsService, PricingService, BetsService, SettlementService, RiskService, EventBus, RealtimeGateway, JobsService,
    { provide: SPORTS_PROVIDER, useFactory: createSportsProvider },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
