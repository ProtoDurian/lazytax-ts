# notification

The user's in-app inbox and the transactional emails. Port of LazyTax `App/Modules/Notification`
and `Domain/Notification`.

## What it provides

`notification.v1` (see `contract/v1/index.ts`):

| Method                                                              | What it does                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| `post(userId, kind, title, body, actorUserId?, data?, dedupeKey?)`  | Puts a row in the user's inbox. Joins the caller's transaction. |
| `email(userId, template, data?)`                                    | Queues an email through the outbox. Never throws on delivery.   |
| `unreadCount(userId)`                                               | Unread inbox rows.                                              |

## Routes (`/api/v1/Inbox`, policy `registered`, subject `userId`)

| Route                                  | Result                                              |
| -------------------------------------- | --------------------------------------------------- |
| `GET /{userId}?unreadOnly&limit&skip`  | Newest first. Limit 1..50 (default 20), skip >= 0.  |
| `GET /{userId}/unread-count`           | `{ count }`                                         |
| `POST /{userId}/{id}/read`             | 204 (also when already read), 404 when not theirs.  |
| `POST /{userId}/read-all`              | `{ count }` = how many were unread, now read.       |

MCP tools (prefix `notification`): `list`, `unreadCount`, `markRead`, `markAllRead`. Same service
methods as the routes.

## Events

| Event                            | Direction | What happens                                            |
| -------------------------------- | --------- | ------------------------------------------------------- |
| `penalty.charged` / `penalty.failed` | in    | An inbox row and an email, once per event.              |
| `account.userCreated`            | in        | The welcome email.                                      |
| `notification.emailRequested`    | own       | The send: render, write to the fake SMTP file.          |

The penalty payloads are the typed `penalty.charged` / `penalty.failed` events from penalty's contract.

## Data

Schema `notification`, one table `inbox_notifications`. Posting the same `dedupeKey` to the same
user twice records it once (unique index on `(user_id, dedupe_key)`). Purge deletes rows where the
user is the recipient **or the actor**.

## Email

Templates are small HTML bodies in `src/email/templates.ts` (subjects as in LazyTax). A missing
variable fails the render and the email is skipped and logged (never a `{{` in a user's inbox).
The only SMTP adapter is a fake that appends one JSON line per message to
`smtp.file` (config; env `LAZYTAX_NOTIFICATION_CONFIG`; default under the OS temp folder).

## Changed from LazyTax

- **Email goes through the outbox.** LazyTax's `IEmailNotifier` is called by the caller after its
  money write. Here `email(...)` writes an outbox row in the caller's transaction and the send
  happens after commit (no network inside a unit of work). Delivery is at least once; the fake
  transport is idempotent by event id.
- **One generic `email(userId, template, data)`** replaces the nine `Notify*` methods. The caller
  passes the template's variables as strings. `UserName`, `BaseUrl` and `SupportEmail` are always
  filled in by notification (the recipient's name and address come from `account.v1`).
- **No charity or habit lookups.** `EmailNotifier` read the charity and habit repositories for the
  names. notification only needs `account`, so the emails always use the LazyTax fallback names
  "your chosen charity" / "your habit" (the penalty event carries ids only).
- **Welcome email from an event.** LazyTax passed the email address at sign-up. Here it reacts to
  `account.userCreated` and reads the profile.
- **Penalty inbox rows are new.** LazyTax only emailed penalties; `penalty_charged` and
  `penalty_failed` inbox kinds are added (the brief asks for email + inbox).
- **Data is posted as an object** and stored as JSON text; the HTTP response still returns the
  JSON text in `data`, as LazyTax does.
- **Bad ids.** A non-uuid `{id}` is a 404 (LazyTax's route constraint gave a 404 too, from routing).
- **The actor foreign key is gone** (no cross-context FK). Purge deletes by `actor_user_id`
  instead of a cascade.
- **Email templates** are plain HTML strings, not the React Email build.
