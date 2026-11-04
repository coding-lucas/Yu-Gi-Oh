-- AthosBet initial schema. Money is always BIGINT minor units. Odds are INTEGER thousandths.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ───────────────────────── users & auth ─────────────────────────
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext NOT NULL UNIQUE,
  password_hash   text NOT NULL,
  display_name    text NOT NULL,
  role            text NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','SUPPORT','RISK','ADMIN')),
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  date_of_birth   date NOT NULL,
  country         char(2) NOT NULL,
  locale          text NOT NULL DEFAULT 'en',
  timezone        text NOT NULL DEFAULT 'UTC',
  kyc_status      text NOT NULL DEFAULT 'NONE' CHECK (kyc_status IN ('NONE','PENDING','VERIFIED','REJECTED')),
  mfa_secret_enc  text,
  mfa_enabled     boolean NOT NULL DEFAULT false,
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  family      uuid NOT NULL,
  mfa         boolean NOT NULL DEFAULT false,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id);

CREATE TABLE password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── compliance ─────────────────────────
CREATE TABLE jurisdictions (
  country     char(2) PRIMARY KEY,
  status      text NOT NULL CHECK (status IN ('BLOCKED','SANDBOX_ONLY','LICENSED')),
  note        text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rg_limits (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  deposit_daily    bigint CHECK (deposit_daily > 0),
  deposit_weekly   bigint CHECK (deposit_weekly > 0),
  deposit_monthly  bigint CHECK (deposit_monthly > 0),
  loss_daily       bigint CHECK (loss_daily > 0),
  loss_weekly      bigint CHECK (loss_weekly > 0),
  loss_monthly     bigint CHECK (loss_monthly > 0),
  max_stake        bigint CHECK (max_stake > 0),
  -- increases (or removals) only take effect after a cooling-off period
  pending          jsonb,
  pending_effective_at timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE self_exclusions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at   timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz, -- NULL = permanent
  kind        text NOT NULL CHECK (kind IN ('COOL_OFF','SELF_EXCLUSION')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX self_exclusions_user_idx ON self_exclusions(user_id);

CREATE TABLE suspicious_activities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id),
  kind        text NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH')),
  details     jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','REVIEWED','ESCALATED')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX suspicious_status_idx ON suspicious_activities(status, created_at DESC);

-- ───────────────────────── ledger (double entry) ─────────────────────────
CREATE TABLE ledger_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  kind        text NOT NULL CHECK (kind IN ('USER_WALLET','HOUSE_BETS_HELD','HOUSE_PNL','PAYMENT_CLEARING','WITHDRAWALS_PENDING')),
  user_id     uuid REFERENCES users(id),
  currency    text NOT NULL,
  mode        text NOT NULL CHECK (mode IN ('SANDBOX','REAL')),
  balance     bigint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'USER_WALLET') = (user_id IS NOT NULL))
);
CREATE UNIQUE INDEX ledger_accounts_user_uq ON ledger_accounts(user_id, currency, mode) WHERE user_id IS NOT NULL;

CREATE TABLE ledger_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text NOT NULL CHECK (type IN ('DEPOSIT','WITHDRAWAL_REQUEST','WITHDRAWAL_COMPLETE','WITHDRAWAL_REVERSAL','BET_PLACE','BET_SETTLE','BET_RESETTLE_REVERSAL','ADJUSTMENT')),
  idempotency_key  text NOT NULL UNIQUE,
  reference_type   text,
  reference_id     uuid,
  reverses_id      uuid REFERENCES ledger_transactions(id),
  metadata         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_tx_ref_idx ON ledger_transactions(reference_type, reference_id);

