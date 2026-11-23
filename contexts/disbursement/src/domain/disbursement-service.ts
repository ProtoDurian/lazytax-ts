import type { DisbursementDto, DisbursementV1 } from '@lazytax/disbursement-contract/v1';
import { type Clock, type Logger, type Outbox, Owner, type UnitOfWork } from '@lazytax/kernel';
import type { DisbursementStore } from './disbursement-repository';
import type { ClaimedPayout, DisbursementRow, PayoutOptions } from './model';
import { type CharityTargets, type DonationGateway, DonationRejected, type PenaltyPayouts } from './ports';

export interface DisbursementDefaults extends PayoutOptions {
  // A pending disbursement still open after this long belongs to a crashed or hung pass and is
  // reconciled against the vendor.
  reconcileLeaseMs: number;
}

const toDto = (r: DisbursementRow): DisbursementDto => ({
  id: r.id,
  charityId: r.charityId,
  currency: r.currency,
  amountCents: r.amountCents,
  status: r.status,
  pledgeOrganizationId: r.pledgeOrganizationId,
  providerDonationId: r.providerDonationId,
  attempts: r.attempts,
  lastError: r.lastError,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const SYSTEM = Owner.system();

export class DisbursementService implements DisbursementV1 {
  constructor(
    private readonly store: DisbursementStore,
    private readonly penalty: PenaltyPayouts,
    private readonly charity: CharityTargets,
    private readonly gateway: DonationGateway,
    private readonly uow: UnitOfWork,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly defaults: DisbursementDefaults,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  async get(id: string): Promise<DisbursementDto | null> {
    const row = await this.store.get(SYSTEM, id);
    return row ? toDto(row) : null;
  }

  async processPending(opts: Partial<PayoutOptions> = {}): Promise<number> {
    const o: PayoutOptions = {
      donor: opts.donor ?? this.defaults.donor,
      minPayoutCents: opts.minPayoutCents ?? this.defaults.minPayoutCents,
      maxGroups: opts.maxGroups ?? this.defaults.maxGroups,
    };

    // 1) Reconcile first: settle (or release) what a previous pass created at the vendor but
    //    crashed before recording. Those rows already have their penalties stamped, so the claim
    //    below will not pick them up again.
    let completed = 0;
    try {
      completed += await this.reconcileInflight(o.maxGroups);
    } catch (e) {
      this.log.error('disbursement reconcile pass failed; continuing to claim', { error: String(e) });
    }

    // 2) Claim in one unit of work, then donate OUTSIDE any unit (HTTP).
    const claimed = await this.claimPending(o);
    for (const c of claimed) {
      try {
        completed += await this.donateOne(c, o);
      } catch (e) {
        // One group's unexpected throw must not strand the rest. It is AMBIGUOUS (it can happen
        // after the donation was accepted), so do NOT release: leave pending for reconciliation.
        this.log.error('donation threw; leaving pending for reconciliation', {
          disbursementId: c.disbursementId,
          error: String(e),
        });
      }
    }
    return completed;
  }

  // Locks the charged-but-unpaid penalties (penalty.payoutCandidates), then per group: a pending
  // disbursement row and the claim stamp on the penalties, atomically. Stamping at claim time is
  // what stops a concurrent or retried pass from selecting the same penalties twice.
  private claimPending(o: PayoutOptions): Promise<ClaimedPayout[]> {
    return this.uow.run(async () => {
      const groups = await this.penalty.payoutCandidates(o.minPayoutCents);
      const now = this.clock.now();
      const claimed: ClaimedPayout[] = [];
      for (const g of groups) {
        if (claimed.length >= o.maxGroups) break;
        const orgId = await this.charity.pledgeOrganizationId(g.charityId);
        if (!orgId || orgId.trim() === '') {
          // No Pledge org id: cannot donate. Leave unclaimed; it settles once the charity syncs.
          this.log.warn('skipping payout: no Pledge org id', { charityId: g.charityId, currency: g.currency });
          continue;
        }
        const id = this.newId();
        await this.store.insertPending(SYSTEM, {
          id,
          charityId: g.charityId,
          currency: g.currency,
          amountCents: g.amountCents,
          pledgeOrganizationId: orgId,
          now,
        });
        const stamped = await this.penalty.claimForPayout(id, g.charityId, g.currency);
        // The rows are locked, so the stamped sum must equal the candidate sum; if not, roll back.
        if (stamped !== g.amountCents) {
          throw new Error(`payout claim mismatch for charity ${g.charityId}: ${stamped} != ${g.amountCents}`);
        }
        claimed.push({
          disbursementId: id,
          charityId: g.charityId,
          currency: g.currency,
          amountCents: g.amountCents,
          pledgeOrganizationId: orgId,
        });
      }
      return claimed;
    });
  }

  private async donateOne(c: ClaimedPayout, o: PayoutOptions): Promise<number> {
    let donationId: string;
    try {
      const d = await this.gateway.createDonation({
        organizationId: c.pledgeOrganizationId,
        amountCents: c.amountCents,
        currency: c.currency,
        reference: c.disbursementId,
        donorFirstName: o.donor.firstName,
        donorLastName: o.donor.lastName,
        donorEmail: o.donor.email,
      });
      donationId = d.donationId;
    } catch (e) {
      // DEFINITIVE rejection (4xx): nothing was created, so releasing the penalties is safe.
      if (e instanceof DonationRejected) {
        await this.markFailed(c.disbursementId, e.message);
        return 0;
      }
      // AMBIGUOUS (5xx, timeout, network, bad body): it MAY have landed. Releasing would let the
      // next pass re-claim and donate AGAIN. Leave pending; reconcile looks it up by reference.
      this.log.warn('donation failed ambiguously; leaving pending for reconciliation', {
        disbursementId: c.disbursementId,
        error: String(e),
      });
      return 0;
    }
    return (await this.markDisbursed(c.disbursementId, donationId)) ? 1 : 0;
  }

  // For each in-flight (pending) disbursement past the lease, ask the vendor whether the donation
  // landed (matched by reference = disbursement id). If it did: completed, no re-donation. If it
  // conclusively did not: release the penalties for a clean retry. An inconclusive lookup leaves
  // the row pending.
  private async reconcileInflight(batchSize: number): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - this.defaults.reconcileLeaseMs);
    const stale = await this.store.listReconcilable(SYSTEM, cutoff, batchSize);
    let completed = 0;
    for (const d of stale) {
      try {
        const found = await this.gateway.findDonationByReference(d.id);
        if (found) {
          if (await this.markDisbursed(d.id, found.donationId)) completed++;
        } else {
          await this.markFailed(d.id, 'reconcile: no donation found at provider; released for retry');
        }
      } catch (e) {
        this.log.warn('reconcile lookup failed; leaving pending', { disbursementId: d.id, error: String(e) });
      }
    }
    return completed;
  }

  // Idempotent terminal success. Row-locked: a reconcile racing the original serializes here and
  // the loser sees `completed` and does nothing. Returns whether THIS call completed it.
  private markDisbursed(id: string, providerDonationId: string): Promise<boolean> {
    return this.uow.run(async () => {
      const row = await this.store.getForUpdate(SYSTEM, id);
      if (!row || row.status === 'completed') return false;
      await this.store.markCompleted(SYSTEM, id, providerDonationId, this.clock.now());
      await this.outbox.add({
        type: 'disbursement.completed',
        payload: {
          disbursementId: id,
          charityId: row.charityId,
          currency: row.currency,
          amountCents: row.amountCents,
          providerDonationId,
        },
      });
      return true;
    });
  }

  // Terminal failure: failed + error + attempts+1, and the claimed penalties are released.
  // A completed donation is never undone. Row-locked and idempotent.
  private markFailed(id: string, error: string): Promise<void> {
    return this.uow.run(async () => {
      const row = await this.store.getForUpdate(SYSTEM, id);
      if (!row || row.status === 'completed') return;
      await this.store.markFailed(SYSTEM, id, error, this.clock.now());
      await this.penalty.releasePayout(id);
      await this.outbox.add({
        type: 'disbursement.failed',
        payload: {
          disbursementId: id,
          charityId: row.charityId,
          currency: row.currency,
          amountCents: row.amountCents,
          error,
        },
      });
    });
  }
}
