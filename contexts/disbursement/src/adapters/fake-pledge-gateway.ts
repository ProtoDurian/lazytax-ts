import { type DonationGateway, DonationRejected, type DonationRequest, type DonationResult } from '../domain/ports';

export type FakeBehaviour = 'ok' | 'reject' | 'ambiguous';

// The Pledge gateway with no network: it keeps donations in memory, keyed by reference. Tests flip
// `createMode` / `lookupFails` to drive the definitive-refusal and ambiguous-failure paths.
// Pledge has no idempotency key, so creating twice with the same reference makes two donations
// (that is what the reconcile logic exists to prevent).
export class FakePledgeGateway implements DonationGateway {
  readonly donations: (DonationResult & { reference: string; request: DonationRequest })[] = [];
  createMode: FakeBehaviour = 'ok';
  // When true, a create that "fails" ambiguously still lands the donation (the lost-answer case).
  landsOnAmbiguous = false;
  lookupFails = false;
  private seq = 0;

  async createDonation(req: DonationRequest): Promise<DonationResult> {
    if (this.createMode === 'reject')
      throw new DonationRejected('fake pledge: 422 organization not accepting donations');
    const result: DonationResult = { donationId: `don_${++this.seq}`, status: 'processed' };
    if (this.createMode === 'ambiguous') {
      if (this.landsOnAmbiguous) this.donations.push({ ...result, reference: req.reference, request: req });
      throw new Error('fake pledge: 503 service unavailable');
    }
    this.donations.push({ ...result, reference: req.reference, request: req });
    return result;
  }

  async findDonationByReference(reference: string): Promise<DonationResult | null> {
    if (this.lookupFails) throw new Error('fake pledge: lookup inconclusive');
    const d = this.donations.find(x => x.reference === reference);
    return d ? { donationId: d.donationId, status: d.status } : null;
  }

  reset(): void {
    this.donations.length = 0;
    this.createMode = 'ok';
    this.landsOnAmbiguous = false;
    this.lookupFails = false;
    this.seq = 0;
  }
}

// One shared instance: the app uses it, and integration tests import it to steer it.
export const fakePledge = new FakePledgeGateway();