CREATE TABLE ledger_entries (
  id              bigserial PRIMARY KEY,
  transaction_id  uuid NOT NULL REFERENCES ledger_transactions(id),
  account_id      uuid NOT NULL REFERENCES ledger_accounts(id),
  amount          bigint NOT NULL CHECK (amount <> 0),
  balance_after   bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries(account_id, id DESC);
CREATE INDEX ledger_entries_tx_idx ON ledger_entries(transaction_id);

-- Immutability: ledger rows can never be updated or deleted. Corrections are new, reversing transactions.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_tx_immutable BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries EXECUTE FUNCTION forbid_mutation();

-- Balance: every transaction's entries must sum to zero, checked at COMMIT.
CREATE FUNCTION check_tx_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bigint; c int;
BEGIN
  SELECT COALESCE(SUM(amount),0), COUNT(*) INTO s, c FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF s <> 0 OR c < 2 THEN
    RAISE EXCEPTION 'ledger transaction % unbalanced (sum %, entries %)', NEW.transaction_id, s, c USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_tx_balanced();

-- Currency consistency between entries of the same transaction.
CREATE FUNCTION check_tx_currency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  SELECT COUNT(DISTINCT (a.currency, a.mode)) INTO n FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.transaction_id = NEW.transaction_id;
  IF n > 1 THEN RAISE EXCEPTION 'ledger transaction % mixes currencies/modes', NEW.transaction_id USING ERRCODE = 'check_violation'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entries_currency AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_tx_currency();

-- ───────────────────────── payments ─────────────────────────
CREATE TABLE payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  provider         text NOT NULL,
  method           text NOT NULL CHECK (method IN ('PIX','CREDIT_CARD','DEBIT_CARD','BOLETO','BANK_TRANSFER','BTC','SANDBOX')),
  direction        text NOT NULL CHECK (direction IN ('DEPOSIT','WITHDRAWAL')),
  amount           bigint NOT NULL CHECK (amount > 0),
  currency         text NOT NULL,
  mode             text NOT NULL CHECK (mode IN ('SANDBOX','REAL')),
  status           text NOT NULL CHECK (status IN ('PENDING','COMPLETED','FAILED','CANCELLED','REQUIRES_REVIEW')),
  idempotency_key  text NOT NULL,
  provider_ref     text,
  ledger_tx_id     uuid REFERENCES ledger_transactions(id),
  failure_reason   text,
  metadata         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  UNIQUE (provider, provider_ref)
);
CREATE INDEX payments_user_idx ON payments(user_id, created_at DESC);
CREATE INDEX payments_status_idx ON payments(status, created_at DESC);

CREATE TABLE payment_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL,
  event_id     text NOT NULL,
  payload      jsonb NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- ───────────────────────── sports data ─────────────────────────
CREATE TABLE competitions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         text NOT NULL,
  provider_id      text NOT NULL,
  slug             text NOT NULL UNIQUE,
  name             text NOT NULL,
  country          text NOT NULL,
  country_code     text,
  region           text NOT NULL CHECK (region IN ('BRAZIL','SOUTH_AMERICA','EUROPE','WORLD','OTHER')),
  type             text NOT NULL CHECK (type IN ('LEAGUE','CUP','INTERNATIONAL')),
  priority         integer NOT NULL DEFAULT 100,
  enabled          boolean NOT NULL DEFAULT true,
  betting_enabled  boolean NOT NULL DEFAULT true,
  coverage_status  text NOT NULL DEFAULT 'UNVERIFIED' CHECK (coverage_status IN ('UNVERIFIED','PARTIAL','VERIFIED')),
  season_mode      text NOT NULL DEFAULT 'CALENDAR' CHECK (season_mode IN ('CALENDAR','SPLIT')),
  current_season   integer,
  logo_url         text,
  coverage         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_id)
);

CREATE TABLE teams (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL,
  provider_id  text NOT NULL,
  name         text NOT NULL,
  short_name   text,
  country      text,
  logo_url     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_id)
);
CREATE TABLE team_aliases (
  team_id  uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  source   text NOT NULL,
  alias    text NOT NULL,
  PRIMARY KEY (source, alias)
);

