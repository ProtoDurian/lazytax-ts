// The penalty service (LazyTax Domain/Penalty/Service.cs, Domain/Check/PenaltyStakeBinding.cs and
// the debt gate of Domain/User/Service.cs). No SQL, no HTTP: the repository and the ports do that.
import type { CharityV1 } from '@lazytax/charity-contract/v1';
import type { PenaltyV1 } from '@lazytax/penalty-contract/v1';
import { type Clock, conflict, type Logger, notFound, type Outbox, Owner, type UnitOfWork } from '@lazytax/kernel';
import {
  type ChargeGateway,
  type ChargeOutcome,
  type CharityBalanceDto,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  type NewPenalty,
  type OutstandingDto,
  type PayoutGroupDto,
  type PenaltyDto,
  type PenaltyRepo,
  type PenaltySearchQuery,
} from './model';

export interface PenaltyConfig {
  // LazyTax PenaltyProcessorHostedService: ProcessPending(batchSize: 100, maxAttempts: 5).
  batchSize: number;
  maxAttempts: number;
  // A processing claim older than this belongs to a crashed drain and may be claimed again.
  claimLeaseMs: number;
  // LazyTax AppOption.BlockAccountDeletionOnDebt.
  blockDeletionOnDebt: boolean;
}

// What penalty reads from charity.v1 (the charity's name for the receipt).
type CharityNames = Pick<CharityV1, 'get'>;

// check.settled, as far as penalty reads it.
export interface SettledCheck {
  userId: string;
  habitId: string;
  executionId: string | null;
  status: string;
  stakeCents: number;
  ratioBps: number;
  currency: string;
  charityId: string | null;
}

// Exact cents math (LazyTax PenaltyStakeBinding / StreakRepository): cents * bps / 10000, floored.
export const stakeAmount = (stakeCents: number, ratioBps: number): number =>
  Number((BigInt(Math.trunc(stakeCents)) * BigInt(Math.trunc(ratioBps))) / 10_000n);

const accountDeletionBlocked = (o: OutstandingDto) =>
  conflict(
    'account_deletion_blocked',
    `Account deletion is blocked because you have an outstanding debt of ${(o.totalCents / 100).toFixed(2)} ${o.currency}. Please settle your debt before deleting your account.`,
    { totalDebt: o.totalCents / 100, totalCents: o.totalCents, currency: o.currency },
  );

export class PenaltyService implements PenaltyV1 {
  constructor(
    private readonly repo: PenaltyRepo,
    // Lazy: payment is built before penalty, but tests swap it.
    private readonly gateway: ChargeGateway,
    private readonly charity: CharityNames,
    private readonly uow: UnitOfWork,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
    private readonly config: PenaltyConfig,
    private readonly log: Logger,
  ) {}

  // ── penalty.v1 ──────────────────────────────────────────────────────────────────────────

  async outstanding(userId: string): Promise<OutstandingDto> {
    const byCurrency = await this.repo.outstanding(Owner.user(userId));
    const first = byCurrency[0];
    return {
      totalCents: first?.totalCents ?? 0,
      currency: first?.currency ?? '',
      byCurrency: byCurrency.map(({ currency, totalCents }) => ({ currency, totalCents })),
      count: byCurrency.reduce((n, c) => n + c.count, 0),
    };
  }

  charityBalances(): Promise<CharityBalanceDto[]> {
    return this.repo.charityBalances(Owner.system());
  }

