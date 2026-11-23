// The daily checks: open, settle, retime (LazyTax Domain/Check/Service.cs). check reads habits only
// through habit.v1, the zone through account.v1, and protections through vacation.v1 and
// protection.v1. Side effects leave through the outbox (check.settled).
import { randomUUID } from 'node:crypto';
import type { AccountV1 } from '@lazytax/account-contract/v1';
import type {
  CheckDto,
  CheckSettled,
  CheckV1,
  EvidenceDto,
  ExecutionDto,
  SettledStatus,
  StreakDto,
} from '@lazytax/check-contract/v1';
import type { HabitV1, HabitVersionDto } from '@lazytax/habit-contract/v1';
import { type Clock, type Logger, type Outbox, Owner, Problem, type UnitOfWork } from '@lazytax/kernel';
import type { PlanV1 } from '@lazytax/plan-contract/v1';
import type { ProtectionV1 } from '@lazytax/protection-contract/v1';
import type { VacationV1 } from '@lazytax/vacation-contract/v1';
import type {
  CheckRow,
  ExecutionRow,
  ExecutionSearch,
  NewCheck,
  Schedulable,
  SettleCommand,
  SettledCheck,
  SettleOutcome,
} from './model';
import type { CheckStore } from './store';
import { currentStreak, maxStreak } from './streak';
import {
  addDays,
  DEFAULT_DEADLINE,
  GRACE_MS,
  isScheduledOn,
  isValidTimezone,
  localDate,
  monthBounds,
  resolveTimezone,
  windowFor,
} from './window';

export const MANUAL_PROOF = 'manual';
const CLOSE_BATCH = 500;

export interface CheckDeps {
  account: AccountV1;
  plan: PlanV1;
  habit: HabitV1;
  vacation: VacationV1;
  protection: ProtectionV1;
}

// Same failure the complete and skip endpoints returned before checks existed (404).
const notCompletable = (habitVersionId: string) =>
  new Problem({
    kind: 'not_found',
    id: 'entity_not_found',
    title: 'Entity Not Found',
    detail: 'Habit not found, not enabled, not scheduled for this day, or already has execution',
    data: { entity: 'HabitExecution', requestIdentifier: habitVersionId },
  });

const habitNotFound = (habitId: string) =>
  new Problem({
    kind: 'not_found',
    id: 'entity_not_found',
    title: 'Entity Not Found',
    detail: 'Habit not found or not enabled',
    data: { entity: 'Habit', requestIdentifier: habitId },
  });

const toExecutionDto = (e: ExecutionRow): ExecutionDto => ({
  id: e.id,
  habitId: e.habitId,
  habitVersionId: e.habitVersionId,
  userId: e.userId,
  date: e.date,
  status: e.status,
  completedAt: e.completedAt?.toISOString() ?? null,
  notes: e.notes,
});

const toCheckDto = (c: CheckRow): CheckDto => ({
  id: c.id,
  habitId: c.habitId,
  userId: c.userId,
  localDate: c.localDate,
  timezone: c.timezone,
  opensAt: c.opensAt.toISOString(),
  deadline: c.deadline.toISOString(),
  status: c.status,
  settledAt: c.settledAt?.toISOString() ?? null,
  settledBy: c.settledBy,
  executionId: c.executionId,
});

const isNotFound = (e: unknown) => e instanceof Problem && e.kind === 'not_found';

