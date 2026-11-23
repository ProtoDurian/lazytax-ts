# proof

Proof plugins (manual, nfc, strava), proof bindings, NFC tags and the Strava link. Ported from LazyTax
`App/Modules/{Proof,NfcTag,Strava}` and `Domain/{Proof,NfcTag,Strava}`.

- Contract: `proof.v1` (`route`, `listPlugins`, `getBinding`, `listPluginKeys`, `listTaggedHabits`).
- Needs: `account.v1` (NFC resolve's "today"), `plan.v1` (`ensureTier` for a plugin's `minTier`), `habit.v1`
  (ownership, current version), `check.v1` (`pendingCheckAt`, `report`, `executionForDate`).
- Routes (`/api/v1`): `Proof/plugins`, `Proof/{userId}/{habitId}` get, bind (PUT), unbind;
  `NfcTag/{userId}/{tagId}` link (PUT), resolve (GET), unlink; `Strava/connect-url/{userId}`, `Strava/callback`,
  `Strava/{userId}` status and disconnect, `Strava/webhook` (GET challenge, POST event).
- MCP: `proof.plugins|binding|bind|unbind|nfcLink|nfcResolve|stravaStatus|stravaDisconnect`.
- Events: emits `proof.evidenceRevoked {userId, proofKey, externalId|null}`; subscribes to `habit.deleted`.
- Worker: `strava-inbox` (every 20 s, only when Strava is on) drains the webhook inbox.
- Purge: `purgeUser` deletes bindings, NFC tags, the Strava connection and queued Strava events;
  `beforePurge` (best effort, outside any unit) revokes LazyTax at Strava.
- Config (`LAZYTAX_PROOF_CONFIG='{"strava":{"enabled":true}}'`): `strava.enabled` (default false, as LazyTax),
  `clientId`, `clientSecret` (also signs the connect state), `verifyToken`, `webhookSecret`,
  `webhookToleranceSec` (300), `encryptionKey`, `subscriptionId`, `callbackUrl`, `appRedirectUri`,
  `maxAttempts` (5), `pollMs`, `stateLifetimeMinutes`. The defaults are development values: set your own.
- Gateway: Strava is a fake with no network (`src/gateways/strava-fake.ts`; the code `athlete-<id>` grants that
  athlete). The real HTTP adapter is not part of this build.

## Changed from LazyTax

- **Webhook is signed.** LazyTax trusted unsigned Strava events and relied on fetching the activity with the
  owner's own token. Now `POST Strava/webhook` needs `X-Lazytax-Timestamp` (unix seconds) and
  `X-Lazytax-Signature` (hex HMAC-SHA256 of `<timestamp>.<raw body>` with `strava.webhookSecret`). The compare
  is constant time, the timestamp must be within `webhookToleranceSec` of now (a replay or a future stamp is
  refused), and a bad or missing signature is 403. Strava itself does not sign, so a signing proxy in front of
  the endpoint is expected. A signed but unreadable body is still answered 200 and dropped, as LazyTax did.
- **No HTTP inside a transaction, so the refresh lock is a lease.** LazyTax held a `FOR UPDATE` row lock across
  the token-refresh HTTP call. Now a worker takes a short `refresh_lease_until` claim in its own statement,
  calls Strava outside any unit, then saves the tokens and clears the lease. A second worker that finds the
  lease held fails the event, which the inbox retries after its lease; a worker that finds the tokens already
  fresh uses them. Two workers never spend the same single-use refresh token.
- **Ownership on the first read.** Every repository read takes an `Owner`. LazyTax's router compared
  `binding.UserId != e.UserId` after loading the binding by habit id; now the binding is read scoped to the
  event's user. The NFC claim is one `INSERT ... ON CONFLICT ... WHERE user_id = me` statement, so two users
  racing for a tag cannot both win and a foreign tag never loads.
- **Cross-context reads are contracts, not joins.** `proof_bindings` keeps a copy of the habit's `user_id`
  instead of joining `Habits`. "Non-deleted habit" filters moved to `habit.deleted`: proof deletes the binding
  and releases the NFC tags of a deleted habit (LazyTax joined `Habits.DeletedAt` on every read).
- **NFC "today's execution" comes from check.** LazyTax's repository read `HabitExecutions`; now
  `check.executionForDate`.
- **Strava evidence goes through an event.** LazyTax deleted `HabitEvidence` rows directly (disconnect,
  deauthorize, activity deleted in Strava). Now proof emits `proof.evidenceRevoked` in the same unit as its own
  deletes and check removes the rows after commit, at least once. The day the evidence proved stays done.
  An activity-deleted event is scoped to the athlete's user (LazyTax matched by activity id across all users).
- **Tokens are encrypted by proof** (AES-256-GCM, `strava.encryptionKey`) because the kernel has no
  `IEncryptor`.
- **New `nfc` plugin and `POST NfcTag/{userId}/{tagId}/tap`.** LazyTax resolved the tag in the app and then
  pressed Complete (manual). The lane asks for an `nfc` plugin, so a tap now routes through `proof.v1.route`
  with evidence key `nfc`. The old resolve-then-complete path still works. The plugin is always-bound, so it
  shows in `Proof/plugins` with `alwaysBound: true` (the app must not offer it as a bindable proof).
- **A disabled habit does not stop other habits.** On an untargeted event (a Strava activity) a bound habit that
  check calls 404 (switched off) is skipped; LazyTax's router returned the first failure and dropped the rest.
  A targeted event still gets the 404.
- **Bind runs under the user lock** so two concurrent binds of one habit leave one row (LazyTax relied on the
  unique index and returned a 500 to the loser).
- **Strava endpoints return 404 when `strava.enabled` is false**, as LazyTax; the strava plugin is also left
  out of `Proof/plugins`.
- **`{habitId}` that is not a uuid is 404** (LazyTax's `:guid` route constraint); validation errors are the
  kernel's `validation_error` (zod) instead of FluentValidation messages, with the same rules.
