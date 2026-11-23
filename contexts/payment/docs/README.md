# payment

The user's Airwallex customer, their purpose-scoped consents (penalty, subscription), and
merchant-initiated charges against a stored consent. Port of LazyTax `App/Modules/Payment` and
`Domain/Payment`.

- **Contract:** `payment.v1` (`contract/v1/index.ts`): `hasConsent`, `charge`, `revokeAll`,
  `getConsent`, `getCharge`.
- **Events:** `payment.completed`, `payment.failed`, `payment.consentChanged`.
- **Needs:** `notification.v1` (the consent-changed email).
- **Tables:** `payment.customers`, `payment.consents`, `payment.charges`.
- **Gateway:** `FakeAirwallexGateway` (in memory, no network). Its test hooks are listed at the top
  of `src/domain/gateway.ts`.

## Routes (`/api/v1/Payment`)

| Method | Path                         | Policy     | Subject |
| ------ | ---------------------------- | ---------- | ------- |
| PUT    | `/{userId}/customers`        | registered | userId  |
| GET    | `/{userId}/client-secret`    | registered | userId  |
| GET    | `/{userId}/consent?purpose=` | registered | userId  |
| DELETE | `/{userId}/consent?purpose=` | registered | userId  |
| POST   | `/{userId}/intent`           | registered | userId  |
| POST   | `/{userId}/intent/{intentId}`| registered | userId  |
| POST   | `/webhook`                   | public     | (HMAC)  |

MCP tools: `payment.createCustomer`, `payment.getConsent`, `payment.disableConsent`.

## How a charge works (`payment.v1 charge`)

It copies nitroso's 3-phase gateway call (`zinc/Domain/Withdrawal/Service.cs` Approve):

1. **Claim**, in one unit of work: insert or lock the `payment.charges` row for `requestId`. A row
   that already succeeded is returned as is. A row that is processing or pending keeps its attempt
   (a re-drive). Any other row starts attempt + 1. With no verified consent the result is
   `no_consent` and nothing is sent.
2. **Gateway**, outside any unit: with an intent already recorded, retrieve it and confirm it
   unless it already succeeded. Otherwise create one with the key `<requestId>-<attempt>`, store
   its id, then confirm it.
3. **Write back**, in one unit of work, only if the claim still holds (same attempt, not already
   succeeded). Emit `payment.completed` (once per request) or `payment.failed` (declined).

Only a definitive rejection of a first send, before any intent exists, counts as `declined`.
Every other failure is `pending`, and the caller retries with the same `requestId`.

## Changed from LazyTax

- **The charge is owned by payment.** LazyTax's `ChargeStoredConsentAsync` took the penalty's
  `existingIntentId` and an `onIntentCreated` callback, so penalty stored the intent id. Now
  payment keeps its own `payment.charges` row per `requestId` and reconciles the intent itself.
  Callers pass only a stable `requestId`.
- **Idempotency key per attempt.** The key is `<requestId>-<attempt>` (nitroso), not the bare
  penalty id. A declined attempt can be retried without the gateway rejecting a duplicate request id.
- **Money is integer cents** in the contract. The HTTP routes keep LazyTax's decimal `amount`.
- **Webhook signature:** HMAC over the raw body (LazyTax re-serialised the parsed JSON), compared
  in constant time (LazyTax used `==`), and `x-timestamp` must be within 300 s (LazyTax had no
  check). A bad or stale signature is 403 `webhook_signature_invalid`.
- **`payment_intent.succeeded` webhook is handled.** It settles a pending charge and emits
  `payment.completed`. In LazyTax this branch was commented out.
- **Logto claim `has_payment_consent` is not set.** It was an HTTP call to Logto. Payment now
  emits `payment.consentChanged {userId, purpose, linked}` instead, and account (or a later Logto
  adapter) can subscribe to it.
- **Confirming an intent checks ownership.** `POST /{userId}/intent/{intentId}` returns 404
  unless the intent belongs to the caller's customer. LazyTax confirmed any intent id.
- **Account deletion:** `revokeAll` runs as the kernel's `beforePurge` hook (outside the
  transaction, best effort). `purgeUser` deletes the customer and consents and anonymises the
  charge ledger (`user_id = 'deleted-user'`), so no row of the user is left in `payment.*`.
- **Consent-changed email** goes through `notification.v1 email('payment-consent-changed')`,
  inside the unit of work, so it leaves through the outbox after commit.
- **Isolation:** payment runs at the kernel default, READ COMMITTED, and needs nothing more: the
  charge row is locked with `SELECT ... FOR UPDATE` in the claim and the write-back. Those two
  units also retry up to 6 times on 40001/40P01 (several callers may charge one `requestId` at
  once), on top of the kernel's own retries.
- **`needs` drops `account.v1`** (lanes.md lists it): payment never calls it. Add it back with the
  Logto-claim follow-up if that lands here.

## Tests

- `tests/unit`: the service with fakes (charge outcomes, exactly-once, consents, webhook signature).
- `tests/integration/service-db.test.ts`: the repository and service on Postgres (concurrent
  charges, owner scoping, purge).
- `tests/integration/app.test.ts`: the app with `payment` and `account` loaded (401, 403, 404,
  owner-scoped 404s, webhook, MCP, contract, `DELETE /api/v1/User/Me`).
- `tests/sit`: Bruno. The webhook case signs its body with the dev secret
  (`dev-airwallex-webhook-secret`, or env var `paymentWebhookSecret`).
