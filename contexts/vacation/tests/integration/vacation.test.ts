import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Actor, expectOwnerScoped, expectProblem, startTestApp, type TestApp } from '@lazytax/kernel/testing';

let app: TestApp;
beforeAll(async () => {
  // free gets 1 window a year here, so the quota and the race are cheap to test.
  app = await startTestApp({
    contexts: ['vacation'],
    config: { plan: { tiers: { free: { vacationWindowsYearly: 1 } } } },
    now: '2026-06-15T12:00:00Z',
  });
});
afterAll(() => app.close());

const body = (startDate = '2026-07-01', endDate = '2026-07-05') => ({ startDate, endDate, timezone: 'UTC' });
const create = (a: Actor, b = body()) => app.request(a, { method: 'POST', path: `/api/v1/Vacation/${a.sub}`, body: b });

// A user with a configuration (vacation asks account.v1 for "today").
const user = async (): Promise<Actor> => {
  const a = await app.user();
  const res = await app.request(a, { method: 'POST', path: '/api/v1/Configuration', body: { timezone: 'UTC' } });
  expect(res.status).toBe(200);
  return a;
};

const pro = async (a: Actor) => {
  const admin = await app.admin();
  await app.request(admin, { method: 'PUT', path: `/api/v1/Subscription/${a.sub}/tier`, body: { tier: 'pro' } });
};

describe('vacation create', () => {
  it('should create a window and list it', async () => {
    // Arrange
    const a = await user();

    // Act
    const res = await create(a);
    const list = await app.request(a, { method: 'GET', path: `/api/v1/Vacation/${a.sub}`, query: { year: '2026' } });

    // Assert
    expect(res.status).toBe(200);
    expect(((await list.json()) as unknown[]).length).toBe(1);
  });

  it('should stop at the guard when the plan has no windows', async () => {
    // Arrange
    const app0 = await startTestApp({ contexts: ['vacation'] });
    const a = await app0.user();

    // Act
    const res = await app0.request(a, { method: 'POST', path: `/api/v1/Vacation/${a.sub}`, body: body() });

    // Assert
    const p = await expectProblem(res, 400, 'tier_insufficient');
    expect(p.detail).toBe('Your free plan does not include vacation windows.');
    await app0.close();
  });

  it('should let only one of two concurrent creates use the last window (user lock)', async () => {
    // Arrange
    const a = await user();

    // Act
    const [r1, r2] = await Promise.all([
      create(a, body('2026-08-01', '2026-08-02')),
      create(a, body('2026-09-01', '2026-09-02')),
    ]);

    // Assert
    expect([r1.status, r2.status].sort()).toEqual([200, 400]);
    expect((await app.sql`SELECT 1 FROM vacation.vacation_periods WHERE user_id = ${a.sub}`).length).toBe(1);
  });

  it('should refuse an overlapping window', async () => {
    // Arrange
    const a = await user();
    await pro(a);
    await create(a);

    // Act
    const res = await create(a, body('2026-07-04', '2026-07-10'));

    // Assert
    await expectProblem(res, 400, 'validation_error');
  });

  it('should 401 without a token and 403 on another user id', async () => {
    // Arrange
    const a = await user();
    const b = await user();

    // Act
    const anon = await app.request(null, { method: 'GET', path: `/api/v1/Vacation/${a.sub}` });
    const other = await create({ sub: a.sub, token: b.token });

    // Assert
    await expectProblem(anon, 401, 'unauthenticated');
    await expectProblem(other, 403, 'unauthorized');
  });
});

describe('vacation ownership (layer 4)', () => {
  const seed = async (a: Actor) => {
    await app.request(a, { method: 'POST', path: '/api/v1/Configuration', body: { timezone: 'UTC' } });
    return ((await (await create(a)).json()) as { id: string }).id;
  };
  const row = (id: string) =>
    app.sql`SELECT start_date::text, end_date::text FROM vacation.vacation_periods WHERE id = ${id}`;

  it('should 404 user B ending user A vacation', () =>
    expectOwnerScoped(app, {
      seed,
      request: (id, b) => ({ method: 'PATCH', path: `/api/v1/Vacation/${b.sub}/${id}/end-today` }),
      unchanged: row,
    }));

  it('should 404 user B deleting user A vacation', () =>
    expectOwnerScoped(app, {
      seed,
      request: (id, b) => ({ method: 'DELETE', path: `/api/v1/Vacation/${b.sub}/${id}` }),
      unchanged: row,
    }));
});

describe('vacation lifecycle', () => {
  it('should end a started vacation today and refuse deleting it', async () => {
    // Arrange
    const a = await user();
    const id = ((await (await create(a, body('2026-06-10', '2026-06-20'))).json()) as { id: string }).id;

    // Act
    const del = await app.request(a, { method: 'DELETE', path: `/api/v1/Vacation/${a.sub}/${id}` });
    const end = await app.request(a, { method: 'PATCH', path: `/api/v1/Vacation/${a.sub}/${id}/end-today` });

    // Assert
    await expectProblem(del, 400, 'validation_error');
    expect(((await end.json()) as { endDate: string }).endDate).toBe('2026-06-15');
    expect(await app.contract('vacation.v1').isAway(a.sub, '2026-06-15')).toBe(true);
    expect(await app.contract('vacation.v1').isAway(a.sub, '2026-06-16')).toBe(false);
  });

  it("should be purged with the user's account", async () => {
    // Arrange
    const a = await user();
    const b = await user();
    await create(a);
    await create(b);

    // Act
    const res = await app.request(a, { method: 'DELETE', path: '/api/v1/User/Me' });

    // Assert
    expect(res.status).toBe(204);
    expect((await app.sql`SELECT 1 FROM vacation.vacation_periods WHERE user_id = ${a.sub}`).length).toBe(0);
    expect((await app.sql`SELECT 1 FROM vacation.vacation_periods WHERE user_id = ${b.sub}`).length).toBe(1);
  });

  it('should create through MCP with the same guard and subject rule', async () => {
    // Arrange
    const a = await user();
    const b = await user();

    // Act
    const ok = await app.mcp(a, 'vacation.create', { userId: a.sub, ...body('2026-10-01', '2026-10-02') });
    const forbidden = await app.mcp(b, 'vacation.create', { userId: a.sub, ...body('2026-11-01', '2026-11-02') });

    // Assert
    expect(ok.ok).toBe(true);
    expect(forbidden.problem?.status).toBe(403);
  });
});
