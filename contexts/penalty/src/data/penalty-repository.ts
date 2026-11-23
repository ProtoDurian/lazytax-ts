// SQL for schema penalty (LazyTax App/Modules/Penalty/Data/PenaltyRepository.cs and the
// Penalties half of DisbursementRepository). Every method takes an Owner first and filters on it
// in its first query; workers and subscribers pass Owner.system().
import { type Clock, type Owner, ownerFilter, type UnitOfWork } from '@lazytax/kernel';
import type {
  CharityBalanceDto,
  NewPenalty,
  PayoutGroupDto,
  PenaltyDto,
  PenaltyRepo,
  PenaltySearchQuery,
  PenaltyStatus,
} from '../domain/model';

// A penalty row whose user deleted their account keeps its money facts but loses the person
// (LazyTax's planned anonymize-retain of the donation ledger).
const DELETED_USER = 'deleted-user';

interface Row {
  id: string;
  habit_execution_id: string;
  habit_id: string;
  user_id: string;
  charity_id: string;
  amount_cents: string | number;
  currency: string;
  status: PenaltyStatus;
  payment_intent_id: string | null;
  attempts: number;
  last_error: string | null;
  payout_disbursement_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLS =
  'p.id, p.habit_execution_id, p.habit_id, p.user_id, p.charity_id, p.amount_cents, p.currency, p.status, p.payment_intent_id, p.attempts, p.last_error, p.payout_disbursement_id, p.created_at, p.updated_at';

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

const toDto = (r: Row): PenaltyDto => ({
  id: r.id,
  habitExecutionId: r.habit_execution_id,
  habitId: r.habit_id,
  userId: r.user_id,
  charityId: r.charity_id,
  amountCents: Number(r.amount_cents),
  currency: r.currency,
  status: r.status,
  paymentIntentId: r.payment_intent_id,
  attempts: r.attempts,
  lastError: r.last_error,
  disbursementId: r.payout_disbursement_id,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export class PenaltyRepository implements PenaltyRepo {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  // Idempotent on habit_execution_id: true when inserted, false when it was already there.
  async enqueue(owner: Owner, p: NewPenalty): Promise<boolean> {
    const db = this.uow.db();
    if (owner.kind === 'user' && owner.userId !== p.userId) return false;
    const now = this.clock.now();
    const rows = await db`
      INSERT INTO penalty.penalties
        (habit_execution_id, habit_id, user_id, charity_id, amount_cents, currency, created_at, updated_at)
      VALUES (${p.habitExecutionId}, ${p.habitId}, ${p.userId}, ${p.charityId}, ${p.amountCents}, ${p.currency}, ${now}, ${now})
      ON CONFLICT (habit_execution_id) DO NOTHING
      RETURNING id`;
    return rows.length > 0;
  }

  async get(owner: Owner, id: string): Promise<PenaltyDto | null> {
    const db = this.uow.db();
    const rows: Row[] = await db`
      SELECT ${db.unsafe(COLS)} FROM penalty.penalties p
      WHERE p.id = ${id} ${ownerFilter(db, owner, 'p.user_id')}`;
    return rows[0] ? toDto(rows[0]) : null;
  }

  async search(
    owner: Owner,
    q: Required<Pick<PenaltySearchQuery, 'limit' | 'skip'>> & PenaltySearchQuery,
  ): Promise<PenaltyDto[]> {
    const db = this.uow.db();
    const status = q.status ? db`AND p.status = ${q.status}` : db``;
    const rows: Row[] = await db`
      SELECT ${db.unsafe(COLS)} FROM penalty.penalties p
      WHERE TRUE ${ownerFilter(db, owner, 'p.user_id')} ${status}
      ORDER BY p.created_at DESC, p.id
      LIMIT ${q.limit} OFFSET ${q.skip}`;
    return rows.map(toDto);
  }

  // Everything not charged yet is owed (pending, processing, failed, skipped), per currency.
  async outstanding(owner: Owner): Promise<{ currency: string; totalCents: number; count: number }[]> {
    const db = this.uow.db();
    const rows: { currency: string; total: string | number; n: string | number; first: Date }[] = await db`
      SELECT p.currency, SUM(p.amount_cents)::bigint AS total, COUNT(*)::int AS n, MIN(p.created_at) AS first
      FROM penalty.penalties p
      WHERE p.status <> 'charged' ${ownerFilter(db, owner, 'p.user_id')}
      GROUP BY p.currency
      ORDER BY first, p.currency`;
    return rows.map(r => ({ currency: r.currency, totalCents: Number(r.total), count: Number(r.n) }));
  }

  // The ledger holds no user data, so only an admin or the system may read it.
  async charityBalances(owner: Owner): Promise<CharityBalanceDto[]> {
    if (owner.kind !== 'anyone') return [];
    const rows: { charity_id: string; currency: string; accrued_cents: string | number; updated_at: Date }[] =
      await this.uow.db()`
      SELECT charity_id, currency, accrued_cents, updated_at FROM penalty.charity_balances
      ORDER BY charity_id, currency`;
    return rows.map(r => ({
      charityId: r.charity_id,
      currency: r.currency,
      accruedCents: Number(r.accrued_cents),
      updatedAt: iso(r.updated_at),
    }));
  }

  // Atomically CLAIM a batch: pending (or processing older than the lease) -> processing, in one
  // statement. FOR UPDATE SKIP LOCKED hands each row to exactly one drain, so two never charge it.
  async claimPending(owner: Owner, batchSize: number, staleBefore: Date): Promise<PenaltyDto[]> {
    const db = this.uow.db();
    const now = this.clock.now();
    const rows: Row[] = await db`
      UPDATE penalty.penalties p SET status = 'processing', updated_at = ${now}
      WHERE p.id IN (
        SELECT c.id FROM penalty.penalties c
        WHERE (c.status = 'pending' OR (c.status = 'processing' AND c.updated_at < ${staleBefore}))
          ${ownerFilter(db, owner, 'c.user_id')}
        ORDER BY c.created_at
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED)
      RETURNING ${db.unsafe(COLS)}`;
    return rows.map(toDto).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // Lock the row for the rest of the unit (LazyTax MarkCharged's SELECT ... FOR UPDATE).
  async lockForSettle(owner: Owner, id: string): Promise<PenaltyDto | null> {
    const db = this.uow.db();
    const rows: Row[] = await db`
      SELECT ${db.unsafe(COLS)} FROM penalty.penalties p
      WHERE p.id = ${id} ${ownerFilter(db, owner, 'p.user_id')}
      FOR UPDATE`;
    return rows[0] ? toDto(rows[0]) : null;
  }

  // Charged + credit the (charity, currency) ledger. Call after lockForSettle in the same unit.
  async markCharged(owner: Owner, p: PenaltyDto, paymentIntentId: string): Promise<void> {
    const db = this.uow.db();
    const now = this.clock.now();
    const rows = await db`
      UPDATE penalty.penalties p SET status = 'charged', payment_intent_id = ${paymentIntentId},
        last_error = NULL, updated_at = ${now}
      WHERE p.id = ${p.id} AND p.status <> 'charged' ${ownerFilter(db, owner, 'p.user_id')}
      RETURNING p.id`;
    if (rows.length === 0) return;
    // An upsert in place: no lost update between two penalties of the same charity.
    await db`
      INSERT INTO penalty.charity_balances (charity_id, currency, accrued_cents, updated_at)
      VALUES (${p.charityId}, ${p.currency}, ${p.amountCents}, ${now})
      ON CONFLICT (charity_id, currency)
      DO UPDATE SET accrued_cents = penalty.charity_balances.accrued_cents + EXCLUDED.accrued_cents,
                    updated_at = EXCLUDED.updated_at`;
  }

  // Back to pending (a later drain retries it); never touches a charged row.
  async markPending(
    owner: Owner,
    id: string,
    paymentIntentId: string | null,
    attempts: number,
    error: string | null,
  ): Promise<void> {
    const db = this.uow.db();
    await db`
      UPDATE penalty.penalties p SET status = 'pending',
        payment_intent_id = COALESCE(${paymentIntentId}, p.payment_intent_id),
        attempts = ${attempts}, last_error = COALESCE(${error}, p.last_error), updated_at = ${this.clock.now()}
      WHERE p.id = ${id} AND p.status <> 'charged' ${ownerFilter(db, owner, 'p.user_id')}`;
  }

  async markFailed(owner: Owner, id: string, attempts: number, error: string): Promise<void> {
    const db = this.uow.db();
    await db`
      UPDATE penalty.penalties p SET status = 'failed', attempts = ${attempts},
        last_error = ${error.slice(0, 2048)}, updated_at = ${this.clock.now()}
      WHERE p.id = ${id} AND p.status <> 'charged' ${ownerFilter(db, owner, 'p.user_id')}`;
  }

  async markSkipped(owner: Owner, id: string): Promise<void> {
    const db = this.uow.db();
    await db`
      UPDATE penalty.penalties p SET status = 'skipped', updated_at = ${this.clock.now()}
      WHERE p.id = ${id} AND p.status <> 'charged' ${ownerFilter(db, owner, 'p.user_id')}`;
  }

  // Charged, unclaimed penalties, locked for the unit (SKIP LOCKED), summed per (charity, currency).
  async payoutCandidates(owner: Owner, minPayoutCents: number): Promise<PayoutGroupDto[]> {
    const db = this.uow.db();
    const rows: { charity_id: string; currency: string; amount_cents: string | number }[] = await db`
      SELECT p.charity_id, p.currency, p.amount_cents FROM penalty.penalties p
      WHERE p.status = 'charged' AND p.payout_disbursement_id IS NULL ${ownerFilter(db, owner, 'p.user_id')}
      ORDER BY p.created_at
      FOR UPDATE SKIP LOCKED`;
    const groups = new Map<string, PayoutGroupDto>();
    for (const r of rows) {
      const key = `${r.charity_id}|${r.currency}`;
      const g = groups.get(key) ?? { charityId: r.charity_id, currency: r.currency, amountCents: 0 };
      g.amountCents += Number(r.amount_cents);
      groups.set(key, g);
    }
    return [...groups.values()]
      .filter(g => g.amountCents >= minPayoutCents)
      .sort((a, b) => b.amountCents - a.amountCents || a.charityId.localeCompare(b.charityId));
  }

  async claimForPayout(owner: Owner, disbursementId: string, charityId: string, currency: string): Promise<number> {
    const db = this.uow.db();
    const rows: { total: string | number | null }[] = await db`
      WITH stamped AS (
        UPDATE penalty.penalties p SET payout_disbursement_id = ${disbursementId}, updated_at = ${this.clock.now()}
        WHERE p.status = 'charged' AND p.payout_disbursement_id IS NULL
          AND p.charity_id = ${charityId} AND p.currency = ${currency} ${ownerFilter(db, owner, 'p.user_id')}
        RETURNING p.amount_cents)
      SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM stamped`;
    return Number(rows[0]?.total ?? 0);
  }

  async releasePayout(owner: Owner, disbursementId: string): Promise<void> {
    const db = this.uow.db();
    await db`
      UPDATE penalty.penalties p SET payout_disbursement_id = NULL, updated_at = ${this.clock.now()}
      WHERE p.payout_disbursement_id = ${disbursementId} ${ownerFilter(db, owner, 'p.user_id')}`;
  }

  // The purge hook (the one method with a bare user id). Money facts stay; the person goes.
  async purgeUser(userId: string): Promise<void> {
    await this.uow.db()`
      UPDATE penalty.penalties SET user_id = ${DELETED_USER}, updated_at = ${this.clock.now()}
      WHERE user_id = ${userId}`;
  }
}
