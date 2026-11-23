import type { Owner, UnitOfWork } from '@lazytax/kernel';
import type { DisbursementStore, NewDisbursement } from '../domain/disbursement-repository';
import type { DisbursementRow, DisbursementStatus } from '../domain/model';

const STATUS: DisbursementStatus[] = ['pending', 'completed', 'failed'];
const code = (s: DisbursementStatus) => STATUS.indexOf(s);

interface Raw {
  id: string;
  charity_id: string;
  currency: string;
  amount_cents: string | number | bigint;
  status: number;
  pledge_organization_id: string;
  provider_donation_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLS = `id, charity_id, currency, amount_cents, status, pledge_organization_id,
  provider_donation_id, attempts, last_error, created_at, updated_at`;

const map = (r: Raw): DisbursementRow => ({
  id: r.id,
  charityId: r.charity_id,
  currency: r.currency,
  amountCents: Number(r.amount_cents),
  status: STATUS[r.status] ?? 'failed',
  pledgeOrganizationId: r.pledge_organization_id,
  providerDonationId: r.provider_donation_id,
  attempts: r.attempts,
  lastError: r.last_error,
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
});

// A payout belongs to no user (it sums many users' penalties), so every method takes the system
// owner first and there is no user column to filter by.
export class DisbursementRepository implements DisbursementStore {
  constructor(private readonly uow: UnitOfWork) {}

  async insertPending(_owner: Owner, row: NewDisbursement): Promise<void> {
    await this.uow.db()`
      INSERT INTO disbursement.disbursements
        (id, charity_id, currency, amount_cents, status, pledge_organization_id, attempts, created_at, updated_at)
      VALUES (${row.id}, ${row.charityId}, ${row.currency}, ${row.amountCents}, ${code('pending')},
        ${row.pledgeOrganizationId}, 0, ${row.now}, ${row.now})`;
  }

  async get(_owner: Owner, id: string): Promise<DisbursementRow | null> {
    const rows = await this.uow.db()`
      SELECT ${this.uow.db().unsafe(COLS)} FROM disbursement.disbursements WHERE id = ${id}`;
    return rows[0] ? map(rows[0] as Raw) : null;
  }

  async getForUpdate(_owner: Owner, id: string): Promise<DisbursementRow | null> {
    const rows = await this.uow.db()`
      SELECT ${this.uow.db().unsafe(COLS)} FROM disbursement.disbursements WHERE id = ${id} FOR UPDATE`;
    return rows[0] ? map(rows[0] as Raw) : null;
  }

  async markCompleted(_owner: Owner, id: string, providerDonationId: string, now: Date): Promise<void> {
    await this.uow.db()`
      UPDATE disbursement.disbursements
      SET status = ${code('completed')}, provider_donation_id = ${providerDonationId}, last_error = NULL, updated_at = ${now}
      WHERE id = ${id}`;
  }

  async markFailed(_owner: Owner, id: string, error: string, now: Date): Promise<void> {
    await this.uow.db()`
      UPDATE disbursement.disbursements
      SET status = ${code('failed')}, last_error = ${error.slice(0, 2048)}, attempts = attempts + 1, updated_at = ${now}
      WHERE id = ${id}`;
  }

  async listReconcilable(_owner: Owner, cutoff: Date, batchSize: number): Promise<DisbursementRow[]> {
    const rows = await this.uow.db()`
      SELECT ${this.uow.db().unsafe(COLS)} FROM disbursement.disbursements
      WHERE status = ${code('pending')} AND updated_at < ${cutoff}
      ORDER BY updated_at LIMIT ${batchSize}`;
    return (rows as Raw[]).map(map);
  }
}
