// plan.subscriptions and plan.subscription_changes. Every method takes the Owner first.
import { type Owner, ownerFilter, type UnitOfWork } from '@lazytax/kernel';
import type { Subscription, SubscriptionChange, SubscriptionStatus } from '../domain/model';

interface SubRow {
  id: string;
  user_id: string;
  tier: string;
  status: SubscriptionStatus;
  period_start: Date;
  period_end: Date;
  cancel_at_period_end: boolean;
  next_tier: string | null;
}
interface ChangeRow {
  id: string;
  subscription_id: string;
  from_tier: string;
  to_tier: string;
  changed_by: string;
  created_at: Date;
}

const toSub = (r: SubRow): Subscription => ({
  id: r.id,
  userId: r.user_id,
  tier: r.tier,
  status: r.status,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  cancelAtPeriodEnd: r.cancel_at_period_end,
  nextTier: r.next_tier,
});
const toChange = (r: ChangeRow): SubscriptionChange => ({
  id: r.id,
  subscriptionId: r.subscription_id,
  fromTier: r.from_tier,
  toTier: r.to_tier,
  changedBy: r.changed_by,
  createdAt: r.created_at,
});

export class SubscriptionRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async getForUser(owner: Owner, userId: string): Promise<Subscription | null> {
    const db = this.uow.db();
    const rows: SubRow[] = await db`
      SELECT s.id::text, s.user_id, s.tier, s.status, s.period_start, s.period_end, s.cancel_at_period_end, s.next_tier
      FROM plan.subscriptions s WHERE s.user_id = ${userId} ${ownerFilter(db, owner, 's.user_id')}`;
    return rows[0] ? toSub(rows[0]) : null;
  }

  // Insert or replace the user's subscription; returns it with the tier it had before.
  async upsert(
    owner: Owner,
    userId: string,
    s: { tier: string; status: SubscriptionStatus; periodStart: Date; periodEnd: Date },
  ): Promise<Subscription> {
    if (owner.kind === 'user' && owner.userId !== userId)
      throw new Error('SubscriptionRepository.upsert: owner mismatch');
    const rows: SubRow[] = await this.uow.db()`
      INSERT INTO plan.subscriptions (user_id, tier, status, period_start, period_end)
      VALUES (${userId}, ${s.tier}, ${s.status}, ${s.periodStart}, ${s.periodEnd})
      ON CONFLICT (user_id) DO UPDATE SET tier = EXCLUDED.tier, status = EXCLUDED.status,
        period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
        cancel_at_period_end = false, next_tier = NULL, updated_at = now()
      RETURNING id::text, user_id, tier, status, period_start, period_end, cancel_at_period_end, next_tier`;
    return toSub(rows[0] as SubRow);
  }

  async setCancelAtPeriodEnd(owner: Owner, id: string, cancel: boolean): Promise<Subscription | null> {
    const db = this.uow.db();
    const rows: SubRow[] = await db`
      UPDATE plan.subscriptions s SET cancel_at_period_end = ${cancel}, updated_at = now()
      WHERE s.id = ${id} ${ownerFilter(db, owner, 's.user_id')}
      RETURNING s.id::text, s.user_id, s.tier, s.status, s.period_start, s.period_end, s.cancel_at_period_end, s.next_tier`;
    return rows[0] ? toSub(rows[0]) : null;
  }

  async addChange(
    owner: Owner,
    subscriptionId: string,
    from: string,
    to: string,
    by: string,
  ): Promise<SubscriptionChange> {
    const db = this.uow.db();
    // The insert only happens when the subscription belongs to the owner (no write by id alone).
    const rows: ChangeRow[] = await db`
      INSERT INTO plan.subscription_changes (subscription_id, from_tier, to_tier, changed_by)
      SELECT s.id, ${from}, ${to}, ${by} FROM plan.subscriptions s
      WHERE s.id = ${subscriptionId} ${ownerFilter(db, owner, 's.user_id')}
      RETURNING id::text, subscription_id::text, from_tier, to_tier, changed_by, created_at`;
    if (!rows[0]) throw new Error('subscription not found for owner');
    return toChange(rows[0]);
  }

  // The ownership chain: change -> subscription -> user_id, filtered with a JOIN.
  async getChange(owner: Owner, changeId: string): Promise<SubscriptionChange | null> {
    const db = this.uow.db();
    const rows: ChangeRow[] = await db`
      SELECT c.id::text, c.subscription_id::text, c.from_tier, c.to_tier, c.changed_by, c.created_at
      FROM plan.subscription_changes c JOIN plan.subscriptions s ON s.id = c.subscription_id
      WHERE c.id = ${changeId} ${ownerFilter(db, owner, 's.user_id')}`;
    return rows[0] ? toChange(rows[0]) : null;
  }

  async listChanges(owner: Owner, userId: string): Promise<SubscriptionChange[]> {
    const db = this.uow.db();
    const rows: ChangeRow[] = await db`
      SELECT c.id::text, c.subscription_id::text, c.from_tier, c.to_tier, c.changed_by, c.created_at
      FROM plan.subscription_changes c JOIN plan.subscriptions s ON s.id = c.subscription_id
      WHERE s.user_id = ${userId} ${ownerFilter(db, owner, 's.user_id')}
      ORDER BY c.created_at DESC, c.id`;
    return rows.map(toChange);
  }

  async purgeUser(userId: string): Promise<void> {
    await this.uow.db()`DELETE FROM plan.subscriptions WHERE user_id = ${userId}`;
  }
}
