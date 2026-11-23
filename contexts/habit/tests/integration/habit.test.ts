import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { HabitV1 } from '@lazytax/habit-contract/v1';
import { Owner } from '@lazytax/kernel';
import { type Actor, expectOwnerScoped, expectProblem, startTestApp, type TestApp } from '@lazytax/kernel/testing';

let app: TestApp;
let charityId: string;

beforeAll(async () => {
  app = await startTestApp({ contexts: ['habit'], config: { plan: { tiers: { free: { habitsMax: 50 } } } } });
  const rows = await app.sql`INSERT INTO charity.charities (name) VALUES ('Test Charity') RETURNING id`;
  charityId = (rows as { id: string }[])[0]?.id as string;
});
afterAll(() => app.close());

const body = (over: Record<string, unknown> = {}) => ({
  task: 'Run',
  daysOfWeek: ['monday', 'Friday'],
  notificationTime: '07:00:00',
  stake: '0',
  timezone: 'Asia/Singapore',
  ...over,
});

const create = (a: Actor, over: Record<string, unknown> = {}) =>
  app.request(a, { method: 'POST', path: `/api/v1/Habit/${a.sub}`, body: body(over) });
const createOk = async (a: Actor, over: Record<string, unknown> = {}) => {
  const res = await create(a, over);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    id: string;
    habitId: string;
    version: number;
    stake: string;
    ratio: string;
    daysOfWeek: string[];
  };
};
const habitIdsOf = async (a: Actor) =>
  (
    (await (await app.request(a, { method: 'GET', path: `/api/v1/Habit/${a.sub}` })).json()) as { habitId: string }[]
  ).map(h => h.habitId);

describe('habit routes', () => {
  it('should create a habit and answer in the LazyTax shape', async () => {
    const a = await app.user();
    const v = await createOk(a, { stake: '10.5', charityId });
    expect(v.version).toBe(1);
    expect(v.stake).toBe('10.50');
    expect(v.ratio).toBe('100.0');
    expect(v.daysOfWeek).toEqual(['Monday', 'Friday']);
  });

  it('should write a new version on update and keep the old one readable', async () => {
    const a = await app.user();
    const v1 = await createOk(a);
    const res = await app.request(a, {
      method: 'PUT',
      path: `/api/v1/Habit/${a.sub}/${v1.habitId}`,
      body: { ...body({ task: 'Run far' }), enabled: true },
    });
    expect(res.status).toBe(200);
    const v2 = (await res.json()) as { id: string; version: number; task: string };
    expect(v2.version).toBe(2);
    const habit = app.contract('habit.v1') as HabitV1;
    expect((await habit.listVersions(Owner.user(a.sub), v1.habitId)).map(v => v.version)).toEqual([2, 1]);
    expect((await habit.getVersion(Owner.user(a.sub), v1.id))?.task).toBe('Run');
    expect((await habit.getCurrent(Owner.user(a.sub), v1.habitId))?.id).toBe(v2.id);
  });

  it('should 400 a stake without a charity, an unknown charity and a bad body', async () => {
    const a = await app.user();
    await expectProblem(await create(a, { stake: '5.00' }), 400, 'validation_error');
    await expectProblem(
      await create(a, { stake: '5.00', charityId: '33333333-3333-4333-8333-333333333333' }),
      400,
      'validation_error',
    );
    await expectProblem(await create(a, { timezone: 'Nope/Nope' }), 400, 'validation_error');
  });

  it('should search by task and enabled, in the user order', async () => {
    const a = await app.user();
    await createOk(a, { task: 'Read' });
    const run = await createOk(a, { task: 'Run' });
    await app.request(a, {
      method: 'PUT',
      path: `/api/v1/Habit/${a.sub}/${run.habitId}`,
      body: { ...body({ task: 'Run' }), enabled: false },
    });
    const only = await (
      await app.request(a, { method: 'GET', path: `/api/v1/Habit/${a.sub}`, query: { task: 'ru', enabled: 'false' } })
    ).json();
    expect((only as unknown[]).length).toBe(1);
    const all = (await (await app.request(a, { method: 'GET', path: `/api/v1/Habit/${a.sub}` })).json()) as {
      task: string;
    }[];
    expect(all.map(h => h.task)).toEqual(['Read', 'Run']);
  });

  it('should reorder: requested first, the rest after', async () => {
    const a = await app.user();
    const h1 = await createOk(a, { task: 'A' });
    const h2 = await createOk(a, { task: 'B' });
    const h3 = await createOk(a, { task: 'C' });
    const res = await app.request(a, {
      method: 'PUT',
      path: `/api/v1/Habit/${a.sub}/order`,
      body: { habitIds: [h3.habitId, h1.habitId] },
    });
    expect(await res.json()).toEqual({ habitIds: [h3.habitId, h1.habitId, h2.habitId] });
    expect(await habitIdsOf(a)).toEqual([h3.habitId, h1.habitId, h2.habitId]);
    await expectProblem(
      await app.request(a, {
        method: 'PUT',
        path: `/api/v1/Habit/${a.sub}/order`,
        body: { habitIds: [h1.habitId, h1.habitId] },
      }),
      400,
      'validation_error',
    );
  });

  it("should not reorder with another user's habit id", async () => {
    const a = await app.user();
    const b = await app.user();
    const ha = await createOk(a);
    const hb = await createOk(b);
    await expectProblem(
      await app.request(b, { method: 'PUT', path: `/api/v1/Habit/${b.sub}/order`, body: { habitIds: [ha.habitId] } }),
      400,
      'validation_error',
    );
    expect(await habitIdsOf(b)).toEqual([hb.habitId]);
    expect(await habitIdsOf(a)).toEqual([ha.habitId]);
  });

  it('should emit habit.changed on update and habit.deleted on delete', async () => {
    const a = await app.user();
    const h = await createOk(a);
    await app.request(a, {
      method: 'PUT',
      path: `/api/v1/Habit/${a.sub}/${h.habitId}`,
      body: { ...body(), enabled: true },
    });
    await app.request(a, { method: 'DELETE', path: `/api/v1/Habit/${a.sub}/${h.habitId}` });
    const types =
      (await app.sql`SELECT type FROM kernel.outbox_events WHERE user_id = ${a.sub} ORDER BY created_at, id`) as {
        type: string;
      }[];
    expect(types.map(t => t.type).sort()).toEqual(['habit.changed', 'habit.changed', 'habit.deleted']);
  });
});

