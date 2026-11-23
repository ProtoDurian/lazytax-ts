# penalty

The charity stakes a user owes for missed checks, the drain that charges them, and the
per-(charity, currency) accrual ledger. Ported from LazyTax `Domain/Penalty`,
`App/Modules/Penalty` and `Domain/Check/PenaltyStakeBinding.cs`.

## What it does

| Part                     | What                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `check.settled`          | a missed check with a money stake and a charity enqueues one `pending` penalty (`stake * ratioBps / 10000`, exact cents), once per execution          |
| worker `process` (15 min) | claims a batch (`pending`, or `processing` older than the 10 min lease) with `FOR UPDATE SKIP LOCKED`, charges each through `payment.v1` outside any unit, then settles each row in its own unit |
| settle                   | `succeeded` -> `charged` + charity credit + `penalty.charged`; `pending` -> retry; `no_consent` -> `skipped`; `declined`/error -> retry, `failed` at 5 attempts (+ `penalty.failed`); notification turns both events into the email and the inbox row |
| `payment.completed`      | a penalty charge that settled later is marked `charged` (a no-op when the drain already did)                                                           |
| `deleteGuard`            | blocks account deletion with 409 `account_deletion_blocked` while anything is owed                                                                    |
| `purgeUser`              | anonymise-retain: the user's rows get `user_id = 'deleted-user'`; amounts, charity, intent ids stay                                                    |
| `penalty.v1`             | `outstanding`, `charityBalances`, `search`, `get`, and the payout methods disbursement uses (`payoutCandidates`, `claimForPayout`, `releasePayout`)  |

## Routes (`/api/v1/Penalty`)

| Route                           | Policy                   |
| ------------------------------- | ------------------------ |
| `GET /:userId`                  | registered, subject      |
| `GET /:userId/outstanding`      | registered, subject      |
| `GET /:userId/:id`              | registered, subject      |
| `GET /admin/search`             | admin                    |
| `GET /admin/charity-balances`   | admin                    |
| `POST /admin/process`           | admin                    |

MCP: `penalty.search`, `penalty.get`, `penalty.outstanding`, `penalty.charityBalances`.

Config (`LAZYTAX_PENALTY_CONFIG`): `batchSize` 100, `maxAttempts` 5, `claimLeaseMs` 600000,
`blockDeletionOnDebt` true, `everyMs` 900000.

## Changed from LazyTax

- **New routes and MCP tools.** LazyTax had no penalty controller; the routes above are new.
- **Debt = penalties not charged.** LazyTax 1.43.2 counted every failed staked execution with
  `PaymentProcessed = false`, a flag nothing ever set, so a user was in debt forever. Here debt is
  every penalty that is not `charged` (pending, processing, failed, skipped), as LazyTax's later
  fix `6218056` does. A failed day with a stake but no charity makes no penalty row, so it is not
  debt here (in LazyTax it was).
- **Deletion keeps the ledger.** LazyTax's purge left a no-op seam (`AnonymizePenaltyLedger`); here
  the purge anonymises the rows instead of deleting them. Deletion is blocked while debt is open.
- **No foreign keys.** Charity, execution and habit ids are copies. LazyTax's `ON DELETE CASCADE`
  from charity to penalties (deleting a charity deleted its money ledger) is gone; `charity.deleted`
  is not handled.
- **Status is text** (`pending`, `processing`, `charged`, `failed`, `skipped`), not an int.
- **Payment owns the gateway phases.** LazyTax's penalty service passed `existingIntentId` and an
  `onIntentCreated` callback to Airwallex. Here penalty calls `payment.charge` with its own id as
  the `requestId`; payment keeps the intent and its idempotency key `<requestId>-<attempt>`.
  `payment.failed` is not subscribed: the drain already counts each declined attempt.
- **Notifications leave through events.** LazyTax's penalty service emailed directly after the
  save, best effort. Here penalty only emits `penalty.charged` / `penalty.failed` in the settle's
  unit of work; notification subscribes and writes the email and the inbox row. So penalty does
  not need `notification.v1` (lanes.md listed it). The events carry `charityName` (looked up in
  `charity.v1`) for the receipt; `HabitName` is gone (penalty does not need habit).
- **Charity balance credit is an upsert** (`ON CONFLICT ... accrued_cents + EXCLUDED`) instead of a
  `SELECT ... FOR UPDATE` then insert, so two first credits of one charity no longer collide.
- **No in-process overlap gate.** The kernel skips a worker tick while the previous one still runs.

## Isolation

Penalty does not rely on repeatable read. It runs on the kernel default (READ COMMITTED): the
drain claims with `FOR UPDATE SKIP LOCKED`, a settle takes `SELECT ... FOR UPDATE` on the row
before it reads the status (so a racing settle sees `charged` and does nothing), and the charity
credit is one upsert.
