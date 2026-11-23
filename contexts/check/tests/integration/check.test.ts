import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Owner } from '@lazytax/kernel';
import { type Actor, expectOwnerScoped, expectProblem, startTestApp, type TestApp } from '@lazytax/kernel/testing';

// Monday 23 Nov 2026, 10:00 in Singapore.
const MON_10_SG = '2026-11-23T02:00:00Z';
const ALL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({
    contexts: ['check'],
    now: MON_10_SG,
    config: {
      plan: {
        tiers: {
          free: {
            priceCents: 0,
            currency: 'USD',
            habitsMax: 10,
            skipsMonthly: 1,
            vacationWindowsYearly: 2,
            freezeBase: 0,
          },
        },
      },
    },
  });
});
afterAll(() => app.close());

interface VersionRes {
  id: string;
  habitId: string;
}

const configure = async (a: Actor, timezone = 'Asia/Singapore') => {
  const res = await app.request(a, { method: 'POST', path: `/api/v1/Configuration/${a.sub}`, body: { timezone } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
};

const habit = async (a: Actor, over: Record<string, unknown> = {}): Promise<VersionRes> => {
  const res = await app.request(a, {
    method: 'POST',
    path: `/api/v1/Habit/${a.sub}`,
    body: {
      task: 'Run',
      daysOfWeek: ALL_DAYS,
      notificationTime: '07:00:00',
      stake: '0',
      timezone: 'Asia/Singapore',
      ...over,
    },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as VersionRes;
};

// A registered, configured user with one habit.
const setup = async () => {
  const a = await app.user();
  await configure(a);
  return { a, v: await habit(a) };
};

const complete = (caller: Actor, versionId: string, notes: string | null = null) =>
  app.request(caller, {
    method: 'POST',
    path: `/api/v1/Habit/${caller.sub}/${versionId}/executions`,
    body: { notes },
  });
const skip = (caller: Actor, versionId: string) =>
  app.request(caller, { method: 'POST', path: `/api/v1/Habit/${caller.sub}/${versionId}/executions/skip`, body: {} });

const rowsOf = async (habitId: string) => ({
  checks: await app.sql`SELECT id, status, execution_id FROM "check".checks WHERE habit_id = ${habitId} ORDER BY id`,
  executions: await app.sql`SELECT id, status FROM "check".executions WHERE habit_id = ${habitId} ORDER BY id`,
});

const tick = async () => {
  const admin = await app.admin();
  const res = await app.request(admin, { method: 'POST', path: '/api/v1/habit-cron/mark-daily-failures' });
  expect(res.status).toBe(200);
  return ((await res.json()) as { totalMarked: number }).totalMarked;
};

describe('complete', () => {
  it("should complete today's check and answer in the LazyTax shape", async () => {
    // Arrange
    app.clock.set(MON_10_SG);
    const { a, v } = await setup();
    // Act
    const res = await complete(a, v.id, 'felt good');
    // Assert
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ habitVersionId: v.id, date: '23-11-2026', status: 'succeeded', notes: 'felt good' });
    expect(body.paymentProcessed).toBe(false);
  });

  it('should 404 a second completion of the same day', async () => {
    // Arrange
    app.clock.set(MON_10_SG);
    const { a, v } = await setup();
    await complete(a, v.id);
    // Act
    const res = await complete(a, v.id);
    // Assert
    await expectProblem(res, 404, 'entity_not_found');
  });

  it("should 404 user B completing user A's habit version, and change nothing", async () => {
    app.clock.set(MON_10_SG);
    await expectOwnerScoped(app, {
      seed: async a => {
        await configure(a);
        return (await habit(a)).id;
      },
      request: (id, b) => ({ method: 'POST', path: `/api/v1/Habit/${b.sub}/${id}/executions`, body: {} }),
      unchanged: async id => {
        const [row] = (await app.sql`SELECT habit_id FROM habit.habit_versions WHERE id = ${id}`) as {
          habit_id: string;
        }[];
        return rowsOf(row?.habit_id ?? '00000000-0000-0000-0000-000000000000');
      },
    });
  });

  it('should complete through the MCP tool with the same rules', async () => {
    // Arrange
    app.clock.set(MON_10_SG);
    const { a, v } = await setup();
    const b = await app.user();
    // Act
    const ok = await app.mcp(a, 'check.complete', { userId: a.sub, habitVersionId: v.id });
    const other = await app.mcp(b, 'check.complete', { userId: a.sub, habitVersionId: v.id });
    // Assert
    expect(ok.ok).toBe(true);
    expect((ok.data as { status: string }).status).toBe('succeeded');
    expect(other.ok).toBe(false);
    expect(other.problem?.status).toBe(403);
  });
});

describe('auth layers', () => {
  it('should 401 without a token', async () => {
    const { a, v } = await setup();
    const res = await app.request(null, {
      method: 'POST',
      path: `/api/v1/Habit/${a.sub}/${v.id}/executions`,
      body: {},
    });
    expect(res.status).toBe(401);
  });

  it("should 403 a user on another user's path", async () => {
    const { a, v } = await setup();
    const b = await app.user();
    const res = await app.request(b, { method: 'POST', path: `/api/v1/Habit/${a.sub}/${v.id}/executions`, body: {} });
    await expectProblem(res, 403);
  });

  it('should 403 a non-admin on the cron route', async () => {
    const a = await app.user();
    const res = await app.request(a, { method: 'POST', path: '/api/v1/habit-cron/mark-daily-failures' });
    await expectProblem(res, 403);
  });
});

describe('skip', () => {
  // The owner's bug (LazyTax Domain/Habit/Service.cs:93-97): SkipHabit read the version by id only.
  it("should 404 user B skipping user A's habit version id, and change no check or execution row", async () => {
    // Arrange: A's checks exist (the tick opened them)
    app.clock.set(MON_10_SG);
    const { a, v } = await setup();
    await tick();
    const b = await app.user();
    await configure(b);
    const before = JSON.stringify(await rowsOf(v.habitId));
    expect((await rowsOf(v.habitId)).checks.length).toBeGreaterThan(0);
    // Act
    const res = await skip(b, v.id);
    // Assert
    await expectProblem(res, 404, 'entity_not_found');
    expect(JSON.stringify(await rowsOf(v.habitId))).toBe(before);
    expect(a.sub).not.toBe(b.sub);
  });

  it('should skip within the month quota and refuse past it', async () => {
    // Arrange: free tier has 1 skip a month here
    app.clock.set(MON_10_SG);
    const { a, v } = await setup();
    const w = await habit(a, { task: 'Read' });
    // Act
    const first = await skip(a, v.id);
    const second = await skip(a, w.id);
    // Assert
    expect(first.status).toBe(200);
    expect(((await first.json()) as { status: string }).status).toBe('skip');
    await expectProblem(second, 400, 'tier_insufficient');
    expect((await rowsOf(w.habitId)).executions).toHaveLength(0);
  });

  it('should let only one of two concurrent skips through (count then write under the lock)', async () => {
    // Arrange
    app.clock.set(MON_10_SG);
    const { a, v } = await setup();
    const w = await habit(a, { task: 'Read' });
    // Act
    const results = await Promise.all([skip(a, v.id), skip(a, w.id)]);
    // Assert
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
    const [n] = (await app.sql`
      SELECT count(*)::int AS n FROM "check".executions WHERE user_id = ${a.sub} AND status = 'skipped'`) as {
      n: number;
    }[];
    expect(n?.n).toBe(1);
  });
});

describe('executions and overview', () => {
  it("should list only the caller's executions, filtered by habit and dd-MM-yyyy date", async () => {
    // Arrange
    app.clock.set(MON_10_SG);
    const { a, v } = await setup();
    await complete(a, v.id);
    const b = await app.user();
    // Act
    const mine = await app.request(a, {
      method: 'GET',
      path: `/api/v1/Habit/${a.sub}/executions`,
      query: { id: v.habitId, date: '23-11-2026' },
    });
    const theirs = await app.request(b, {
      method: 'GET',
      path: `/api/v1/Habit/${b.sub}/executions`,
      query: { id: v.habitId },
    });
    const bad = await app.request(a, {
      method: 'GET',
      path: `/api/v1/Habit/${a.sub}/executions`,
      query: { date: '2026-11-23' },
    });
    // Assert
    expect(((await mine.json()) as unknown[]).length).toBe(1);
    expect(await theirs.json()).toEqual([]);
    await expectProblem(bad, 400, 'validation_error');
  });

  it("should not hand user B user A's execution through the contract", async () => {
    // Arrange
    app.clock.set(MON_10_SG);
    const { a, v } = await setup();
    const id = ((await (await complete(a, v.id)).json()) as { id: string }).id;
    const check = app.contract('check.v1');
    // Act & Assert
    expect(await check.getExecution(Owner.user(a.sub), id)).not.toBeNull();
    expect(await check.getExecution(Owner.user('someone-else'), id)).toBeNull();
    expect(await check.ownsExecution('someone-else', id)).toBe(false);
    expect((await check.executionForDate(Owner.user(a.sub), v.habitId, '2026-11-23'))?.status).toBe('done');
    expect(await check.executionForDate(Owner.user('someone-else'), v.habitId, '2026-11-23')).toBeNull();
  });

  it('should show the streak, the week and the skips in the overview', async () => {
    // Arrange
    app.clock.set(MON_10_SG);
    const { a, v } = await setup();
    await complete(a, v.id);
    // Act
    const res = await app.request(a, { method: 'GET', path: `/api/v1/Habit/${a.sub}/overview` });
    // Assert
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      habits: {
        id: string;
        days: boolean[];
        status: { currentStreak: number; today: string; todayStatus: string; week: { monday: string } };
        todayDeadlineUtc: string;
        totalDebt: string;
        proof: string;
      }[];
      totalDebt: string;
      usedSkip: number;
      totalSkip: number;
    };
    expect(body.totalDebt).toBe('0.00');
    expect(body.usedSkip).toBe(0);
    expect(body.totalSkip).toBe(1);
    const item = body.habits[0];
    expect(item?.id).toBe(v.habitId);
    expect(item?.days).toEqual([true, true, true, true, true, true, true]);
    expect(item?.status).toMatchObject({ currentStreak: 1, today: '23-11-2026', todayStatus: 'succeeded' });
    expect(item?.status.week.monday).toBe('succeeded');
    expect(item?.todayDeadlineUtc).toBe('2026-11-23T16:00:00.000Z');
    expect(item?.proof).toBe('manual');
  });

  it('should 404 the overview of a user with no configuration', async () => {
    const a = await app.user();
    const res = await app.request(a, { method: 'GET', path: `/api/v1/Habit/${a.sub}/overview` });
    await expectProblem(res, 404);
  });
});

describe('the tick', () => {
  it('should open checks, then settle overdue ones as missed and emit check.settled', async () => {
    // Arrange
    app.clock.set(MON_10_SG);
    const { a, v } = await setup();
    await tick();
    // Act: Monday's deadline (24:00 SG) + grace has passed
    app.clock.set('2026-11-23T16:31:00Z');
    await tick();
    // Assert
    const rows = (await app.sql`
      SELECT date::text AS date, status FROM "check".executions WHERE habit_id = ${v.habitId}`) as {
      date: string;
      status: string;
    }[];
    expect(rows).toEqual([{ date: '2026-11-23', status: 'missed' }]);
    const events = (await app.sql`
      SELECT payload FROM kernel.outbox_events WHERE type = 'check.settled' AND user_id = ${a.sub}`) as {
      payload: { status: string; habitId: string };
    }[];
    expect(events.map(e => e.payload)).toEqual([expect.objectContaining({ status: 'missed', habitId: v.habitId })]);
  });

  it('should settle an overdue day as vacation when the user is away (vacation.v1)', async () => {
    // Arrange
    app.clock.set(MON_10_SG);
    const { a, v } = await setup();
    const res = await app.request(a, {
      method: 'POST',
      path: `/api/v1/Vacation/${a.sub}`,
      body: { startDate: '2026-11-23', endDate: '2026-11-24', timezone: 'Asia/Singapore' },
    });
    expect(res.status).toBe(200);
    await tick();
    // Act
    app.clock.set('2026-11-23T16:31:00Z');
    await tick();
    // Assert
    const rows = (await app.sql`
      SELECT e.status, c.settled_by FROM "check".executions e JOIN "check".checks c ON c.execution_id = e.id
      WHERE e.habit_id = ${v.habitId}`) as { status: string; settled_by: string }[];
    expect(rows).toEqual([{ status: 'vacation', settled_by: 'vacation' }]);
  });

  it('should move pending checks to the new zone when account.timezoneChanged arrives', async () => {
    // Arrange
    app.clock.set(MON_10_SG);
    const a = await app.user();
    const configId = await configure(a);
    const v = await habit(a);
    await tick();
    // Act
    const res = await app.request(a, {
      method: 'PUT',
      path: `/api/v1/Configuration/${a.sub}/${configId}`,
      body: { timezone: 'Europe/London' },
    });
    expect(res.status).toBe(200);
    await app.drainOutbox();
    // Assert: tomorrow's check now ends at London midnight
    const rows = (await app.sql`
      SELECT timezone, deadline FROM "check".checks
      WHERE habit_id = ${v.habitId} AND local_date = '2026-11-24' AND status = 'pending'`) as {
      timezone: string;
      deadline: Date;
    }[];
    expect(rows[0]?.timezone).toBe('Europe/London');
    expect(rows[0]?.deadline.toISOString()).toBe('2026-11-25T00:00:00.000Z');
  });

  it('should retime pending checks when habit.changed arrives', async () => {
    // Arrange: tomorrow's check exists
    app.clock.set(MON_10_SG);
    const { a, v } = await setup();
    await tick();
    // Act: the habit now runs on Mondays only
    const res = await app.request(a, {
      method: 'PUT',
      path: `/api/v1/Habit/${a.sub}/${v.habitId}`,
      body: {
        task: 'Run',
        daysOfWeek: ['Monday'],
        notificationTime: '07:00:00',
        stake: '0',
        enabled: true,
        timezone: 'Asia/Singapore',
      },
    });
    expect(res.status).toBe(200);
    await app.drainOutbox();
    // Assert
    const dates = (await app.sql`
      SELECT local_date::text AS d FROM "check".checks WHERE habit_id = ${v.habitId} AND status = 'pending'`) as {
      d: string;
    }[];
    expect(dates.map(r => r.d)).toEqual(['2026-11-23']);
  });
});

describe('account deletion', () => {
  it("should purge every check row of the user and leave other users' rows", async () => {
    // Arrange
    app.clock.set(MON_10_SG);
    const { a, v } = await setup();
    const { a: b, v: w } = await setup();
    await tick();
    await complete(a, v.id);
    await complete(b, w.id);
    // Act
    const res = await app.request(a, { method: 'DELETE', path: '/api/v1/User/Me' });
    // Assert
    expect(res.status).toBeLessThan(300);
    const count = async (sub: string) =>
      (
        (await app.sql`
        SELECT (SELECT count(*) FROM "check".checks WHERE user_id = ${sub})
             + (SELECT count(*) FROM "check".executions WHERE user_id = ${sub})
             + (SELECT count(*) FROM "check".evidence WHERE user_id = ${sub}) AS n`) as { n: string }[]
      )[0]?.n;
    expect(Number(await count(a.sub))).toBe(0);
    expect(Number(await count(b.sub))).toBeGreaterThan(0);
  });
});
