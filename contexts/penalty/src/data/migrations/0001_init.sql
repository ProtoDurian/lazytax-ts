-- penalty: one row per missed, staked check execution (LazyTax Penalties) and the per-(charity,
-- currency) accrual ledger (LazyTax CharityBalances). No foreign keys into other schemas: the
-- execution, habit, user and charity ids are copies.
CREATE TABLE penalty.penalties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  habit_execution_id uuid NOT NULL,
  habit_id uuid NOT NULL,
  user_id text NOT NULL,
  charity_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency varchar(8) NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'charged', 'failed', 'skipped')),
  payment_intent_id varchar(256),
  attempts integer NOT NULL DEFAULT 0,
  last_error varchar(2048),
  -- NULL while charged = pending payout; set once a disbursement claimed it.
  payout_disbursement_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Exactly once per execution: the idempotency key of the check.settled subscriber.
CREATE UNIQUE INDEX penalties_habit_execution_id ON penalty.penalties (habit_execution_id);
CREATE INDEX penalties_user_id ON penalty.penalties (user_id, created_at DESC);
-- The drain claim: pending (or stale processing) oldest first.
CREATE INDEX penalties_status_created ON penalty.penalties (status, created_at);
-- The payout scan: charged and not yet claimed.
CREATE INDEX penalties_payout ON penalty.penalties (charity_id, currency)
  WHERE status = 'charged' AND payout_disbursement_id IS NULL;
CREATE INDEX penalties_payout_disbursement ON penalty.penalties (payout_disbursement_id)
  WHERE payout_disbursement_id IS NOT NULL;

CREATE TABLE penalty.charity_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charity_id uuid NOT NULL,
  currency varchar(8) NOT NULL,
  accrued_cents bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (charity_id, currency)
);
