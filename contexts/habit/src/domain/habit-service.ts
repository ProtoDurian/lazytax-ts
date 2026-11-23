// Habits (LazyTax Domain/Habit/Service.cs minus complete and skip, which check owns).
// Layer 4 sits in the repository (owner first); layer 5 here: the plan's habit quota, counted
// under the user's lock in the same unit of work as the write.
import type { CharityV1 } from '@lazytax/charity-contract/v1';
import type { HabitChanged, HabitDeleted, HabitListQuery, HabitV1, HabitVersionDto } from '@lazytax/habit-contract/v1';
import { type Clock, notFound, type Outbox, Owner, type UnitOfWork, validationFailed } from '@lazytax/kernel';
import type { PlanV1 } from '@lazytax/plan-contract/v1';
import type { HabitRepository } from '../data/habit-repository';
import { mergeOrder } from './habit-order';
import type { HabitSearch, VersionInput } from './model';

export class HabitService implements HabitV1 {
  constructor(
    private readonly repo: HabitRepository,
    private readonly plan: PlanV1,
    private readonly charity: CharityV1,
    private readonly uow: UnitOfWork,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  // ── habit.v1 ───────────────────────────────────────────────────────────────────────────────

  listSchedulable(userIds?: string[], habitIds?: string[]): Promise<HabitVersionDto[]> {
    return this.repo.listSchedulable(Owner.system(), userIds, habitIds);
  }

  getVersion(owner: Owner, versionId: string): Promise<HabitVersionDto | null> {
    return this.repo.getVersion(owner, versionId);
  }

  getCurrent(owner: Owner, habitId: string): Promise<HabitVersionDto | null> {
    return this.repo.getCurrent(owner, habitId);
  }

  owns(userId: string, habitId: string): Promise<boolean> {
    return this.repo.owns(Owner.user(userId), habitId);
  }

  listVersions(owner: Owner, habitId: string): Promise<HabitVersionDto[]> {
    return this.repo.listVersions(owner, habitId);
  }

  listCurrent(owner: Owner, query: HabitListQuery = {}): Promise<HabitVersionDto[]> {
    return this.search(owner, {
      task: query.task,
      enabled: query.enabled,
      limit: query.limit ?? 20,
      skip: query.skip ?? 0,
    });
  }

  getVersionsByIds(versionIds: string[]): Promise<HabitVersionDto[]> {
    return this.repo.getVersionsByIds(Owner.system(), versionIds);
  }

  countHabits(userId: string): Promise<number> {
    return this.repo.countHabits(Owner.user(userId));
  }

  // ── the routes ─────────────────────────────────────────────────────────────────────────────

  search(owner: Owner, search: HabitSearch): Promise<HabitVersionDto[]> {
    return this.repo.search(owner, search);
  }

  // Creates the habit and its first version. Count, then write, under the user's lock.
  async create(userId: string, input: VersionInput, routineId: string | null): Promise<HabitVersionDto> {
    await this.ensureCharity(input.charityId);
    return this.uow.run(async () => {
      await this.uow.lockUser(userId);
      const used = await this.repo.countHabits(Owner.user(userId));
      this.plan.ensureWithin(await this.plan.quota(userId, 'habits'), used);
      const created = await this.repo.create(Owner.user(userId), input, routineId);
      if (created === null) throw notFound('Routine', routineId ?? '');
      return created;
    });
  }

  // A new version of the habit. null when it is not the owner's live habit (404).
  async update(owner: Owner, habitId: string, input: VersionInput, enabled: boolean): Promise<HabitVersionDto | null> {
    await this.ensureCharity(input.charityId);
    return this.uow.run(async () => {
      // The first read is owner-scoped: someone else's habit is 0 rows, never a 403.
      const habit = await this.repo.getHabit(owner, habitId);
      if (habit === null) return null;
      if (enabled && !habit.enabled) {
        // Switching a habit on takes a place in the plan's habit quota.
        await this.uow.lockUser(habit.userId);
        const used = await this.repo.countHabits(Owner.user(habit.userId));
        this.plan.ensureWithin(await this.plan.quota(habit.userId, 'habits'), used);
      }
      const updated = await this.repo.update(owner, habitId, input, enabled);
      if (updated === null) return null;
      // Days, deadline or enabled may have changed: check moves this habit's pending checks.
      await this.emitChanged(habit.userId, [habitId]);
      return updated;
    });
  }

  // Soft delete. false when it is not the owner's live habit (404).
  async delete(owner: Owner, habitId: string): Promise<boolean> {
    return this.uow.run(async () => {
      const habit = await this.repo.getHabit(owner, habitId);
      if (habit === null) return false;
      if (!(await this.repo.delete(owner, habitId, this.clock.now()))) return false;
      await this.emitChanged(habit.userId, [habitId]);
      await this.emitDeleted(habit.userId, [habitId]);
      return true;
    });
  }

  // The listed habits go first, in the given order; returns the user's final order.
  async reorder(owner: Owner, habitIds: string[]): Promise<string[]> {
    return this.uow.run(async () => {
      if (owner.kind === 'user') await this.uow.lockUser(owner.userId);
      const order = mergeOrder(await this.repo.getOrderedIds(owner), habitIds);
      await this.repo.setOrder(owner, order);
      return order;
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────

  // A habit version's charity is the one reference the client chooses, so an unknown charity is a
  // bad request (400), not a server error.
  private async ensureCharity(charityId: string | null): Promise<void> {
    if (charityId === null) return;
    if (await this.charity.exists(charityId)) return;
    const message = `Charity ${charityId} does not exist`;
    throw validationFailed(message, { CharityId: [message] });
  }

  async emitChanged(userId: string, habitIds: string[]): Promise<void> {
    const payload: HabitChanged = { userId, habitIds };
    await this.outbox.add({ type: 'habit.changed', payload, userId });
  }

  async emitDeleted(userId: string, habitIds: string[]): Promise<void> {
    const payload: HabitDeleted = { userId, habitIds };
    await this.outbox.add({ type: 'habit.deleted', payload, userId });
  }
}
