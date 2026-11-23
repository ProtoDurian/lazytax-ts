-- One proof per habit. user_id is a copy of the habit's owner (a habit lives in another context).
CREATE TABLE proof.proof_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  habit_id uuid NOT NULL UNIQUE,
  plugin_key text NOT NULL,
  plugin_version integer NOT NULL,
  settings text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proof_bindings_user_id ON proof.proof_bindings (user_id, plugin_key);

-- The tag id is embedded in the physical tag's URL (lazytax.club/t/{id}); first come, first served.
CREATE TABLE proof.nfc_tags (
  id text PRIMARY KEY CHECK (char_length(id) <= 64),
  user_id text NOT NULL,
  habit_id uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nfc_tags_user_id ON proof.nfc_tags (user_id);

-- A user's Strava link. Tokens are encrypted at rest. Deleted on disconnect, deauthorize and
-- account purge, as Strava's terms require. refresh_lease_until is the refresh claim: HTTP never
-- runs inside a transaction, so the lock that used to be a row lock is a short lease.
CREATE TABLE proof.strava_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL UNIQUE,
  athlete_id bigint NOT NULL UNIQUE,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  scope text NOT NULL,
  refresh_lease_until timestamptz,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Webhook events waiting for the worker, so the webhook answers within Strava's 2 seconds.
-- A row is deleted once processed (IDs only, no Strava data). No user_id: an event names a Strava
-- athlete, and the athlete's user is found when the event is processed.
CREATE TABLE proof.strava_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type text NOT NULL,
  aspect_type text NOT NULL,
  object_id bigint NOT NULL,
  owner_id bigint NOT NULL,
  event_time timestamptz NOT NULL,
  deauthorized boolean NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  claimed_until timestamptz,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX strava_events_claim ON proof.strava_events (received_at);
