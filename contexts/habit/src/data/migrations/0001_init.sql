-- habit: routines, habits and their versions (LazyTax Routines, Habits, HabitVersions).
-- A habit is the stable identity with a current-version pointer; every update writes a new version.
-- Deletes are soft (deleted_at), as in LazyTax. No foreign key leaves this schema: the charity id
-- is a plain uuid that charity.v1 vouches for at write time.

CREATE TABLE habit.routines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX routines_user_id ON habit.routines (user_id, created_at, id);

CREATE TABLE habit.habits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  -- Current version pointer.
  version integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  -- Position in the user's habit list. Ties are broken by id.
  sort_order integer NOT NULL DEFAULT 0,
  routine_id uuid REFERENCES habit.routines (id),
  deleted_at timestamptz
);
CREATE INDEX habits_user_id ON habit.habits (user_id, sort_order, id);
CREATE INDEX habits_routine_id ON habit.habits (routine_id);

CREATE TABLE habit.habit_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  habit_id uuid NOT NULL REFERENCES habit.habits (id),
  -- A copy of the habit's user_id, so the purge and the indexes need no join.
  user_id text NOT NULL,
  version integer NOT NULL,
  charity_id uuid,
  task text NOT NULL,
  days_of_week text[] NOT NULL,
  notification_time time NOT NULL,
  deadline_time time NOT NULL DEFAULT '23:59',
  stake_cents integer NOT NULL DEFAULT 0,
  stake_currency text NOT NULL DEFAULT 'USD',
  ratio_basis_points integer NOT NULL DEFAULT 10000,
  timezone text NOT NULL,
  UNIQUE (habit_id, version)
);
CREATE INDEX habit_versions_user_id ON habit.habit_versions (user_id);
