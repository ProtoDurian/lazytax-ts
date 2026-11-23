-- The in-app inbox (LazyTax InboxNotifications). Deleted with its recipient's or its actor's account.
CREATE TABLE notification.inbox_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  kind varchar(32) NOT NULL,
  title varchar(256) NOT NULL,
  body varchar(1024) NOT NULL,
  actor_user_id text,
  data varchar(2048),
  dedupe_key varchar(128),
  created_at timestamptz NOT NULL,
  read_at timestamptz
);
CREATE INDEX inbox_notifications_user_id ON notification.inbox_notifications (user_id, created_at DESC, id DESC);
CREATE INDEX inbox_notifications_actor_user_id ON notification.inbox_notifications (actor_user_id) WHERE actor_user_id IS NOT NULL;
-- Posting the same key to the same user twice records it once.
CREATE UNIQUE INDEX inbox_notifications_dedupe ON notification.inbox_notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
