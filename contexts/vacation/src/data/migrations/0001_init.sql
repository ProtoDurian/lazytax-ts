-- vacation: the user's vacation windows (LazyTax VacationPeriods). Dates are user-local days.
CREATE TABLE vacation.vacation_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  timezone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_date <= end_date)
);
CREATE INDEX vacation_periods_user_start ON vacation.vacation_periods (user_id, start_date);