  search(owner: Owner, query: PenaltySearchQuery): Promise<PenaltyDto[]> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
    const skip = Math.max(query.skip ?? 0, 0);
    return this.repo.search(owner, { ...query, limit, skip });
  }

  get(owner: Owner, id: string): Promise<PenaltyDto | null> {
    return this.repo.get(owner, id);
  }

  // For routes: the owner's penalty or 404 (never 403).
  async getOwned(owner: Owner, id: string): Promise<PenaltyDto> {
    const p = await this.repo.get(owner, id);
    if (!p) throw notFound('Penalty', id);
    return p;
  }

  payoutCandidates(minPayoutCents: number): Promise<PayoutGroupDto[]> {
    return this.uow.run(() => this.repo.payoutCandidates(Owner.system(), minPayoutCents));
  }

  claimForPayout(disbursementId: string, charityId: string, currency: string): Promise<number> {
    return this.uow.run(() => this.repo.claimForPayout(Owner.system(), disbursementId, charityId, currency));
  }

  releasePayout(disbursementId: string): Promise<void> {
    return this.uow.run(() => this.repo.releasePayout(Owner.system(), disbursementId));
  }

  // ── check.settled (LazyTax PenaltyStakeBinding) ─────────────────────────────────────────

  // A missed check with a money stake and a charity enqueues one pending penalty, once per execution.
  async onSettled(e: SettledCheck): Promise<boolean> {
    if (e.status !== 'missed' || !e.executionId) return false;
    const amountCents = stakeAmount(e.stakeCents, e.ratioBps);
    if (amountCents <= 0 || !e.charityId) return false;
    const p: NewPenalty = {
      habitExecutionId: e.executionId,
      habitId: e.habitId,
      userId: e.userId,
      charityId: e.charityId,
      amountCents,
      currency: e.currency,
    };
    return this.uow.run(() => this.repo.enqueue(Owner.user(e.userId), p));
  }

  // ── The kernel deleteGuard (LazyTax UserService.GuardNoDebt) ────────────────────────────

  async guardNoDebt(userId: string): Promise<void> {
    if (!this.config.blockDeletionOnDebt) return;
    const o = await this.outstanding(userId);
    if (o.totalCents > 0) throw accountDeletionBlocked(o);
  }

  // ── The drain (LazyTax PenaltyService.ProcessPending) ───────────────────────────────────

  // Claims a batch in one unit, charges each OUTSIDE any unit, then settles each in its own unit.
  // Returns how many penalties left pending this run (charged, failed or skipped).
  async processPending(): Promise<number> {
    if (this.uow.inUnit()) throw new Error('processPending must not run inside a unit of work (it charges)');
    const staleBefore = new Date(this.clock.now().getTime() - this.config.claimLeaseMs);
    const claimed = await this.uow.run(() =>
      this.repo.claimPending(Owner.system(), this.config.batchSize, staleBefore),
    );
    let done = 0;
    for (const p of claimed) {
      try {
        done += await this.processOne(p);
      } catch (e) {
        // Isolate per penalty: one bad row never strands the rest of the claimed batch.
        const message = `unhandled: ${(e as Error)?.message ?? String(e)}`;
        this.log.error('penalty processOne threw; isolating', { penaltyId: p.id, error: message });
        try {
          done += await this.settle(p.id, { kind: 'error', message });
        } catch (inner) {
          this.log.error('penalty isolation failed', {
            penaltyId: p.id,
            error: String((inner as Error)?.message ?? inner),
          });
        }
      }
    }
    return done;
  }

  private async processOne(p: PenaltyDto): Promise<number> {
    let outcome: ChargeOutcome;
    try {
      outcome = await this.gateway.charge(p);
    } catch (e) {
      outcome = { kind: 'error', message: (e as Error)?.message ?? 'charge error' };
    }
    return this.settle(p.id, outcome);
  }

  // Applies one charge outcome under the row lock. 1 = left pending for good, 0 = retry later.
  async settle(id: string, outcome: ChargeOutcome): Promise<number> {
    return this.uow.run(async () => {
      const p = await this.repo.lockForSettle(Owner.system(), id);
      // Gone, or already charged (a webhook or a racing drain won): charged is final.
      if (!p || p.status === 'charged') return 0;
      const attempts = p.attempts + 1;
      switch (outcome.kind) {
        case 'succeeded':
          await this.repo.markCharged(Owner.system(), p, outcome.paymentIntentId);
          await this.charged(p, outcome.paymentIntentId);
          return 1;
        case 'noConsent':
          await this.repo.markSkipped(Owner.system(), p.id);
          return 1;
        case 'pending':
          if (attempts >= this.config.maxAttempts) {
            await this.fail(p, attempts, `Max attempts reached, last status ${outcome.status}`);
            return 1;
          }
          await this.repo.markPending(Owner.system(), p.id, outcome.paymentIntentId, attempts, null);
          return 0;
        case 'error':
          if (attempts >= this.config.maxAttempts) {
            await this.fail(p, attempts, outcome.message);
            return 1;
          }
          await this.repo.markPending(Owner.system(), p.id, null, attempts, outcome.message);
          return 0;
      }
    });
  }

  // payment.completed for a penalty charge that settled later (the gateway's webhook).
  async onPaymentCompleted(requestId: string, paymentIntentId?: string | null): Promise<void> {
    await this.uow.run(async () => {
      const p = await this.repo.lockForSettle(Owner.system(), requestId);
      if (!p || p.status === 'charged') return;
      await this.settle(p.id, {
        kind: 'succeeded',
        paymentIntentId: paymentIntentId ?? p.paymentIntentId ?? requestId,
      });
    });
  }

  // The receipt and the inbox row are notification's: it subscribes to penalty.charged/failed.
  private async charityName(charityId: string): Promise<string | null> {
    return (await this.charity.get(charityId))?.name ?? null;
  }

  private async charged(p: PenaltyDto, paymentIntentId: string): Promise<void> {
    await this.outbox.add({
      type: 'penalty.charged',
      userId: p.userId,
      payload: {
        penaltyId: p.id,
        userId: p.userId,
        habitId: p.habitId,
        habitExecutionId: p.habitExecutionId,
        charityId: p.charityId,
        charityName: await this.charityName(p.charityId),
        amountCents: p.amountCents,
        currency: p.currency,
        paymentIntentId,
        chargedAt: this.clock.now().toISOString(),
      },
    });
  }

  private async fail(p: PenaltyDto, attempts: number, error: string): Promise<void> {
    await this.repo.markFailed(Owner.system(), p.id, attempts, error);
    await this.outbox.add({
      type: 'penalty.failed',
      userId: p.userId,
      payload: {
        penaltyId: p.id,
        userId: p.userId,
        habitId: p.habitId,
        habitExecutionId: p.habitExecutionId,
        charityId: p.charityId,
        charityName: await this.charityName(p.charityId),
        amountCents: p.amountCents,
        currency: p.currency,
        error,
        attemptedAt: this.clock.now().toISOString(),
      },
    });
  }
}
