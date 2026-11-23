-- check: daily checks, their settled executions and the evidence that settled them.
-- "check" is a reserved word, so the schema is always quoted.

-- One check per scheduled habit per user-local date (LazyTax HabitChecks).
CREATE TABLE "check".checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  habit_id uuid NOT NULL,
  local_date date NOT NULL,
  timezone text NOT NULL,
  opens_at timestamptz NOT NULL,
  deadline timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'missed', 'skipped', 'frozen', 'vacation')),
  settled_at timestamptz,
  settled_by text,
  execution_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (habit_id, local_date)
);
CREATE INDEX checks_user_id ON "check".checks (user_id, local_date);
CREATE INDEX checks_due ON "check".checks (deadline) WHERE status = 'pending';

-- The settled outcome of one check day (LazyTax HabitExecutions). The stake is copied from the
-- habit version at settle time, so debts and stakes never read habit's tables.
CREATE TABLE "check".executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  habit_id uuid NOT NULL,
  habit_version_id uuid NOT NULL,
  date date NOT NULL,
  status text NOT NULL CHECK (status IN ('done', 'missed', 'skipped', 'frozen', 'vacation')),
  completed_at timestamptz,
  notes text,
  payment_processed boolean NOT NULL DEFAULT false,
  stake_cents bigint NOT NULL DEFAULT 0,
  ratio_bps integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'SGD',
  charity_id uuid,
  -- false once habit says the habit was deleted: its history leaves streaks and searches.
  habit_live boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (habit_id, date)
);
CREATE INDEX executions_user_id ON "check".executions (user_id, date);

-- What a proof reported (LazyTax HabitEvidence). (habit_id, proof_key, external_id) makes a
-- replay change nothing.
CREATE TABLE "check".evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  habit_id uuid NOT NULL,
  check_id uuid NOT NULL REFERENCES "check".checks (id) ON DELETE CASCADE,
  proof_key text NOT NULL,
  external_id text NOT NULL,
  passed boolean NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  data text,
  UNIQUE (habit_id, proof_key, external_id)
);
CREATE INDEX evidence_user_id ON "check".evidence (user_id, proof_key);
