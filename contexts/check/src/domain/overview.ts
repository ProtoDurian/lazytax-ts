// The habit overview (LazyTax Domain/Habit/HabitOverviewService.cs): every habit of the user with
// its streak, its week, today's deadline, its debt, and the month's skips.
import type { AccountV1 } from '@lazytax/account-contract/v1';
import type { CharityV1 } from '@lazytax/charity-contract/v1';
import type { HabitV1 } from '@lazytax/habit-contract/v1';
import type { Clock, Owner } from '@lazytax/kernel';
import type { PlanV1 } from '@lazytax/plan-contract/v1';
import { MANUAL_PROOF } from './check-service';
import type { CheckStore } from './store';
import { type StreakStatus, streakStatus } from './streak';
import { hhmm, isScheduledOn, localDate, monthBounds, resolveTimezone, toStandardDate, windowFor } from './window';

interface OverviewHabit {
  id: string;
  name: string;
  notificationTime: string;
  timezone: string;
  days: boolean[];
  stake: { amount: number; currency: string };
  enabled: boolean;
  charity: { id: string; name: string; url: string | null } | null;
  status: Omit<StreakStatus, 'timeLeftToEodMinutes'>;
  timeLeftToEodMinutes: number;
  version: { id: string; version: number; isActive: boolean };
  totalDebt: string;
  deadlineTime: string;
  todayDeadlineUtc: string | null;
  proof: string;
  routineId: string | null;
  sortOrder: number;
}

export interface Overview {
  habits: OverviewHabit[];
  totalDebt: string;
  usedSkip: number;
  totalSkip: number;
}

export interface OverviewDeps {
  account: AccountV1;
  plan: PlanV1;
  habit: HabitV1;
  charity: CharityV1;
}

const WEEK = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Integer cents -> "12.34" (LazyTax decimal.ToString("F2")).
const money = (cents: number): string => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

export class OverviewService {
  constructor(
    private readonly repo: CheckStore,
    private readonly deps: OverviewDeps,
    private readonly clock: Clock,
  ) {}

  async get(owner: Owner, limit: number, skip: number): Promise<Overview> {
    if (owner.kind !== 'user') throw new Error('overview needs Owner.user');
    const userId = owner.userId;
    // 404 when the user has no configuration, as LazyTax.
    const userTz = resolveTimezone(await this.deps.account.getTimezone(userId));
    const now = this.clock.now();
    const today = localDate(now, userTz);
    const versions = await this.deps.habit.listCurrent(owner, { limit, skip });
    const habitIds = versions.map(v => v.habitId);

    const debts = new Map((await this.repo.openDebts(owner)).map(d => [d.habitId, d.cents]));
    let totalDebt = 0;
    for (const c of debts.values()) totalDebt += c;
    const month = monthBounds(today);
    const usedSkip = await this.repo.countSkips(owner, month.start, month.end);
    const totalSkip = (await this.deps.plan.quota(userId, 'skips')).limit;
    const days = await this.repo.daysForHabits(owner, habitIds);
    const checks = new Map((await this.repo.listForDate(owner, habitIds, today)).map(c => [c.habitId, c]));
    const charityIds = [...new Set(versions.flatMap(v => (v.charityId ? [v.charityId] : [])))];
    const charities = new Map(
      (charityIds.length ? await this.deps.charity.getMany(charityIds) : []).map(c => [c.id, c]),
    );

    const habits = versions.map((v, i): OverviewHabit => {
      const { timeLeftToEodMinutes, ...status } = streakStatus(days.get(v.habitId) ?? [], userTz, v.deadlineTime, now);
      const scheduled = new Set(v.daysOfWeek.map(d => d.toLowerCase()));
      const check = checks.get(v.habitId);
      // Today's check end: the stored check when it exists (it may have been retimed), else the
      // window the scheduler will open. null on days the habit is not scheduled.
      const todayDeadline = check
        ? check.deadline
        : isScheduledOn(v.daysOfWeek, today)
          ? windowFor(today, userTz, v.deadlineTime).deadline
          : null;
      const charity = v.charityId ? charities.get(v.charityId) : undefined;
      return {
        id: v.habitId,
        name: v.task,
        notificationTime: hhmm(v.notificationTime),
        timezone: userTz,
        days: WEEK.map(d => scheduled.has(d)),
        stake: { amount: v.stakeCents / 100, currency: v.currency },
        enabled: v.enabled,
        charity: v.charityId ? { id: v.charityId, name: charity?.name ?? '', url: null } : null,
        status: { ...status, today: toStandardDate(status.today) },
        timeLeftToEodMinutes,
        version: { id: v.id, version: v.version, isActive: true },
        totalDebt: money(debts.get(v.habitId) ?? 0),
        deadlineTime: hhmm(v.deadlineTime),
        todayDeadlineUtc: todayDeadline?.toISOString() ?? null,
        proof: MANUAL_PROOF,
        routineId: v.routineId,
        sortOrder: skip + i,
      };
    });
    return { habits, totalDebt: money(totalDebt), usedSkip, totalSkip };
  }
}