CREATE TABLE matches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        text NOT NULL,
  provider_id     text NOT NULL,
  competition_id  uuid NOT NULL REFERENCES competitions(id),
  season          integer NOT NULL,
  round           text,
  home_team_id    uuid NOT NULL REFERENCES teams(id),
  away_team_id    uuid NOT NULL REFERENCES teams(id),
  kickoff_at      timestamptz NOT NULL,
  original_kickoff_at timestamptz NOT NULL,
  status          text NOT NULL CHECK (status IN ('SCHEDULED','LIVE','FINISHED','POSTPONED','CANCELLED','ABANDONED','SUSPENDED')),
  status_detail   text,
  home_goals      integer CHECK (home_goals >= 0),
  away_goals      integer CHECK (away_goals >= 0),
  result_version  integer NOT NULL DEFAULT 0,
  result_source   text,
  result_locked   boolean NOT NULL DEFAULT false,
  venue           text,
  neutral         boolean NOT NULL DEFAULT false,
  featured        boolean NOT NULL DEFAULT false,
  last_synced_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_id),
  CHECK (home_team_id <> away_team_id),
  CHECK (status <> 'FINISHED' OR (home_goals IS NOT NULL AND away_goals IS NOT NULL))
);
-- cross-source de-duplication: one fixture per pairing per competition per kickoff day
CREATE UNIQUE INDEX matches_dedup_uq ON matches(competition_id, home_team_id, away_team_id, ((original_kickoff_at AT TIME ZONE 'UTC')::date));
CREATE INDEX matches_kickoff_idx ON matches(kickoff_at);
CREATE INDEX matches_comp_kickoff_idx ON matches(competition_id, kickoff_at);
CREATE INDEX matches_status_idx ON matches(status);
CREATE INDEX matches_home_idx ON matches(home_team_id, kickoff_at);
CREATE INDEX matches_away_idx ON matches(away_team_id, kickoff_at);

CREATE TABLE match_external_ids (
  match_id     uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  source       text NOT NULL,
  external_id  text NOT NULL,
  PRIMARY KEY (source, external_id)
);

CREATE TABLE match_statistics (
  match_id    uuid PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  data        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_availability (
  match_id      uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES teams(id),
  attack_loss   numeric(4,3) NOT NULL DEFAULT 0 CHECK (attack_loss BETWEEN 0 AND 1),
  defense_loss  numeric(4,3) NOT NULL DEFAULT 0 CHECK (defense_loss BETWEEN 0 AND 1),
  details       jsonb NOT NULL DEFAULT '[]',
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, team_id)
);

CREATE TABLE match_result_history (
  id            bigserial PRIMARY KEY,
  match_id      uuid NOT NULL REFERENCES matches(id),
  version       integer NOT NULL,
  status        text NOT NULL,
  home_goals    integer,
  away_goals    integer,
  source        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, version)
);

CREATE TABLE favorites (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     text NOT NULL CHECK (kind IN ('TEAM','COMPETITION')),
  ref_id   uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, ref_id)
);

-- ───────────────────────── pricing ─────────────────────────
CREATE TABLE model_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           text NOT NULL,
  model_version   text NOT NULL,
  fitted_at       timestamptz NOT NULL,
  n_matches       integer NOT NULL,
  params          jsonb NOT NULL,
  metrics         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_runs_scope_idx ON model_runs(scope, created_at DESC);

CREATE TABLE probability_snapshots (
  id            bigserial PRIMARY KEY,
  match_id      uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  model_run_id  uuid REFERENCES model_runs(id),
  model_version text NOT NULL,
  lambda_home   double precision,
  lambda_away   double precision,
  status        text NOT NULL,
  suspension_reason text,
  fair          jsonb NOT NULL,
  external      jsonb,
  factors       jsonb,
  diagnostics   jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prob_snap_match_idx ON probability_snapshots(match_id, id DESC);

CREATE TABLE external_odds (
  id            bigserial PRIMARY KEY,
  match_id      uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  source        text NOT NULL,
  bookmakers    integer NOT NULL,
  data          jsonb NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX external_odds_match_idx ON external_odds(match_id, fetched_at DESC);

CREATE TABLE markets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id           uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  key                text NOT NULL,
  type               text NOT NULL,
  line               numeric(4,1),
  status             text NOT NULL CHECK (status IN ('OPEN','SUSPENDED','CLOSED','SETTLED','VOID')),
  suspension_reason  text,
  manual_suspension  boolean NOT NULL DEFAULT false,
  version            integer NOT NULL DEFAULT 1,
  settled_result_version integer,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, key)
);
CREATE INDEX markets_status_idx ON markets(status);