describe('auth layers', () => {
  it('should 401 without a token and 403 on another user path', async () => {
    const a = await app.user();
    const b = await app.user();
    await expectProblem(await app.request(null, { method: 'GET', path: `/api/v1/Habit/${a.sub}` }), 401);
    await expectProblem(await app.request(b, { method: 'GET', path: `/api/v1/Habit/${a.sub}` }), 403);
    await expectProblem(await app.request(b, { method: 'POST', path: `/api/v1/Habit/${a.sub}`, body: body() }), 403);
  });
  it('should 401 an expired token', async () => {
    const a = await app.user();
    const token = await app.token(a.sub, { expiresInSec: -10 });
    await expectProblem(
      await app.request({ sub: a.sub, token }, { method: 'GET', path: `/api/v1/Habit/${a.sub}` }),
      401,
    );
  });
  it('should let an admin act on a user', async () => {
    const a = await app.user();
    const admin = await app.admin();
    const res = await app.request(admin, { method: 'GET', path: `/api/v1/Habit/${a.sub}` });
    expect(res.status).toBe(200);
  });
});

describe('owner scoped (layer 4)', () => {
  const idOf = async (a: Actor) => (await createOk(a)).habitId;
  const rows = (id: string) =>
    app.sql`SELECT h.*, hv.* FROM habit.habits h JOIN habit.habit_versions hv ON hv.habit_id = h.id WHERE h.id = ${id}`;

  it('should 404 user B reading user A habit', () =>
    expectOwnerScoped(app, {
      seed: idOf,
      request: (id, b) => ({ method: 'GET', path: `/api/v1/Habit/${b.sub}/${id}` }),
      unchanged: rows,
    }));
  it('should 404 user B updating user A habit', () =>
    expectOwnerScoped(app, {
      seed: idOf,
      request: (id, b) => ({
        method: 'PUT',
        path: `/api/v1/Habit/${b.sub}/${id}`,
        body: { ...body({ task: 'hijack' }), enabled: false },
      }),
      unchanged: rows,
    }));
  it('should 404 user B deleting user A habit', () =>
    expectOwnerScoped(app, {
      seed: idOf,
      request: (id, b) => ({ method: 'DELETE', path: `/api/v1/Habit/${b.sub}/${id}` }),
      unchanged: rows,
    }));
  it('should hide user A habit version from user B on the contract', async () => {
    const a = await app.user();
    const b = await app.user();
    const v = await createOk(a);
    const habit = app.contract('habit.v1') as HabitV1;
    expect(await habit.getVersion(Owner.user(b.sub), v.id)).toBeNull();
    expect(await habit.getCurrent(Owner.user(b.sub), v.habitId)).toBeNull();
    expect(await habit.owns(b.sub, v.habitId)).toBe(false);
    expect(await habit.owns(a.sub, v.habitId)).toBe(true);
  });
  it('should 404 user B on user A routine (get, update, delete)', async () => {
    const routineRows = (id: string) => app.sql`SELECT * FROM habit.routines WHERE id = ${id}`;
    for (const request of [
      (id: string, b: Actor) => ({ method: 'GET' as const, path: `/api/v1/Routine/${b.sub}/${id}` }),
      (id: string, b: Actor) => ({
        method: 'PUT' as const,
        path: `/api/v1/Routine/${b.sub}/${id}`,
        body: { name: 'x' },
      }),
      (id: string, b: Actor) => ({ method: 'DELETE' as const, path: `/api/v1/Routine/${b.sub}/${id}` }),
    ]) {
      await expectOwnerScoped(app, {
        seed: async a =>
          (
            (await (
              await app.request(a, { method: 'POST', path: `/api/v1/Routine/${a.sub}`, body: { name: 'Morning' } })
            ).json()) as { id: string }
          ).id,
        request,
        unchanged: routineRows,
      });
    }
  });
  it('should 404 creating a habit in user A routine as user B', async () => {
    const a = await app.user();
    const b = await app.user();
    const r = (await (
      await app.request(a, { method: 'POST', path: `/api/v1/Routine/${a.sub}`, body: { name: 'Morning' } })
    ).json()) as { id: string };
    await expectProblem(await create(b, { routineId: r.id }), 404, 'entity_not_found');
    expect(await habitIdsOf(b)).toEqual([]);
  });
});

