// The unit of work across contexts: one transaction, one lock, one retry policy.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Isolation, Owner } from '@lazytax/kernel';
import { startTestApp, type TestApp } from '@lazytax/kernel/testing';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp({ contexts: ['vacation'] });
  await app.sql`CREATE TABLE IF NOT EXISTS kernel.uow_probe (user_id text NOT NULL, n int NOT NULL)`;
});
afterAll(() => app.close());

const countThenInsert = (userId: string, isolation: Isolation) =>
  app.uow.run(
    async () => {
      await app.uow.lockUser(userId);
      const db = app.uow.db();
      const [r] = await db`SELECT count(*)::int AS n FROM kernel.uow_probe WHERE user_id = ${userId}`;
      if (Number(r.n) >= 1) return false;
      await Bun.sleep(150);
      await db`INSERT INTO kernel.uow_probe (user_id, n) VALUES (${userId}, 1)`;
      return true;
    },
    { isolation },
  );

describe('uow.lockUser', () => {
  for (const isolation of ['read committed', 'repeatable read'] as const) {
    it(`should let two overlapping count-then-write units write 1 row (${isolation})`, async () => {
      // Arrange
      const userId = `race_${isolation.replace(' ', '_')}_${Date.now()}`;

      // Act
      const results = await Promise.all([countThenInsert(userId, isolation), countThenInsert(userId, isolation)]);

      // Assert
      expect(results.sort()).toEqual([false, true]);
      expect((await app.sql`SELECT 1 FROM kernel.uow_probe WHERE user_id = ${userId}`).length).toBe(1);
    });
  }
});

describe('one unit of work across contexts', () => {
  const seed = async () => {
    const a = await app.user();
    await app.request(a, { method: 'POST', path: '/api/v1/Configuration', body: { timezone: 'UTC' } });
    return a;
  };
  const rows = async (userId: string) => ({
    vacations: (await app.sql`SELECT 1 FROM vacation.vacation_periods WHERE user_id = ${userId}`).length,
    configs: (await app.sql`SELECT 1 FROM account.configurations WHERE user_id = ${userId}`).length,
  });

  it("should commit two contexts' writes together", async () => {
    // Arrange
    const a = await seed();
    await app.sql`INSERT INTO vacation.vacation_periods (user_id, start_date, end_date, timezone) VALUES (${a.sub}, '2026-01-01', '2026-01-02', 'UTC')`;

    // Act: account's purge hook and vacation's purge hook in one unit.
    await app.uow.run(async () => {
      await app.uow.db()`DELETE FROM account.configurations WHERE user_id = ${a.sub}`;
      await app.uow.db()`DELETE FROM vacation.vacation_periods WHERE user_id = ${a.sub}`;
    });

    // Assert
    expect(await rows(a.sub)).toEqual({ vacations: 0, configs: 0 });
  });

  it("should roll back both contexts' writes when the unit fails", async () => {
    // Arrange
    const a = await seed();
    await app.sql`INSERT INTO vacation.vacation_periods (user_id, start_date, end_date, timezone) VALUES (${a.sub}, '2026-01-01', '2026-01-02', 'UTC')`;

    // Act: vacation's and account's writes through their real repositories via DELETE /User/Me
    // would commit; here a failure after both writes must undo both.
    const act = app.uow.run(async () => {
      await app.uow.db()`DELETE FROM account.configurations WHERE user_id = ${a.sub}`;
      await app.uow.db()`DELETE FROM vacation.vacation_periods WHERE user_id = ${a.sub}`;
      throw new Error('boom');
    });

    // Assert
    await expect(act).rejects.toThrow('boom');
    expect(await rows(a.sub)).toEqual({ vacations: 1, configs: 1 });
  });

  it('should join an open unit when a contract is called inside one', async () => {
    // Arrange
    const a = await seed();
    const account = app.contract('account.v1');

    // Act: a read through account.v1 inside a unit sees the unit's own uncommitted write.
    const seen = await app.uow
      .run(async () => {
        await app.uow.db()`UPDATE account.configurations SET timezone = 'Asia/Tokyo' WHERE user_id = ${a.sub}`;
        const tz = await account.getTimezone(a.sub);
        throw Object.assign(new Error('rollback'), { tz });
      })
      .catch((e: { tz?: string }) => e.tz);

    // Assert
    expect(seen).toBe('Asia/Tokyo');
    expect(await account.getTimezone(a.sub)).toBe('UTC');
  });

  it('should refuse an HTTP call inside a unit of work', async () => {
    // Act
    const act = app.uow.run(async () => {
      await fetch('http://127.0.0.1:9/never');
    });

    // Assert
    await expect(act).rejects.toThrow('HTTP call inside a unit of work');
  });

  it('should refuse Owner.anyone for a non-admin', () => {
    // Act + Assert
    expect(() => Owner.anyone({ sub: 'x', authenticated: true, scopes: [], roles: [], isAdmin: false })).toThrow();
  });
});
