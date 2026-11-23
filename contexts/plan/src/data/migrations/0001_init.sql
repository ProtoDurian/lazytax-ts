-- plan: one subscription per user (LazyTax UserSubscriptions) and an audit of tier changes.
CREATE TABLE plan.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL UNIQUE,
  tier text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending_activation', 'active', 'grace', 'cancelled')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  next_tier text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Who changed a subscription's tier. Owned through the chain change -> subscription -> user_id.
CREATE TABLE plan.subscription_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES plan.subscriptions (id) ON DELETE CASCADE,
  from_tier text NOT NULL,
  to_tier text NOT NULL,
  changed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_changes_subscription ON plan.subscription_changes (subscription_id, created_at);
