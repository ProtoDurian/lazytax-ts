-- protection: the user-level freeze pool, the per-day consumption log, the weekly award ledger
-- and the settled-day ledger protection keeps from check.settled (so it never reads check's tables).

-- LazyTax UserProtections. One row per user.
CREATE TABLE protection.user_protections (
  user_id text PRIMARY KEY,
  freeze_current integer NOT NULL DEFAULT 0 CHECK (freeze_current >= 0),
  -- The user's max streak across habits as check last reported it (check.settled maxStreak).
  max_streak integer NOT NULL DEFAULT 0 CHECK (max_streak >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- LazyTax FreezeConsumptions: exactly one freeze per user-local day.
CREATE TABLE protection.freeze_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  date date NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, date)
);
CREATE INDEX freeze_consumptions_user_id ON protection.freeze_consumptions (user_id);

-- LazyTax FreezeAwards: one award per habit per week (idempotency ledger).
CREATE TABLE protection.freeze_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  habit_id text NOT NULL,
  week_start date NOT NULL,
  awarded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (habit_id, week_start)
);
CREATE INDEX freeze_awards_user_id ON protection.freeze_awards (user_id);

-- New in the model: one row per settled execution, from check.settled. A habit's week is perfect
-- when it has settled days and every one is completed.
CREATE TABLE protection.settled_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  habit_id text NOT NULL,
  execution_id text NOT NULL UNIQUE,
  date date NOT NULL,
  status text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settled_days_user_date ON protection.settled_days (user_id, date);
