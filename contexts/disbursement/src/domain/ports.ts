// What the domain needs from outside. register.ts adapts the penalty and charity contracts to
// these, and wires the donation gateway (a fake with no network).

export interface PayoutCandidate {
  charityId: string;
  currency: string;
  amountCents: number;
}

// penalty.v1, as far as disbursement uses it.
export interface PenaltyPayouts {
  // Charged penalties with no payout claim, grouped by (charity, currency), sum >= min, biggest
  // first. Locks the rows (FOR UPDATE SKIP LOCKED) for the open unit of work.
  payoutCandidates(minPayoutCents: number): Promise<PayoutCandidate[]>;
  // Stamps the group's penalties with the disbursement id; returns the cents stamped.
  claimForPayout(disbursementId: string, charityId: string, currency: string): Promise<number>;
  // Clears the stamp so a later pass re-claims. Idempotent.
  releasePayout(disbursementId: string): Promise<void>;
}

// charity.v1, as far as disbursement uses it.
export interface CharityTargets {
  // The charity's Pledge organization id, or null when it is not linked.
  pledgeOrganizationId(charityId: string): Promise<string | null>;
}

export interface DonationRequest {
  organizationId: string;
  amountCents: number;
  currency: string;
  // Our disbursement id; stored at the vendor so a lost answer can be looked up.
  reference: string;
  donorFirstName: string;
  donorLastName: string;
  donorEmail: string;
}

export interface DonationResult {
  donationId: string;
  status: string;
}

// The provider DEFINITIVELY refused (a 4xx): no donation exists, so releasing the penalties is
// safe. Any other throw from the gateway is AMBIGUOUS (5xx, timeout, network, bad body): the
// donation may have landed, so the disbursement stays pending for reconciliation. Pledge has no
// idempotency key, so releasing on an ambiguous failure could pay out twice.
export class DonationRejected extends Error {
  override readonly name = 'DonationRejected';
}

// Port over the donation vendor (Pledge). HTTP: never call it inside a unit of work.
export interface DonationGateway {
  createDonation(req: DonationRequest): Promise<DonationResult>;
  // null ONLY when the lookup conclusively found nothing. An inconclusive lookup throws.
  findDonationByReference(reference: string): Promise<DonationResult | null>;
}
