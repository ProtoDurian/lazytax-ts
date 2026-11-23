import type { DisbursementStatus, DonorIdentity } from '@lazytax/disbursement-contract/v1';

export type { DisbursementStatus };

export interface DisbursementRow {
  id: string;
  charityId: string;
  currency: string;
  amountCents: number;
  status: DisbursementStatus;
  pledgeOrganizationId: string;
  providerDonationId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// A claimed payout group: the disbursement row plus what the worker needs to donate.
export interface ClaimedPayout {
  disbursementId: string;
  charityId: string;
  currency: string;
  amountCents: number;
  pledgeOrganizationId: string;
}

export interface PayoutOptions {
  donor: DonorIdentity;
  minPayoutCents: number;
  maxGroups: number;
}
