// disbursement.v1: the charity payout. Charged penalties are grouped by (charity, currency) and
// donated to the charity's Pledge organization. Interfaces and DTOs only. Never rename or remove a
// member once merged; add new ones.
//
// Nothing here belongs to a user: a payout sums many users' penalties, so no method takes an
// Owner and callers are admin or a worker (policy `admin`).

export type DisbursementStatus = 'pending' | 'completed' | 'failed';

// The legal donor of record (LazyTax) recorded on every donation. Comes from config.
export interface DonorIdentity {
  firstName: string;
  lastName: string;
  email: string;
}

export interface DisbursementDto {
  id: string;
  charityId: string;
  // ISO 4217, upper case.
  currency: string;
  amountCents: number;
  status: DisbursementStatus;
  // The Pledge organization the donation goes to, captured at claim time.
  pledgeOrganizationId: string;
  // Set when completed.
  providerDonationId: string | null;
  attempts: number;
  lastError: string | null;
  // ISO 8601 instants.
  createdAt: string;
  updatedAt: string;
}

export interface DisbursementV1 {
  // One payout pass: reconcile crashed in-flight disbursements, then claim and donate the pending
  // payouts. Returns the number of disbursements that reached `completed`.
  // `donor`, `minPayoutCents` and `maxGroups` default to the context config when omitted.
  processPending(opts?: { donor?: DonorIdentity; minPayoutCents?: number; maxGroups?: number }): Promise<number>;
  // One disbursement by id; null when there is none. Admin / system use only.
  get(id: string): Promise<DisbursementDto | null>;
}

// A donation reached Pledge and was recorded.
export interface DisbursementCompleted {
  disbursementId: string;
  charityId: string;
  currency: string;
  amountCents: number;
  providerDonationId: string;
}

// The provider definitively refused; the penalties were released for a fresh claim.
export interface DisbursementFailed {
  disbursementId: string;
  charityId: string;
  currency: string;
  amountCents: number;
  error: string;
}

declare module '@lazytax/kernel' {
  interface ContractRegistry {
    'disbursement.v1': DisbursementV1;
  }
  interface EventRegistry {
    'disbursement.completed': DisbursementCompleted;
    'disbursement.failed': DisbursementFailed;
  }
}
