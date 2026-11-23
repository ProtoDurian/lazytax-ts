import type { AccountV1 } from '@lazytax/account-contract/v1';
import type { EventRegistry } from '@lazytax/kernel';
import { type Logger, type Outbox, Owner, Problem, type UnitOfWork, unauthorized } from '@lazytax/kernel';
import type { PlanV1 } from '@lazytax/plan-contract/v1';
import type { FreezeBalanceDto, ProtectionV1 } from '@lazytax/protection-contract/v1';
import type { ProtectionRepository } from '../data/protection-repository';
import { addDays, isDone, previousWeek } from './weeks';

type CheckSettledPayload = EventRegistry['check.settled'];

// Settled days older than this can no longer make a week awardable (the worker looks 14 days back).
const KEEP_DAYS = 45;
const LOOKBACK_DAYS = 14;

export class ProtectionService implements ProtectionV1 {
  constructor(
    private readonly repo: ProtectionRepository,
    private readonly plan: PlanV1,
    private readonly account: AccountV1,
    private readonly uow: UnitOfWork,
    private readonly outbox: Outbox,
    private readonly log: Logger,
  ) {}

  // LazyTax FreezeCapService.Reconcile, with the max streak given by check.
  reconcileCap(userId: string, maxStreak: number): Promise<FreezeBalanceDto> {
    return this.uow.run(async () => {
      await this.uow.lockUser(userId);
      const owner = Owner.user(userId);
      await this.repo.upsert(owner);
      await this.repo.setMaxStreak(owner, maxStreak);
      return this.clamp(userId, maxStreak);
    });
  }

  tryConsumeFreeze(userId: string, date: string): Promise<boolean> {
    return this.uow.run(async () => {
      await this.uow.lockUser(userId);
      return this.repo.tryConsume(Owner.user(userId), date);
    });
  }

  // LazyTax GET /Protection/{userId}: reading cuts the balance to the cap first.
  balance(owner: Owner): Promise<FreezeBalanceDto> {
    if (owner.kind !== 'user') throw unauthorized('A freeze balance belongs to one user');
    return this.uow.run(async () => {
      await this.uow.lockUser(owner.userId);
      const row = await this.repo.upsert(owner);
      return this.clamp(owner.userId, row.maxStreak);
    });
  }

  // check.settled: remember the day for the weekly award, and the max streak for the cap.
  async onSettled(e: CheckSettledPayload): Promise<void> {
    const owner = Owner.user(e.userId);
    await this.uow.lockUser(e.userId);
    await this.repo.recordSettled(owner, {
      executionId: e.executionId,
      habitId: e.habitId,
      date: e.date,
      status: e.status,
    });
    await this.repo.upsert(owner);
    await this.repo.setMaxStreak(owner, e.maxStreak);
    await this.clamp(e.userId, e.maxStreak);
  }

  // LazyTax ProtectionAwardService.AwardWeeklyFreezesForUser: one freeze per habit whose last
  // completed week (user-local Sunday to Saturday) had settled days and every one completed.
  // Returns the number of awards recorded; idempotent per (habit, week).
  async awardWeeklyForUser(userId: string): Promise<number> {
    let today: string;
    try {
      today = await this.account.today(userId);
    } catch (e) {
      if (e instanceof Problem && e.kind === 'not_found') return 0; // no configuration: nothing to award
      throw e;
    }
    const { weekStart, weekEnd } = previousWeek(today);
    const owner = Owner.user(userId);
    const days = await this.repo.settledBetween(owner, weekStart, weekEnd);
    const perfect = new Map<string, boolean>();
    for (const d of days) perfect.set(d.habitId, (perfect.get(d.habitId) ?? true) && isDone(d.status));

    let awards = 0;
    for (const [habitId, ok] of [...perfect].sort(([a], [b]) => a.localeCompare(b))) {
      if (!ok) continue;
      const awarded = await this.uow.run(async () => {
        await this.uow.lockUser(userId);
        if (!(await this.repo.recordAwardIfAbsent(owner, habitId, weekStart))) return false;
        const row = await this.repo.upsert(owner);
        await this.repo.increment(owner, 1);
        const after = await this.clamp(userId, row.maxStreak);
        await this.outbox.add({
          type: 'protection.awarded',
          payload: { userId, habitId, weekStart, balance: after.balance, cap: after.cap },
          userId,
        });
        return true;
      });
      if (awarded) awards += 1;
    }
    return awards;
  }

  // The worker: every user with settled days in the look-back window, one at a time, so one
  // user's failure never stops the others.
  async awardAll(now: Date): Promise<number> {
    const utcToday = now.toISOString().slice(0, 10);
    const system = Owner.system();
    const users = await this.repo.usersSettledBetween(system, addDays(utcToday, -LOOKBACK_DAYS), addDays(utcToday, 1));
    let total = 0;
    for (const userId of users) {
      try {
        total += await this.awardWeeklyForUser(userId);
      } catch (e) {
        this.log.error('weekly award failed', { userId, error: String(e) });
      }
    }
    await this.uow.run(() => this.repo.pruneSettledBefore(system, addDays(utcToday, -KEEP_DAYS)));
    return total;
  }

  private async clamp(userId: string, maxStreak: number): Promise<FreezeBalanceDto> {
    const owner = Owner.user(userId);
    const cap = await this.plan.freezeCap(userId, maxStreak);
    const balance = await this.repo.clampToCap(owner, cap);
    return { userId, balance, cap };
  }
}
