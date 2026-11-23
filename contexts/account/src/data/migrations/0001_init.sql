-- account: users (id = the JWT sub) and their configuration (LazyTax Users, Configurations).
CREATE TABLE account.users (
  id text PRIMARY KEY,
  username text NOT NULL,
  email text NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  scopes text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX users_username ON account.users (username) WHERE username <> '';
CREATE INDEX users_username_lower ON account.users (lower(username) text_pattern_ops);

CREATE TABLE account.configurations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL UNIQUE,
  timezone text NOT NULL,
  end_of_day time NOT NULL DEFAULT '00:00:00',
  default_charity_id uuid
);
