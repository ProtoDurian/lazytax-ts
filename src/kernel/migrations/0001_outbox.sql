-- The kernel's own tables, in schema kernel (created by the migration runner).
CREATE TABLE kernel.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  payload jsonb NOT NULL,
  user_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per (event, subscriber): LazyTax's CheckEventDeliveries.
CREATE TABLE kernel.outbox_deliveries (
  event_id uuid NOT NULL REFERENCES kernel.outbox_events (id) ON DELETE CASCADE,
  subscriber text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, subscriber)
);

CREATE INDEX outbox_deliveries_due ON kernel.outbox_deliveries (next_at) WHERE status = 'pending';
