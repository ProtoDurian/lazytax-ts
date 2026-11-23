// penalty.v1: the charity stakes a user owes for missed checks, and the per-charity accrual
// ledger (LazyTax Domain/Penalty + Domain/Check/PenaltyStakeBinding.cs).
// Interfaces and DTOs only. Never rename or remove a member once merged; add new ones.
import type { Owner } from '@lazytax/kernel';

// LazyTax PenaltyStatus. "processing" = claimed by a drain pass (a lease), never charged twice.
export type PenaltyStatus = 'pending' | 'processing' | 'charged' | 'failed' | 'skipped';

export interface PenaltyDto {
  id: string;
  // The check execution that was missed. One penalty per execution (the idempotency key).
  habitExecutionId: string;
  habitId: string;
  userId: string;
  charityId: string;
  amountCents: number;
  currency: string;
  status: PenaltyStatus;
  // The payment request id at the gateway, once one exists.
  paymentIntentId: string | null;
  attempts: number;
  lastError: string | null;
  // Set once disbursement has claimed this charged penalty for a payout.
  disbursementId: string | null;
  // ISO 8601 instants.
  createdAt: string;
  updatedAt: string;
}

export interface PenaltySearchQuery {
  status?: PenaltyStatus;
  // Default 20, at most 100.
  limit?: number;
  // Default 0.
  skip?: number;
}

// What a user still owes: every penalty that is not charged yet (pending, processing, failed,
// skipped). Money is never summed across currencies.
export interface OutstandingDto {
  // The total in `currency` (the first currency owed), as LazyTax's debt gate reports it.
  totalCents: number;
  // "" when nothing is owed.
  currency: string;
  byCurrency: { currency: string; totalCents: number }[];
  count: number;
}

// One accrual row per (charity, currency): charged penalties credited to the charity.
export interface CharityBalanceDto {
  charityId: string;
  currency: string;
  accruedCents: number;
  updatedAt: string;
}

// Charged penalties not yet claimed by a payout, grouped per (charity, currency).
export interface PayoutGroupDto {
  charityId: string;
  currency: string;
  amountCents: number;
}

export interface PenaltyV1 {
  // What the user owes. totalCents 0 when nothing is owed. The kernel deleteGuard uses it too.
  outstanding(userId: string): Promise<OutstandingDto>;
  // Every (charity, currency) accrual row.
  charityBalances(): Promise<CharityBalanceDto[]>;
  // The owner's penalties, newest first. Owner.anyone for an admin.
  search(owner: Owner, query: PenaltySearchQuery): Promise<PenaltyDto[]>;
  // null when the penalty does not exist or is not the owner's.
  get(owner: Owner, id: string): Promise<PenaltyDto | null>;

  // ── For disbursement (LazyTax DisbursementRepository read Penalties directly). ──────────
  // Call these inside one uow.run. payoutCandidates locks the charged, unclaimed penalties
  // (FOR UPDATE SKIP LOCKED) until the unit ends, so two payout passes never claim the same one.
  // Groups per (charity, currency) whose sum >= minPayoutCents, largest sum first.
  payoutCandidates(minPayoutCents: number): Promise<PayoutGroupDto[]>;
  // Stamp the charged, unclaimed penalties of (charity, currency) with the disbursement.
  // Returns the cents stamped (0 when none).
  claimForPayout(disbursementId: string, charityId: string, currency: string): Promise<number>;
  // A payout failed: release its penalties back to "pending payout". Idempotent.
  releasePayout(disbursementId: string): Promise<void>;
}

// A penalty was charged and credited to its charity.
export interface PenaltyCharged {
  penaltyId: string;
  userId: string;
  habitId: string;
  habitExecutionId: string;
  charityId: string;
  // The charity's name when penalty emitted the event (for the receipt); null if unknown.
  charityName?: string | null;
  amountCents: number;
  currency: string;
  paymentIntentId: string;
  // ISO 8601 instant.
  chargedAt: string;
}

// A penalty could not be charged and will not be retried.
export interface PenaltyFailed {
  penaltyId: string;
  userId: string;
  habitId: string;
  habitExecutionId: string;
  charityId: string;
  // The charity's name when penalty emitted the event (for the receipt); null if unknown.
  charityName?: string | null;
  amountCents: number;
  currency: string;
  error: string;
  // ISO 8601 instant.
  attemptedAt: string;
}

declare module '@lazytax/kernel' {
  interface ContractRegistry {
    'penalty.v1': PenaltyV1;
  }
  interface EventRegistry {
    'penalty.charged': PenaltyCharged;
    'penalty.failed': PenaltyFailed;
  }
}
