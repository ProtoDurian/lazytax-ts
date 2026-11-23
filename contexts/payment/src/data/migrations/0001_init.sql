-- LazyTax PaymentCustomers + PaymentConsents, plus the charge ledger the 3-phase charge needs.

CREATE TABLE payment.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  airwallex_customer_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customers_user_id ON payment.customers (user_id);
CREATE UNIQUE INDEX customers_airwallex_customer_id ON payment.customers (airwallex_customer_id);

-- At most one consent per (customer, purpose). user_id is a copy, so every read filters on it.
CREATE TABLE payment.consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES payment.customers (id) ON DELETE CASCADE,
  user_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('penalty', 'subscription')),
  consent_id text NOT NULL,
  status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX consents_customer_purpose ON payment.consents (customer_id, purpose);
CREATE INDEX consents_user_id ON payment.consents (user_id);

-- One row per logical charge (the caller's request id, e.g. a penalty id).
CREATE TABLE payment.charges (
  request_id text PRIMARY KEY,
  user_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('penalty', 'subscription')),
  description text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'succeeded', 'pending', 'declined', 'no_consent')),
  attempt integer NOT NULL DEFAULT 0,
  intent_id text,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX charges_user_id ON payment.charges (user_id);
