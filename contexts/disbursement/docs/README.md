# disbursement

The charity payout. Charged penalties are grouped by (charity, currency) and donated to the
charity's Pledge organization. Ported from LazyTax `Domain/Disbursement`, `App/Modules/Disbursement`.

- Route: `POST /api/v1/disbursement/run` (admin). MCP: `disbursement.run`.
- Worker `payout`, daily, runs only when config `enabled` is true (default false, as in LazyTax).
- Config (env `LAZYTAX_DISBURSEMENT_CONFIG`): `enabled`, `minPayoutCents`, `maxGroupsPerRun`, `everyMs`,
  `reconcileLeaseMs`, `donorFirstName`, `donorLastName`, `donorEmail`.
- Contract `disbursement.v1`: `processPending(opts?)`, `get(id)`. Events: `disbursement.completed`, `disbursement.failed`.
- Table `disbursement.disbursements` (no `user_id`: a payout sums many users' penalties, so nothing to purge).

## How a pass runs
1. Reconcile pending rows older than the lease: ask the vendor by reference; found = completed, conclusively missing = released, inconclusive = stays pending.
2. Claim, in ONE unit of work: `penalty.payoutCandidates` (locks rows) -> per group a pending row + `penalty.claimForPayout`.
3. Donate OUTSIDE any unit of work (HTTP). 4xx = `DonationRejected` = release; anything else = ambiguous = stay pending.
4. Mark completed / failed, each in its own unit of work, row-locked and idempotent.

## Changed from LazyTax
- **Penalties are reached through `penalty.v1`** (`payoutCandidates`, `claimForPayout`, `releasePayout`) instead of reading and stamping the `Penalties` table. The claim lock now lives in penalty.
- **The charity's Pledge org id comes from `charity.v1.externalId(id, 'pledge')`** instead of a join on the charity external-ids table. Charity picks the newest link deterministically.
- **No foreign keys** from `disbursements` to charity or penalty (the model forbids cross-schema keys); the claim check is the equal-sum assertion inside the claim unit.
- **Pledge is a fake gateway** with no network (`adapters/fake-pledge-gateway.ts`). Tests steer it.
- **Completed and failed emit outbox events** (`disbursement.completed`, `disbursement.failed`); LazyTax emitted none.
- **Config is zod config** (`LAZYTAX_DISBURSEMENT_CONFIG`) instead of `appsettings` `Disbursement`; the donor defaults are unchanged. The first tick comes after `everyMs`, not after 5 minutes.
- **Overlap gate**: the in-process semaphore is gone; the row lock in the claim already prevents double payout across replicas.
- `purgeUser` is a registered no-op: no row is a user's.
