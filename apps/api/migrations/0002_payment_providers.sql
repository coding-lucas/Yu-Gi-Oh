-- Payment provider abstraction (Paysafe primary, Nuvei secondary), method eligibility,
-- refunds, asynchronous confirmation, reconciliation runs and team visual identity.

ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_type_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_type_check CHECK (type IN (
  'DEPOSIT','WITHDRAWAL_REQUEST','WITHDRAWAL_COMPLETE','WITHDRAWAL_REVERSAL',
  'REFUND_REQUEST','REFUND_COMPLETE','REFUND_REVERSAL',
  'BET_PLACE','BET_SETTLE','BET_RESETTLE_REVERSAL','ADJUSTMENT'));

ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('PIX','CREDIT_CARD','DEBIT_CARD','BOLETO','BANK_TRANSFER','CRYPTO','BTC','SANDBOX'));
ALTER TABLE payments DROP CONSTRAINT payments_direction_check;
ALTER TABLE payments ADD CONSTRAINT payments_direction_check CHECK (direction IN ('DEPOSIT','WITHDRAWAL','REFUND'));
ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (status IN ('PENDING','REQUIRES_ACTION','COMPLETED','FAILED','CANCELLED','REQUIRES_REVIEW'));

ALTER TABLE payments
  ADD COLUMN country             char(2),
  ADD COLUMN provider_currency   text,
  ADD COLUMN provider_amount     bigint CHECK (provider_amount > 0),
  ADD COLUMN provider_status     text,
  ADD COLUMN provider_handle_id  text,
  ADD COLUMN next_action         jsonb,
  ADD COLUMN parent_payment_id   uuid REFERENCES payments(id),
  ADD COLUMN sync_attempts       integer NOT NULL DEFAULT 0,
  ADD COLUMN last_synced_at      timestamptz;
CREATE INDEX payments_pending_sync_idx ON payments(status, last_synced_at) WHERE status IN ('PENDING','REQUIRES_ACTION');
CREATE INDEX payments_parent_idx ON payments(parent_payment_id);
-- at most one active refund chain total ≤ original amount is enforced in application under row lock

ALTER TABLE payment_events ADD COLUMN signature_valid boolean NOT NULL DEFAULT true, ADD COLUMN payment_id uuid REFERENCES payments(id);

/**
 * A method is offered only when EVERY approval is recorded for (provider, method, country, mode):
 *   athosbet_eligible   – AthosBet holds the licence / is eligible to offer the method there
 *   regulatory_approved – legal sign-off for the applicable regulation in that country
 *   gateway_approved    – the gateway commercially approved AthosBet for the method (MCC 7995)
 * plus enabled = true. Real-money rows are additionally gated by REAL_MONEY_ENABLED and licensing.
 */
CREATE TABLE payment_method_eligibility (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             text NOT NULL,
  method               text NOT NULL CHECK (method IN ('PIX','CREDIT_CARD','DEBIT_CARD','BOLETO','BANK_TRANSFER','CRYPTO')),
  country              text NOT NULL CHECK (country = '*' OR country ~ '^[A-Z]{2}$'),
  mode                 text NOT NULL CHECK (mode IN ('SANDBOX','REAL')),
  currency             text NOT NULL,
  directions           text[] NOT NULL DEFAULT ARRAY['DEPOSIT','WITHDRAWAL','REFUND'],
  priority             integer NOT NULL DEFAULT 100,
  athosbet_eligible    boolean NOT NULL DEFAULT false,
  regulatory_approved  boolean NOT NULL DEFAULT false,
  gateway_approved     boolean NOT NULL DEFAULT false,
  enabled              boolean NOT NULL DEFAULT false,
  min_amount           bigint NOT NULL DEFAULT 100 CHECK (min_amount > 0),
  max_amount           bigint NOT NULL DEFAULT 1000000 CHECK (max_amount >= min_amount),
  evidence             text,
  updated_by           uuid REFERENCES users(id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, method, country, mode),
  CHECK (NOT enabled OR (athosbet_eligible AND regulatory_approved AND gateway_approved))
);

CREATE TABLE payment_reconciliation_runs (
  id           bigserial PRIMARY KEY,
  provider     text NOT NULL,
  status       text NOT NULL CHECK (status IN ('OK','MISMATCH','ERROR')),
  checked      integer NOT NULL DEFAULT 0,
  mismatches   jsonb NOT NULL DEFAULT '[]',
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

ALTER TABLE teams ADD COLUMN primary_color text, ADD COLUMN secondary_color text, ADD COLUMN crest_pattern text CHECK (crest_pattern IN ('solid','stripes','hoops','sash','halves')), ADD COLUMN logo_source text;
