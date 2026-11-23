// The penalty domain's own types. Rows are the contract DTOs; nothing here touches SQL or HTTP.
import type {
  CharityBalanceDto,
  OutstandingDto,
  PayoutGroupDto,
  PenaltyDto,
  PenaltySearchQuery,
  PenaltyStatus,
} from '@lazytax/penalty-contract/v1';
import type { Owner } from '@lazytax/kernel';

export type { CharityBalanceDto, OutstandingDto, PayoutGroupDto, PenaltyDto, PenaltySearchQuery, PenaltyStatus };

// What the check.settled subscriber enqueues (LazyTax PenaltyStakeBinding -> PenaltyRecord).
export interface NewPenalty {
  habitExecutionId: string;
  habitId: string;
  userId: string;
  charityId: string;
  amountCents: number;
  currency: string;
}

// The answer of one charge attempt (LazyTax: the Airwallex intent status, or a typed failure).
export type ChargeOutcome =
  // The money moved.
  | { kind: 'succeeded'; paymentIntentId: string }
  // Not settled yet (requires action / payment method / capture): retry later.
  | { kind: 'pending'; paymentIntentId: string | null; status: string }
  // The user has no verified consent: terminal, the penalty is skipped.
  | { kind: 'noConsent' }
  // The gateway refused or broke: retry until the attempts run out.
  | { kind: 'error'; message: string };

// The one thing penalty needs from payment. register.ts adapts payment.v1 to it.
export interface ChargeGateway {
  // Never inside a unit of work: payment does its own claim / call / write-back phases.
  charge(p: PenaltyDto): Promise<ChargeOutcome>;
}

export interface PenaltyRepo {
  enqueue(owner: Owner, p: NewPenalty): Promise<boolean>;
  get(owner: Owner, id: string): Promise<PenaltyDto | null>;
  search(owner: Owner, q: Required<Pick<PenaltySearchQuery, 'limit' | 'skip'>> & PenaltySearchQuery): Promise<PenaltyDto[]>;
  outstanding(owner: Owner): Promise<{ currency: string; totalCents: number; count: number }[]>;
  charityBalances(owner: Owner): Promise<CharityBalanceDto[]>;
  claimPending(owner: Owner, batchSize: number, staleBefore: Date): Promise<PenaltyDto[]>;
  lockForSettle(owner: Owner, id: string): Promise<PenaltyDto | null>;
  markCharged(owner: Owner, p: PenaltyDto, paymentIntentId: string): Promise<void>;
  markPending(owner: Owner, id: string, paymentIntentId: string | null, attempts: number, error: string | null): Promise<void>;
  markFailed(owner: Owner, id: string, attempts: number, error: string): Promise<void>;
  markSkipped(owner: Owner, id: string): Promise<void>;
  payoutCandidates(owner: Owner, minPayoutCents: number): Promise<PayoutGroupDto[]>;
  claimForPayout(owner: Owner, disbursementId: string, charityId: string, currency: string): Promise<number>;
  releasePayout(owner: Owner, disbursementId: string): Promise<void>;
  purgeUser(userId: string): Promise<void>;
}

export const MAX_SEARCH_LIMIT = 100;
export const DEFAULT_SEARCH_LIMIT = 20;