-- Versioned prices. A row is never modified except to flip is_current off when superseded.
CREATE TABLE odds (
  id          bigserial PRIMARY KEY,
  market_id   uuid NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  selection   text NOT NULL,
  odds_k      integer NOT NULL CHECK (odds_k >= 1001),
  fair_prob   double precision NOT NULL CHECK (fair_prob >= 0 AND fair_prob <= 1),
  version     integer NOT NULL,
  is_current  boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_id, selection, version)
);
CREATE UNIQUE INDEX odds_current_uq ON odds(market_id, selection) WHERE is_current;

-- ───────────────────────── bets ─────────────────────────
CREATE TABLE bets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL UNIQUE,
  user_id             uuid NOT NULL REFERENCES users(id),
  type                text NOT NULL CHECK (type IN ('SINGLE','MULTIPLE')),
  stake               bigint NOT NULL CHECK (stake > 0),
  currency            text NOT NULL,
  mode                text NOT NULL CHECK (mode IN ('SANDBOX','REAL')),
  combined_odds_k     bigint NOT NULL CHECK (combined_odds_k >= 1000),
  potential_payout    bigint NOT NULL CHECK (potential_payout >= stake),
  status              text NOT NULL CHECK (status IN ('OPEN','WON','LOST','VOID')),
  payout              bigint CHECK (payout >= 0),
  settlement_version  integer NOT NULL DEFAULT 0,
  idempotency_key     text NOT NULL,
  odds_policy         text NOT NULL,
  country             char(2),
  ip                  inet,
  placed_at           timestamptz NOT NULL DEFAULT now(),
  settled_at          timestamptz,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX bets_user_idx ON bets(user_id, placed_at DESC);
CREATE INDEX bets_status_idx ON bets(status, placed_at DESC);

CREATE TABLE bet_selections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bet_id      uuid NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  match_id    uuid NOT NULL REFERENCES matches(id),
  market_id   uuid NOT NULL REFERENCES markets(id),
  odds_id     bigint NOT NULL REFERENCES odds(id),
  market_key  text NOT NULL,
  selection   text NOT NULL,
  odds_k      integer NOT NULL CHECK (odds_k >= 1001),
  result      text NOT NULL DEFAULT 'PENDING' CHECK (result IN ('PENDING','WON','LOST','VOID')),
  result_version integer,
  void_reason text,
  UNIQUE (bet_id, market_id, selection)
);
CREATE INDEX bet_selections_match_idx ON bet_selections(match_id);
CREATE INDEX bet_selections_market_idx ON bet_selections(market_id, selection);

CREATE TABLE settlements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bet_id         uuid NOT NULL REFERENCES bets(id),
  version        integer NOT NULL CHECK (version >= 1),
  result         text NOT NULL CHECK (result IN ('WON','LOST','VOID')),
  payout         bigint NOT NULL CHECK (payout >= 0),
  ledger_tx_id   uuid REFERENCES ledger_transactions(id),
  reversal_tx_id uuid REFERENCES ledger_transactions(id),
  reason         text NOT NULL CHECK (reason IN ('INITIAL','RESULT_CORRECTION')),
  match_versions jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bet_id, version)
);

-- ───────────────────────── platform ─────────────────────────
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  actor_id     uuid,
  actor_role   text,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  before       jsonb,
  after        jsonb,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs(entity_type, entity_id);
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE provider_sync_runs (
  id           bigserial PRIMARY KEY,
  provider     text NOT NULL,
  job          text NOT NULL,
  status       text NOT NULL CHECK (status IN ('RUNNING','SUCCESS','PARTIAL','FAILED')),
  items        integer NOT NULL DEFAULT 0,
  error        text,
  http_status  integer,
  details      jsonb,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX provider_sync_runs_idx ON provider_sync_runs(started_at DESC);