describe('routines', () => {
  it('should delete the routine and its habits, releasing a one-habit routine with the habit', async () => {
    const a = await app.user();
    const r = (await (
      await app.request(a, { method: 'POST', path: `/api/v1/Routine/${a.sub}`, body: { name: 'Morning' } })
    ).json()) as { id: string };
    await createOk(a, { routineId: r.id, task: 'One' });
    await createOk(a, { routineId: r.id, task: 'Two' });
    const lone = await createOk(a, { task: 'Alone' });
    expect((await app.request(a, { method: 'DELETE', path: `/api/v1/Routine/${a.sub}/${r.id}` })).status).toBe(204);
    expect(await habitIdsOf(a)).toEqual([lone.habitId]);
    // The one-habit routine of "Alone" is deleted with its last habit.
    await app.request(a, { method: 'DELETE', path: `/api/v1/Habit/${a.sub}/${lone.habitId}` });
    const live =
      (await app.sql`SELECT id FROM habit.routines WHERE user_id = ${a.sub} AND deleted_at IS NULL`) as unknown[];
    expect(live).toEqual([]);
  });
});

describe('quota and the user lock', () => {
  it('should let only one of two concurrent creates through at a quota of one', async () => {
    const small = await startTestApp({ contexts: ['habit'], config: { plan: { tiers: { free: { habitsMax: 1 } } } } });
    try {
      const a = await small.user();
      const make = () =>
        small.request(a, { method: 'POST', path: `/api/v1/Habit/${a.sub}`, body: body() }).then(r => r.status);
      const statuses = await Promise.all([make(), make()]);
      expect(statuses.filter(s => s === 200)).toHaveLength(1);
      expect(statuses.filter(s => s === 400)).toHaveLength(1);
    } finally {
      await small.close();
    }
  });
});

describe('purge', () => {
  it('should leave 0 rows of user A in the habit schema after deletion, and keep user B', async () => {
    const a = await app.user();
    const b = await app.user();
    const r = (await (
      await app.request(a, { method: 'POST', path: `/api/v1/Routine/${a.sub}`, body: { name: 'R' } })
    ).json()) as { id: string };
    await createOk(a, { routineId: r.id });
    await createOk(a);
    await createOk(b);
    expect((await app.request(a, { method: 'DELETE', path: '/api/v1/User/Me' })).status).toBeLessThan(300);
    for (const t of ['habits', 'habit_versions', 'routines']) {
      const n = (await app.sql.unsafe(`SELECT count(*)::int AS n FROM habit.${t} WHERE user_id = $1`, [a.sub])) as {
        n: number;
      }[];
      expect(n[0]?.n).toBe(0);
    }
    expect(await habitIdsOf(b)).toHaveLength(1);
  });
});

describe('mcp', () => {
  it('should create and list through the tools like the routes', async () => {
    const a = await app.user();
    const made = await app.mcp(a, 'habit.create', { userId: a.sub, habit: body({ task: 'Via MCP' }) });
    expect(made.ok).toBe(true);
    const listed = await app.mcp(a, 'habit.list', { userId: a.sub });
    expect((listed.data as { task: string }[]).map(h => h.task)).toContain('Via MCP');
    const b = await app.user();
    const forbidden = await app.mcp(b, 'habit.list', { userId: a.sub });
    expect(forbidden.ok).toBe(false);
    expect(forbidden.problem?.status).toBe(403);
  });
});
