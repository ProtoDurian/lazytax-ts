import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { expectOwnerScoped, expectProblem, startTestApp, type TestApp } from '@lazytax/kernel/testing';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp({ contexts: ['plan', 'account'] });
});
afterAll(() => app.close());

const setTier = async (userId: string, tier: string) => {
  const admin = await app.admin();
  return app.request(admin, { method: 'PUT', path: `/api/v1/Subscription/${userId}/tier`, body: { tier } });
};

describe('plan', () => {
  it('should serve the public plan catalog cheapest first', async () => {
    // Act
    const res = await app.request(null, { method: 'GET', path: '/api/v1/Subscription/plans' });

    // Assert
    const plans = (await res.json()) as { key: string; habitsUnlimited: boolean }[];
    expect(plans.map(p => p.key)).toEqual(['free', 'pro', 'ultimate']);
    expect(plans[2]?.habitsUnlimited).toBe(true);
  });

  it('should present a user with no subscription as free', async () => {
    // Arrange
    const a = await app.user();

    // Act
    const res = await app.request(a, { method: 'GET', path: `/api/v1/Subscription/${a.sub}` });

    // Assert
    expect(((await res.json()) as { tier: string }).tier).toBe('free');
  });

  it('should let only an admin set a tier, and change the quota', async () => {
    // Arrange
    const a = await app.user();

    // Act
    const self = await app.request(a, {
      method: 'PUT',
      path: `/api/v1/Subscription/${a.sub}/tier`,
      body: { tier: 'pro' },
    });
    const byAdmin = await setTier(a.sub, 'pro');
    const quota = await app.contract('plan.v1').quota(a.sub, 'vacationWindows');

    // Assert
    await expectProblem(self, 403, 'unauthorized');
    expect(byAdmin.status).toBe(200);
    expect(quota).toEqual({ tier: 'pro', key: 'ent.vacation.windows.yearly', limit: 6 });
  });

  it('should refuse a quota that is used up with 400 tier_insufficient', async () => {
    // Arrange
    const plan = app.contract('plan.v1');
    const q = await plan.quota((await app.user()).sub, 'vacationWindows');

    // Act
    const act = () => plan.ensureWithin(q, 0);

    // Assert
    expect(act).toThrow('Your free plan does not include vacation windows.');
  });

  it('should 404 user B on user A tier change (chain change -> subscription -> user)', () =>
    expectOwnerScoped(app, {
      seed: async a => {
        await setTier(a.sub, 'pro');
        const [row] =
          await app.sql`SELECT c.id::text FROM plan.subscription_changes c JOIN plan.subscriptions s ON s.id = c.subscription_id WHERE s.user_id = ${a.sub}`;
        return row.id as string;
      },
      request: (id, b) => ({ method: 'GET', path: `/api/v1/Subscription/${b.sub}/changes/${id}` }),
    }));

  it('should purge the subscription and its changes on account deletion', async () => {
    // Arrange
    const a = await app.user();
    await setTier(a.sub, 'ultimate');

    // Act
    const res = await app.request(a, { method: 'DELETE', path: '/api/v1/User/Me' });

    // Assert
    expect(res.status).toBe(204);
    expect((await app.sql`SELECT 1 FROM plan.subscriptions WHERE user_id = ${a.sub}`).length).toBe(0);
  });
});
