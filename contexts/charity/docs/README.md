# charity

The catalogue of charities and causes, and the Pledge sync that fills it. Ported from LazyTax
`Domain/{Charity,Cause}` and `App/Modules/{Charities,Causes}`. Global data: no row belongs to a user.

- Contract: `charity.v1` (`get`, `exists`, `search`, `getMany`, `externalId`, `getCause`, `causeKeys`).
- Event: `charity.deleted { charityId }`, written to the outbox in the delete's transaction.
- Routes (LazyTax paths): `/api/v1/Charity`, `/api/v1/Causes`, `/api/v1/charities/sync/pledge`. Reads are public, writes admin.
- MCP: `charity.search`, `charity.get`, `charity.searchCauses`, `charity.create`, `charity.setCauses`, `charity.syncPledge`.
- Pledge is a fake gateway with no network. Its fixture is config: `LAZYTAX_CHARITY_CONFIG='{"pledge":{"causes":[...],"organizations":[...]}}'`.
- The Pledge donation calls (`CreateDonation`, `GetDonations`) are not here; they belong to disbursement.

## Changed from LazyTax

- **No ownership layer.** Charities and causes are shared data, so repositories take no `Owner`. The owner-scoped 404 test becomes: an unknown or malformed id is 404 on every entity, and every write is 401/403 for non-admins.
- **`purgeUser` does nothing.** There is no `user_id` anywhere in the schema; a test asserts that and that a user deletion leaves the catalogue untouched.
- **A charity id that is not a uuid is 404** (LazyTax's `{id:guid}` route constraint), not a 500.
- **Deleting a charity emits `charity.deleted`.** LazyTax relied on database foreign keys from other areas; here other contexts hold only a copy of the id and react to the event. Cause links and outside ids still cascade.
- **Searches are ordered** (`name, id`), so paging is stable. LazyTax had no ORDER BY.
- **URLs are capped at 512 characters** in the request schema (the column limit); LazyTax let a longer one reach the database as a 500.
- **Duplicate cause key** is 409 `entity_conflict` through `ON CONFLICT DO NOTHING`, not a caught exception (an exception would poison the open transaction).
- **Bulk upsert and set-causes are one unit of work** each; the Pledge fetch runs outside any unit, each batch write is its own.
- **Added to the contract beyond the minimum:** `getMany`, `externalId` (disbursement needs the Pledge organisation id), `getCause`, `causeKeys`.