export class CheckService implements CheckV1 {
  constructor(
    private readonly repo: CheckStore,
    private readonly deps: CheckDeps,
    private readonly uow: UnitOfWork,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  // ── Schedulable habits ────────────────────────────────────────────────────────────────────

  // Enabled live habits with their current version; the user's zone wins over the habit's.
  async schedulable(userIds?: string[], habitIds?: string[]): Promise<Schedulable[]> {
    const versions = await this.deps.habit.listSchedulable(userIds, habitIds);
    const zones = new Map<string, string | null>();
    for (const userId of new Set(versions.map(v => v.userId))) {
      try {
        zones.set(userId, await this.deps.account.getTimezone(userId));
      } catch (e) {
        if (!isNotFound(e)) throw e;
        zones.set(userId, null);
      }
    }
    return versions.map(v => toSchedulable(v, zones.get(v.userId) ?? null));
  }

  private async schedulableOne(userId: string, habitId: string): Promise<Schedulable> {
    const [h] = await this.schedulable([userId], [habitId]);
    if (!h || h.userId !== userId) throw habitNotFound(habitId);
    return h;
  }

  // ── The tick ──────────────────────────────────────────────────────────────────────────────

  // Creates the pending checks for today and tomorrow (user-local) of every enabled habit.
  async openUpcoming(now: Date): Promise<number> {
    const checks: NewCheck[] = [];
    for (const h of await this.schedulable()) {
      const today = localDate(now, h.timezone);
      for (const date of [today, addDays(today, 1)]) {
        if (!isScheduledOn(h.daysOfWeek, date)) continue;
        const w = windowFor(date, h.timezone, h.deadlineTime);
        // Never open a day whose deadline already passed (a habit created after its deadline).
        if (w.deadline <= now) continue;
        checks.push({ userId: h.userId, habitId: h.habitId, localDate: date, timezone: h.timezone, ...w });
      }
    }
    if (checks.length === 0) return 0;
    return this.uow.run(() => this.repo.createPending(Owner.system(), checks));
  }

  // Settles every pending check past deadline + grace: vacation, then freeze, then missed.
  async closeDue(now: Date): Promise<number> {
    const due = await this.repo.listDuePending(Owner.system(), new Date(now.getTime() - GRACE_MS), CLOSE_BATCH);
    if (due.length === 0) return 0;
    return (await this.settleDue(due, now)).length;
  }

  // One scheduler tick (LazyTax Tick without DispatchEvents: the kernel outbox delivers).
  async tick(now: Date): Promise<number> {
    const opened = await this.openUpcoming(now);
    const closed = await this.closeDue(now);
    this.log.info('check tick', { opened, closed });
    return opened + closed;
  }

  // Per user and date, each in its own unit of work: one user's failure never stops the batch;
  // its checks stay pending and are retried on the next tick.
  private async settleDue(due: CheckRow[], now: Date): Promise<SettledCheck[]> {
    const habits = await this.schedulable(undefined, [...new Set(due.map(c => c.habitId))]);
    const byId = new Map(habits.map(h => [h.habitId, h]));
    // Checks of habits disabled, deleted or unscheduled for that weekday since they opened.
    const stale = due.filter(c => {
      const h = byId.get(c.habitId);
      return !h || !isScheduledOn(h.daysOfWeek, c.localDate);
    });
    if (stale.length > 0)
      await this.uow.run(() =>
        this.repo.deletePending(
          Owner.system(),
          stale.map(c => c.id),
        ),
      );
    const staleIds = new Set(stale.map(c => c.id));

    const groups = new Map<string, CheckRow[]>();
    for (const c of due) {
      if (staleIds.has(c.id)) continue;
      const key = `${c.userId}\u0000${c.localDate}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }

    const settled: SettledCheck[] = [];
    for (const group of groups.values()) {
      const first = group[0];
      if (!first) continue;
      const { userId, localDate: date } = first;
      try {
        const done = await this.uow.run(async () => {
          await this.uow.lockUser(userId);
          const out: SettledCheck[] = [];
          const recorded = await this.repo.listRecorded(
            Owner.user(userId),
            group.map(c => c.id),
          );
          // A fully recorded day only gets adopted; it never spends a freeze.
          const missing = group.some(c => !recorded.has(c.id));
          const status = missing ? await this.protectionFor(userId, date) : 'missed';
          const settledBy = status === 'vacation' ? 'vacation' : status === 'frozen' ? 'freeze' : 'scheduler';
          for (const c of group) {
            const habit = byId.get(c.habitId);
            if (!habit) continue;
            const outcome = await this.settle({ checkId: c.id, habit, status, settledBy, settledAt: now });
            if (outcome && !outcome.adopted) out.push({ habitId: c.habitId, localDate: date, status });
          }
          return out;
        });
        settled.push(...done);
      } catch (e) {
        this.log.error('closeDue failed', { userId, date, error: String((e as Error)?.message ?? e) });
      }
    }
    return settled;
  }

  // Vacation first, then one freeze for the whole day (capped by plan through protection).
  private async protectionFor(userId: string, date: string): Promise<SettledStatus> {
    if (await this.deps.vacation.isAway(userId, date)) return 'vacation';
    await this.deps.protection.reconcileCap(userId, await this.maxStreak(userId));
    return (await this.deps.protection.tryConsumeFreeze(userId, date)) ? 'frozen' : 'missed';
  }

  // ── Settle ────────────────────────────────────────────────────────────────────────────────

  // Settles one pending check in one unit of work under the user's lock: records the execution
  // (or adopts the day's existing one), links it, records the evidence, and writes check.settled.
  // null when the check is no longer pending or the evidence was already recorded.
  async settle(cmd: SettleCommand): Promise<SettleOutcome | null> {
    const { habit } = cmd;
    const owner = Owner.user(habit.userId);
    return this.uow.run(async () => {
      await this.uow.lockUser(habit.userId);
      const check = await this.repo.lockForSettle(owner, cmd.checkId);
      if (check?.status !== 'pending') return null;
      if (
        cmd.evidence &&
        (await this.repo.evidenceExists(owner, check.habitId, cmd.evidence.proofKey, cmd.evidence.externalId))
      )
        return null;
      // A user's skip counts against the month's skips, under the user's lock.
      if (cmd.status === 'skipped' && cmd.skipQuota) {
        const q = cmd.skipQuota;
        const used = await this.repo.countSkips(owner, q.monthStart, q.monthEnd);
        this.deps.plan.ensureWithin({ tier: q.tier, key: q.key, limit: q.limit }, used);
      }
      const inserted = await this.repo.insertExecution(owner, {
        userId: habit.userId,
        habitId: check.habitId,
        habitVersionId: habit.versionId,
        date: check.localDate,
        status: cmd.status,
        completedAt: cmd.status === 'done' ? (cmd.completedAt ?? null) : null,
        notes: cmd.notes ?? null,
        stakeCents: habit.stakeCents,
        ratioBps: habit.ratioBps,
        currency: habit.currency,
        charityId: habit.charityId,
      });
      const adopted = inserted === null;
      const execution = inserted ?? (await this.repo.executionForDate(owner, check.habitId, check.localDate));
      if (!execution) throw new Error(`check ${check.id}: day ${check.localDate} has no execution to adopt`);
      await this.repo.markSettled(owner, check.id, {
        status: execution.status,
        settledAt: cmd.settledAt,
        settledBy: adopted ? 'adopted' : cmd.settledBy,
        executionId: execution.id,
      });
      if (cmd.evidence && !adopted)
        await this.repo.insertEvidence(owner, {
          userId: habit.userId,
          habitId: check.habitId,
          checkId: check.id,
          ...cmd.evidence,
          receivedAt: cmd.settledAt,
        });
      const payload: CheckSettled = {
        userId: habit.userId,
        habitId: check.habitId,
        habitVersionId: execution.habitVersionId,
        checkId: check.id,
        executionId: execution.id,
        date: check.localDate,
        status: execution.status,
        stakeCents: habit.stakeCents,
        ratioBps: habit.ratioBps,
        currency: habit.currency,
        charityId: habit.charityId,
        maxStreak: await this.maxStreak(habit.userId),
        adopted,
      };
      await this.outbox.add({ type: 'check.settled', payload, userId: habit.userId });
      return { execution, adopted };
    });
  }

  // The pending check whose window holds `at`. If two windows ever overlap, the earlier day
  // settles first, so both days need their own completion.
  private async openCheckAt(habit: Schedulable, at: Date): Promise<CheckRow | null> {
    const owner = Owner.user(habit.userId);
    const covering = await this.repo.listCovering(owner, habit.habitId, at);
    const pending = covering
      .filter(c => c.status === 'pending')
      .sort((a, b) => a.localDate.localeCompare(b.localDate))[0];
    if (pending) return pending;
    if (covering.length > 0) return null; // that moment's day is already settled

    // No check yet (a habit created since the last tick): open it now.
    const date = localDate(at, habit.timezone);
    if (!isScheduledOn(habit.daysOfWeek, date)) return null;
    const w = windowFor(date, habit.timezone, habit.deadlineTime);
    if (at < w.opensAt || at >= w.deadline) return null;
    const check = await this.uow.run(async () => {
      await this.repo.createPending(owner, [
        { userId: habit.userId, habitId: habit.habitId, localDate: date, timezone: habit.timezone, ...w },
      ]);
      return this.repo.getForDay(owner, habit.habitId, date);
    });
    return check && check.status === 'pending' && check.opensAt <= at && at < check.deadline ? check : null;
  }

  // ── check.v1 ──────────────────────────────────────────────────────────────────────────────

  async report(userId: string, habitId: string, evidence: EvidenceDto): Promise<ExecutionDto | null> {
    const now = this.clock.now();
    const habit = await this.schedulableOne(userId, habitId);
    const owner = Owner.user(userId);
    if (await this.repo.evidenceExists(owner, habitId, evidence.proofKey, evidence.externalId)) return null;
    // Clock skew: evidence can't be from the future.
    const reported = new Date(evidence.occurredAt);
    if (Number.isNaN(reported.getTime())) throw new Error('evidence.occurredAt is not an ISO 8601 instant');
    const occurred = reported > now ? now : reported;
    const check = await this.openCheckAt(habit, occurred);
    if (!check || now.getTime() > check.deadline.getTime() + GRACE_MS) return null;
    const status: SettledStatus = evidence.verdict === 'passed' ? 'done' : 'missed';
    const outcome = await this.settle({
      checkId: check.id,
      habit,
      status,
      settledBy: evidence.proofKey,
      settledAt: now,
      completedAt: status === 'done' ? occurred : null,
      notes: evidence.notes ?? null,
      evidence: {
        proofKey: evidence.proofKey,
        externalId: evidence.externalId,
        passed: evidence.verdict === 'passed',
        occurredAt: occurred,
        data: evidence.data ?? null,
      },
    });
    return outcome && !outcome.adopted ? toExecutionDto(outcome.execution) : null;
  }

  async pendingCheckAt(userId: string, habitId: string, at: string): Promise<CheckDto | null> {
    const now = this.clock.now();
    const habit = await this.schedulableOne(userId, habitId);
    const asked = new Date(at);
    const check = await this.openCheckAt(habit, asked > now ? now : asked);
    return !check || now.getTime() > check.deadline.getTime() + GRACE_MS ? null : toCheckDto(check);
  }

  async streaks(userId: string, habitIds: string[]): Promise<StreakDto[]> {
    if (habitIds.length === 0) return [];
    const byHabit = await this.repo.daysForHabits(Owner.user(userId), habitIds);
    let today: string;
    try {
      today = await this.deps.account.today(userId);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      today = localDate(this.clock.now(), 'UTC');
    }
    return habitIds.map(habitId => {
      const days = byHabit.get(habitId) ?? [];
      return { habitId, current: currentStreak(days, today), max: maxStreak(days) };
    });
  }

  // The longest run across the user's live habits (LazyTax GetUserMaxStreakAcrossHabits).
  async maxStreak(userId: string): Promise<number> {
    const byHabit = await this.repo.daysForLiveHabits(Owner.user(userId));
    let max = 0;
    for (const days of byHabit.values()) max = Math.max(max, maxStreak(days));
    return max;
  }

  async getExecution(owner: Owner, executionId: string): Promise<ExecutionDto | null> {
    const e = await this.repo.getExecution(owner, executionId);
    return e ? toExecutionDto(e) : null;
  }

  async ownsExecution(userId: string, executionId: string): Promise<boolean> {
    return (await this.repo.getExecution(Owner.user(userId), executionId)) !== null;
  }

  async executionForDate(owner: Owner, habitId: string, date: string): Promise<ExecutionDto | null> {
    const e = await this.repo.executionForDate(owner, habitId, date);
    return e ? toExecutionDto(e) : null;
  }

  // ── Routes ────────────────────────────────────────────────────────────────────────────────

  // POST /Habit/:userId/:habitVersionId/executions: the app, widget and NFC tap complete through
  // the manual proof.
  async complete(owner: Owner, habitVersionId: string, notes: string | null): Promise<ExecutionRow> {
    if (owner.kind !== 'user') throw new Error('complete needs Owner.user');
    // The first read is owner-scoped: another user's version id is 404.
    const hv = await this.deps.habit.getVersion(owner, habitVersionId);
    if (!hv) throw notCompletable(habitVersionId);
    let execution: ExecutionDto | null;
    try {
      execution = await this.report(owner.userId, hv.habitId, {
        proofKey: MANUAL_PROOF,
        externalId: randomUUID(),
        verdict: 'passed',
        occurredAt: this.clock.now().toISOString(),
        notes,
      });
    } catch (e) {
      if (isNotFound(e)) throw notCompletable(habitVersionId);
      throw e;
    }
    if (!execution) throw notCompletable(habitVersionId);
    return this.mustExecution(owner, execution.id);
  }

  // POST /Habit/:userId/:habitVersionId/executions/skip: skips the check open now, within the
  // user's monthly skips (counted under the user's lock).
  async skip(owner: Owner, habitVersionId: string, notes: string | null): Promise<ExecutionRow> {
    if (owner.kind !== 'user') throw new Error('skip needs Owner.user');
    const userId = owner.userId;
    // The owner's bug (LazyTax Domain/Habit/Service.cs:93-97): the first read is owner-scoped.
    const hv = await this.deps.habit.getVersion(owner, habitVersionId);
    if (!hv) throw notCompletable(habitVersionId);
    const month = monthBounds(await this.deps.account.today(userId));
    const quota = await this.deps.plan.quota(userId, 'skips');
    let habit: Schedulable;
    try {
      habit = await this.schedulableOne(userId, hv.habitId);
    } catch (e) {
      if (isNotFound(e)) throw notCompletable(habitVersionId);
      throw e;
    }
    const now = this.clock.now();
    const check = await this.openCheckAt(habit, now);
    if (!check) throw notCompletable(habitVersionId);
    const outcome = await this.settle({
      checkId: check.id,
      habit,
      status: 'skipped',
      settledBy: MANUAL_PROOF,
      settledAt: now,
      notes,
      skipQuota: { ...quota, monthStart: month.start, monthEnd: month.end },
    });
    if (!outcome || outcome.adopted) throw notCompletable(habitVersionId);
    return outcome.execution;
  }

  async searchExecutions(owner: Owner, q: ExecutionSearch): Promise<ExecutionRow[]> {
    return this.repo.searchExecutions(owner, q);
  }

  private async mustExecution(owner: Owner, id: string): Promise<ExecutionRow> {
    const e = await this.repo.getExecution(owner, id);
    if (!e) throw new Error(`execution ${id} vanished after its settle`);
    return e;
  }

  // ── Subscribers ───────────────────────────────────────────────────────────────────────────

  // habit.changed: days, deadline or enabled may have changed. A started check never gets a
  // shorter deadline; checks no longer scheduled are removed (LazyTax RetimePending).
  retimePending(userId: string, habitIds: string[]): Promise<number> {
    return this.retime(userId, habitIds, this.clock.now(), false);
  }

  // habit.deleted: the habits' pending checks go, and their history leaves streaks.
  async habitsDeleted(userId: string, habitIds: string[]): Promise<void> {
    await this.uow.run(() => this.repo.markHabitsDeleted(Owner.user(userId), habitIds));
  }

  // proof.evidenceRevoked: the proof is gone (an NFC tag unlinked, Strava disconnected). The
  // evidence rows go, so the same external id can prove again; the day it proved stays done.
  async evidenceRevoked(userId: string, proofKey: string, externalId: string | null): Promise<number> {
    return this.uow.run(() => this.repo.deleteEvidence(Owner.user(userId), proofKey, externalId));
  }

  // account.timezoneChanged: pending checks follow the new zone, earlier or later. Days whose new
  // deadline + grace already passed are settled now (LazyTax MoveToTimezone).
  async moveToTimezone(userId: string): Promise<SettledCheck[]> {
    const now = this.clock.now();
    await this.retime(userId, undefined, now, true);
    const habits = await this.schedulable([userId]);
    if (habits.length === 0) return [];
    const pending = await this.repo.listPending(
      Owner.user(userId),
      habits.map(h => h.habitId),
    );
    const due = pending.filter(c => c.deadline.getTime() <= now.getTime() - GRACE_MS);
    return due.length === 0 ? [] : this.settleDue(due, now);
  }

  private async retime(
    userId: string,
    habitIds: string[] | undefined,
    now: Date,
    followTimezone: boolean,
  ): Promise<number> {
    const owner = Owner.user(userId);
    const habits = await this.schedulable([userId], habitIds);
    const byId = new Map(habits.map(h => [h.habitId, h]));
    return this.uow.run(async () => {
      const pending = await this.repo.listPending(owner, habitIds ?? [...byId.keys()]);
      let changed = 0;
      const stale: string[] = [];
      for (const c of pending) {
        const h = byId.get(c.habitId);
        if (!h || !isScheduledOn(h.daysOfWeek, c.localDate)) {
          stale.push(c.id);
          continue;
        }
        const w = windowFor(c.localDate, h.timezone, h.deadlineTime);
        const started = c.opensAt <= now;
        const deadline = followTimezone
          ? w.deadline
          : started
            ? w.deadline > c.deadline
              ? w.deadline
              : c.deadline
            : w.deadline > now
              ? w.deadline
              : c.deadline;
        const opensAt = w.opensAt >= deadline ? c.opensAt : w.opensAt;
        if (
          h.timezone === c.timezone &&
          opensAt.getTime() === c.opensAt.getTime() &&
          deadline.getTime() === c.deadline.getTime()
        )
          continue;
        if (await this.repo.updatePendingWindow(owner, c.id, h.timezone, opensAt, deadline)) changed++;
      }
      if (stale.length > 0) changed += await this.repo.deletePending(owner, stale);
      return changed;
    });
  }
}

function toSchedulable(v: HabitVersionDto, userTimezone: string | null): Schedulable {
  return {
    habitId: v.habitId,
    userId: v.userId,
    versionId: v.id,
    daysOfWeek: v.daysOfWeek,
    deadlineTime: v.deadlineTime || DEFAULT_DEADLINE,
    timezone: isValidTimezone(userTimezone) ? userTimezone : resolveTimezone(v.timezone),
    stakeCents: v.stakeCents,
    ratioBps: v.ratioBps,
    currency: v.currency,
    charityId: v.charityId,
  };
}
