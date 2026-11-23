import type { Owner } from '@lazytax/kernel';
import type { DisbursementRow } from './model';

export interface NewDisbursement {
  id: string;
  charityId: string;
  currency: string;
  amountCents: number;
  pledgeOrganizationId: string;
  now: Date;
}

// The shape the service needs; data/disbursement-repository.ts is the SQL implementation.
// No row here belongs to a user (a payout sums many users' penalties), so every read is
// system-owned and there is nothing to filter by user.
export interface DisbursementStore {
  insertPending(owner: Owner, row: NewDisbursement): Promise<void>;
  get(owner: Owner, id: string): Promise<DisbursementRow | null>;
  // Locks the row; null when there is none.
  getForUpdate(owner: Owner, id: string): Promise<DisbursementRow | null>;
  markCompleted(owner: Owner, id: string, providerDonationId: string, now: Date): Promise<void>;
  markFailed(owner: Owner, id: string, error: string, now: Date): Promise<void>;
  // Pending rows whose updated_at is before the cutoff, oldest first.
  listReconcilable(owner: Owner, cutoff: Date, batchSize: number): Promise<DisbursementRow[]>;
}
