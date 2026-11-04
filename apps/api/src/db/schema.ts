/**
 * Drizzle mapping of the SQL schema in /migrations (the SQL files are the source of truth;
 * constraints, triggers and partial indexes live there).
 */
import {
  bigint, bigserial, boolean, char, date, doublePrecision, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uuid,
} from 'drizzle-orm/pg-core';

const ts = (n: string) => timestamp(n, { withTimezone: true, mode: 'date' });
const money = (n: string) => bigint(n, { mode: 'bigint' });

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role').$type<'USER' | 'SUPPORT' | 'RISK' | 'ADMIN'>().notNull(),
  status: text('status').$type<'ACTIVE' | 'SUSPENDED' | 'CLOSED'>().notNull(),
  dateOfBirth: date('date_of_birth', { mode: 'string' }).notNull(),
  country: char('country', { length: 2 }).notNull(),
  locale: text('locale').notNull(),
  timezone: text('timezone').notNull(),
  kycStatus: text('kyc_status').$type<'NONE' | 'PENDING' | 'VERIFIED' | 'REJECTED'>().notNull(),
  mfaSecretEnc: text('mfa_secret_enc'),
  mfaEnabled: boolean('mfa_enabled').notNull(),
  failedLogins: integer('failed_logins').notNull(),
  lockedUntil: ts('locked_until'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  family: uuid('family').notNull(),
  mfa: boolean('mfa').notNull(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const passwordResets = pgTable('password_resets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
});

export const jurisdictions = pgTable('jurisdictions', {
  country: char('country', { length: 2 }).primaryKey(),
  status: text('status').$type<'BLOCKED' | 'SANDBOX_ONLY' | 'LICENSED'>().notNull(),
  note: text('note'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const rgLimits = pgTable('rg_limits', {
  userId: uuid('user_id').primaryKey(),
  depositDaily: money('deposit_daily'),
  depositWeekly: money('deposit_weekly'),
  depositMonthly: money('deposit_monthly'),
  lossDaily: money('loss_daily'),
  lossWeekly: money('loss_weekly'),
  lossMonthly: money('loss_monthly'),
  maxStake: money('max_stake'),
  pending: jsonb('pending').$type<Record<string, string | null> | null>(),
  pendingEffectiveAt: ts('pending_effective_at'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const selfExclusions = pgTable('self_exclusions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  startsAt: ts('starts_at').notNull().defaultNow(),
  endsAt: ts('ends_at'),
  kind: text('kind').$type<'COOL_OFF' | 'SELF_EXCLUSION'>().notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const suspiciousActivities = pgTable('suspicious_activities', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id'),
  kind: text('kind').notNull(),
  severity: text('severity').$type<'LOW' | 'MEDIUM' | 'HIGH'>().notNull(),
  details: jsonb('details').notNull(),
  status: text('status').$type<'OPEN' | 'REVIEWED' | 'ESCALATED'>().notNull().default('OPEN'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const ledgerAccounts = pgTable('ledger_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull(),
  kind: text('kind').$type<'USER_WALLET' | 'HOUSE_BETS_HELD' | 'HOUSE_PNL' | 'PAYMENT_CLEARING' | 'WITHDRAWALS_PENDING'>().notNull(),
  userId: uuid('user_id'),
  currency: text('currency').notNull(),
  mode: text('mode').$type<'SANDBOX' | 'REAL'>().notNull(),
  balance: money('balance').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const ledgerTransactions = pgTable('ledger_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  referenceType: text('reference_type'),
  referenceId: uuid('reference_id'),
  reversesId: uuid('reverses_id'),
  metadata: jsonb('metadata').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const ledgerEntries = pgTable('ledger_entries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  transactionId: uuid('transaction_id').notNull(),
  accountId: uuid('account_id').notNull(),
  amount: money('amount').notNull(),
  balanceAfter: money('balance_after').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type PaymentStatus = 'PENDING' | 'REQUIRES_ACTION' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'REQUIRES_REVIEW';

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  provider: text('provider').notNull(),
  method: text('method').notNull(),
  direction: text('direction').$type<'DEPOSIT' | 'WITHDRAWAL' | 'REFUND'>().notNull(),
  amount: money('amount').notNull(),
  currency: text('currency').notNull(),
  mode: text('mode').$type<'SANDBOX' | 'REAL'>().notNull(),
  status: text('status').$type<PaymentStatus>().notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  providerRef: text('provider_ref'),
  ledgerTxId: uuid('ledger_tx_id'),
  failureReason: text('failure_reason'),
  metadata: jsonb('metadata').notNull().default({}),
  country: char('country', { length: 2 }),
  providerCurrency: text('provider_currency'),
  providerAmount: money('provider_amount'),
  providerStatus: text('provider_status'),
  providerHandleId: text('provider_handle_id'),
  nextAction: jsonb('next_action'),
  parentPaymentId: uuid('parent_payment_id'),
  syncAttempts: integer('sync_attempts').notNull().default(0),
  lastSyncedAt: ts('last_synced_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const paymentEvents = pgTable('payment_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  eventId: text('event_id').notNull(),
  payload: jsonb('payload').notNull(),
  signatureValid: boolean('signature_valid').notNull().default(true),
  paymentId: uuid('payment_id'),
  processedAt: ts('processed_at').notNull().defaultNow(),
});

export const competitions = pgTable('competitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  providerId: text('provider_id').notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  country: text('country').notNull(),
  countryCode: text('country_code'),
  region: text('region').$type<'BRAZIL' | 'SOUTH_AMERICA' | 'EUROPE' | 'WORLD' | 'OTHER'>().notNull(),
  type: text('type').$type<'LEAGUE' | 'CUP' | 'INTERNATIONAL'>().notNull(),
  priority: integer('priority').notNull(),
  enabled: boolean('enabled').notNull(),
  bettingEnabled: boolean('betting_enabled').notNull(),
  coverageStatus: text('coverage_status').$type<'UNVERIFIED' | 'PARTIAL' | 'VERIFIED'>().notNull(),
  seasonMode: text('season_mode').$type<'CALENDAR' | 'SPLIT'>().notNull(),
  currentSeason: integer('current_season'),
  logoUrl: text('logo_url'),
  coverage: jsonb('coverage').notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  providerId: text('provider_id').notNull(),
  name: text('name').notNull(),
  shortName: text('short_name'),
  country: text('country'),
  logoUrl: text('logo_url'),
  primaryColor: text('primary_color'),
  secondaryColor: text('secondary_color'),
  crestPattern: text('crest_pattern'),
  logoSource: text('logo_source'),
});

export const teamAliases = pgTable('team_aliases', {
  teamId: uuid('team_id').notNull(),
  source: text('source').notNull(),
  alias: text('alias').notNull(),
}, (t) => [primaryKey({ columns: [t.source, t.alias] })]);

export type MatchStatus = 'SCHEDULED' | 'LIVE' | 'FINISHED' | 'POSTPONED' | 'CANCELLED' | 'ABANDONED' | 'SUSPENDED';

export const matches = pgTable('matches', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  providerId: text('provider_id').notNull(),
  competitionId: uuid('competition_id').notNull(),
  season: integer('season').notNull(),
  round: text('round'),
  homeTeamId: uuid('home_team_id').notNull(),
  awayTeamId: uuid('away_team_id').notNull(),
  kickoffAt: ts('kickoff_at').notNull(),
  originalKickoffAt: ts('original_kickoff_at').notNull(),
  status: text('status').$type<MatchStatus>().notNull(),
  statusDetail: text('status_detail'),
  homeGoals: integer('home_goals'),
  awayGoals: integer('away_goals'),
  resultVersion: integer('result_version').notNull().default(0),
  resultSource: text('result_source'),
  resultLocked: boolean('result_locked').notNull().default(false),
  venue: text('venue'),
  neutral: boolean('neutral').notNull().default(false),
  featured: boolean('featured').notNull().default(false),
  lastSyncedAt: ts('last_synced_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const matchExternalIds = pgTable('match_external_ids', {
  matchId: uuid('match_id').notNull(),
  source: text('source').notNull(),
  externalId: text('external_id').notNull(),
}, (t) => [primaryKey({ columns: [t.source, t.externalId] })]);

export const matchStatistics = pgTable('match_statistics', {
  matchId: uuid('match_id').primaryKey(),
  data: jsonb('data').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const teamAvailability = pgTable('team_availability', {
  matchId: uuid('match_id').notNull(),
  teamId: uuid('team_id').notNull(),
  attackLoss: numeric('attack_loss').notNull(),
  defenseLoss: numeric('defense_loss').notNull(),
  details: jsonb('details').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.matchId, t.teamId] })]);

export const matchResultHistory = pgTable('match_result_history', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  matchId: uuid('match_id').notNull(),
  version: integer('version').notNull(),
  status: text('status').notNull(),
  homeGoals: integer('home_goals'),
  awayGoals: integer('away_goals'),
  source: text('source').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const favorites = pgTable('favorites', {
  userId: uuid('user_id').notNull(),
  kind: text('kind').$type<'TEAM' | 'COMPETITION'>().notNull(),
  refId: uuid('ref_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.kind, t.refId] })]);

export const modelRuns = pgTable('model_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  scope: text('scope').notNull(),
  modelVersion: text('model_version').notNull(),
  fittedAt: ts('fitted_at').notNull(),
  nMatches: integer('n_matches').notNull(),
  params: jsonb('params').notNull(),
  metrics: jsonb('metrics'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const probabilitySnapshots = pgTable('probability_snapshots', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  matchId: uuid('match_id').notNull(),
  modelRunId: uuid('model_run_id'),
  modelVersion: text('model_version').notNull(),
  lambdaHome: doublePrecision('lambda_home'),
  lambdaAway: doublePrecision('lambda_away'),
  status: text('status').notNull(),
  suspensionReason: text('suspension_reason'),
  fair: jsonb('fair').notNull(),
  external: jsonb('external'),
  factors: jsonb('factors'),
  diagnostics: jsonb('diagnostics'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const externalOdds = pgTable('external_odds', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  matchId: uuid('match_id').notNull(),
  source: text('source').notNull(),
  bookmakers: integer('bookmakers').notNull(),
  data: jsonb('data').notNull(),
  fetchedAt: ts('fetched_at').notNull().defaultNow(),
});

export type MarketStatus = 'OPEN' | 'SUSPENDED' | 'CLOSED' | 'SETTLED' | 'VOID';

export const markets = pgTable('markets', {
  id: uuid('id').primaryKey().defaultRandom(),
  matchId: uuid('match_id').notNull(),
  key: text('key').notNull(),
  type: text('type').notNull(),
  line: numeric('line'),
  status: text('status').$type<MarketStatus>().notNull(),
  suspensionReason: text('suspension_reason'),
  manualSuspension: boolean('manual_suspension').notNull().default(false),
  version: integer('version').notNull().default(1),
  settledResultVersion: integer('settled_result_version'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const odds = pgTable('odds', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  marketId: uuid('market_id').notNull(),
  selection: text('selection').notNull(),
  oddsK: integer('odds_k').notNull(),
  fairProb: doublePrecision('fair_prob').notNull(),
  version: integer('version').notNull(),
  isCurrent: boolean('is_current').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type BetStatus = 'OPEN' | 'WON' | 'LOST' | 'VOID';

export const bets = pgTable('bets', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull(),
  userId: uuid('user_id').notNull(),
  type: text('type').$type<'SINGLE' | 'MULTIPLE'>().notNull(),
  stake: money('stake').notNull(),
  currency: text('currency').notNull(),
  mode: text('mode').$type<'SANDBOX' | 'REAL'>().notNull(),
  combinedOddsK: money('combined_odds_k').notNull(),
  potentialPayout: money('potential_payout').notNull(),
  status: text('status').$type<BetStatus>().notNull(),
  payout: money('payout'),
  settlementVersion: integer('settlement_version').notNull().default(0),
  idempotencyKey: text('idempotency_key').notNull(),
  oddsPolicy: text('odds_policy').notNull(),
  country: char('country', { length: 2 }),
  ip: text('ip'),
  placedAt: ts('placed_at').notNull().defaultNow(),
  settledAt: ts('settled_at'),
});

export const betSelections = pgTable('bet_selections', {
  id: uuid('id').primaryKey().defaultRandom(),
  betId: uuid('bet_id').notNull(),
  matchId: uuid('match_id').notNull(),
  marketId: uuid('market_id').notNull(),
  oddsId: bigint('odds_id', { mode: 'number' }).notNull(),
  marketKey: text('market_key').notNull(),
  selection: text('selection').notNull(),
  oddsK: integer('odds_k').notNull(),
  result: text('result').$type<'PENDING' | 'WON' | 'LOST' | 'VOID'>().notNull().default('PENDING'),
  resultVersion: integer('result_version'),
  voidReason: text('void_reason'),
});

export const settlements = pgTable('settlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  betId: uuid('bet_id').notNull(),
  version: integer('version').notNull(),
  result: text('result').notNull(),
  payout: money('payout').notNull(),
  ledgerTxId: uuid('ledger_tx_id'),
  reversalTxId: uuid('reversal_tx_id'),
  reason: text('reason').notNull(),
  matchVersions: jsonb('match_versions').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  actorId: uuid('actor_id'),
  actorRole: text('actor_role'),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: text('ip'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const providerSyncRuns = pgTable('provider_sync_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  provider: text('provider').notNull(),
  job: text('job').notNull(),
  status: text('status').$type<'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED'>().notNull(),
  items: integer('items').notNull().default(0),
  error: text('error'),
  httpStatus: integer('http_status'),
  details: jsonb('details'),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
});

export const paymentMethodEligibility = pgTable('payment_method_eligibility', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  method: text('method').notNull(),
  country: text('country').notNull(),
  mode: text('mode').$type<'SANDBOX' | 'REAL'>().notNull(),
  currency: text('currency').notNull(),
  directions: text('directions').array().notNull().default(['DEPOSIT', 'WITHDRAWAL', 'REFUND']),
  priority: integer('priority').notNull().default(100),
  athosbetEligible: boolean('athosbet_eligible').notNull().default(false),
  regulatoryApproved: boolean('regulatory_approved').notNull().default(false),
  gatewayApproved: boolean('gateway_approved').notNull().default(false),
  enabled: boolean('enabled').notNull().default(false),
  minAmount: money('min_amount').notNull(),
  maxAmount: money('max_amount').notNull(),
  evidence: text('evidence'),
  updatedBy: uuid('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const paymentReconciliationRuns = pgTable('payment_reconciliation_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  provider: text('provider').notNull(),
  status: text('status').$type<'OK' | 'MISMATCH' | 'ERROR'>().notNull(),
  checked: integer('checked').notNull().default(0),
  mismatches: jsonb('mismatches').notNull().default([]),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
});
