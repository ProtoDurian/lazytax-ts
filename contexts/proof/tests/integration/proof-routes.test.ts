import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { expectOwnerScoped, expectProblem } from '@lazytax/kernel/testing';
import { connectStrava as connect, type ProofApp, startProofApp } from './support';

const connectStrava = (a: { sub: string; token: string }, id: number) => connect(app, a, id);

let app: ProofApp;
beforeAll(async () => {
  app = await startProofApp({ strava: { enabled: true } });
});
afterAll(() => app.close());

const bindBody = { pluginKey: 'strava', settings: '{"sportTypes":["Run"]}' };

describe('Proof routes', () => {
  it('should list the plugins with their manifests', async () => {
    // Arrange
    const a = await app.user();
    // Act
    const res = await app.request(a, { method: 'GET', path: '/api/v1/Proof/plugins' });
    // Assert
    const list = (await res.json()) as { key: string; alwaysBound: boolean; minTier: string | null }[];
    expect(list.map(p => p.key)).toEqual(['manual', 'nfc', 'strava']);
    expect(list.find(p => p.key === 'strava')?.minTier).toBe('pro');
    expect(list.find(p => p.key === 'manual')?.alwaysBound).toBe(true);
  });

  it('should report the manual proof for a habit with no binding', async () => {
    const a = await app.user();
    const h = await app.habit(a);
    const res = await app.request(a, { method: 'GET', path: `/api/v1/Proof/${a.sub}/${h}` });
    expect(await res.json()).toEqual({ habitId: h, pluginKey: 'manual', pluginVersion: 1, settings: '{}' });
  });

  it('should bind strava for a pro user who connected, replace it, and unbind to manual', async () => {
    // Arrange
    const a = await app.user();
    await app.pro(a);
    const h = await app.habit(a);
    await connectStrava(a, 900_001);
    // Act
    const bound = await app.request(a, { method: 'PUT', path: `/api/v1/Proof/${a.sub}/${h}`, body: bindBody });
    const rebound = await app.request(a, {
      method: 'PUT',
      path: `/api/v1/Proof/${a.sub}/${h}`,
      body: { pluginKey: 'strava', settings: '{"sportTypes":["Ride"]}' },
    });
    const unbound = await app.request(a, { method: 'DELETE', path: `/api/v1/Proof/${a.sub}/${h}` });
    const again = await app.request(a, { method: 'DELETE', path: `/api/v1/Proof/${a.sub}/${h}` });
    // Assert
    expect(bound.status).toBe(200);
    expect(((await rebound.json()) as { settings: string }).settings).toBe('{"sportTypes":["Ride"]}');
    expect(unbound.status).toBe(204);
    await expectProblem(again, 404, 'entity_not_found');
    const rows = await app.sql`SELECT count(*)::int AS n FROM proof.proof_bindings WHERE habit_id = ${h}`;
    expect(rows[0]?.n).toBe(0);
  });

  it('should refuse a free user (tier), unknown settings, an unknown plugin and a manual bind', async () => {
    const a = await app.user();
    const h = await app.habit(a);
    await connectStrava(a, 900_002);
    const path = `/api/v1/Proof/${a.sub}/${h}`;
    await expectProblem(await app.request(a, { method: 'PUT', path, body: bindBody }), 400, 'tier_insufficient');
    await app.pro(a);
    await expectProblem(
      await app.request(a, { method: 'PUT', path, body: { pluginKey: 'strava', settings: '{"sportTypes":[]}' } }),
      400,
      'validation_error',
    );
    await expectProblem(
      await app.request(a, { method: 'PUT', path, body: { pluginKey: 'zzz', settings: '{}' } }),
      404,
      'entity_not_found',
    );
    await expectProblem(
      await app.request(a, { method: 'PUT', path, body: { pluginKey: 'manual', settings: '{}' } }),
      400,
      'validation_error',
    );
    await expectProblem(
      await app.request(a, { method: 'PUT', path, body: { pluginKey: 'strava' } }),
      400,
      'validation_error',
    );
  });

  it('should refuse to bind strava before Strava is connected', async () => {
    const a = await app.user();
    await app.pro(a);
    const h = await app.habit(a);
    const res = await app.request(a, { method: 'PUT', path: `/api/v1/Proof/${a.sub}/${h}`, body: bindBody });
    await expectProblem(res, 400, 'validation_error');
  });

  it('should 404 a path that is not a habit uuid', async () => {
    const a = await app.user();
    await expectProblem(
      await app.request(a, { method: 'GET', path: `/api/v1/Proof/${a.sub}/nope` }),
      404,
      'entity_not_found',
    );
  });

  it('should serialize two concurrent binds of one habit into one row', async () => {
    // Arrange
    const a = await app.user();
    await app.pro(a);
    const h = await app.habit(a);
    await connectStrava(a, 900_003);
    // Act
    const [x, y] = await Promise.all(
      ['Run', 'Ride'].map(s =>
        app.request(a, {
          method: 'PUT',
          path: `/api/v1/Proof/${a.sub}/${h}`,
          body: { pluginKey: 'strava', settings: `{"sportTypes":["${s}"]}` },
        }),
      ),
    );
    // Assert
    expect([x?.status, y?.status]).toEqual([200, 200]);
    const rows = await app.sql`SELECT count(*)::int AS n FROM proof.proof_bindings WHERE habit_id = ${h}`;
    expect(rows[0]?.n).toBe(1);
  });
});

describe('Proof auth layers', () => {
  it('should 401 with no token or an expired one', async () => {
    const a = await app.user();
    const h = await app.habit(a);
    const path = `/api/v1/Proof/${a.sub}/${h}`;
    await expectProblem(await app.request(null, { method: 'GET', path }), 401);
    const expired = { sub: a.sub, token: await app.token(a.sub, { expiresInSec: -60 }) };
    await expectProblem(await app.request(expired, { method: 'GET', path }), 401);
  });

  it("should 403 another user's id in the path, and let an admin through", async () => {
    const a = await app.user();
    const b = await app.user();
    const h = await app.habit(a);
    await expectProblem(
      await app.request(b, { method: 'GET', path: `/api/v1/Proof/${a.sub}/${h}` }),
      403,
      'unauthorized',
    );
    const admin = await app.admin();
    expect((await app.request(admin, { method: 'GET', path: `/api/v1/Proof/${a.sub}/${h}` })).status).toBe(200);
  });

  it("should 404 user B on user A's habit and change nothing (binding entity)", () =>
    expectOwnerScoped(app, {
      seed: async a => {
        await app.pro(a);
        const h = await app.habit(a);
        await connectStrava(a, 900_000 + Math.floor(Math.random() * 90_000));
        await app.request(a, { method: 'PUT', path: `/api/v1/Proof/${a.sub}/${h}`, body: bindBody });
        return h;
      },
      request: (id, b) => ({ method: 'GET', path: `/api/v1/Proof/${b.sub}/${id}` }),
      unchanged: id => app.sql`SELECT * FROM proof.proof_bindings WHERE habit_id = ${id}`,
    }));

  it("should 404 user B binding or unbinding user A's habit and change nothing", async () => {
    const a = await app.user();
    const b = await app.user();
    await app.pro(b);
    const h = await app.habit(a);
    await expectProblem(
      await app.request(b, { method: 'PUT', path: `/api/v1/Proof/${b.sub}/${h}`, body: bindBody }),
      404,
      'entity_not_found',
    );
    await expectProblem(
      await app.request(b, { method: 'DELETE', path: `/api/v1/Proof/${b.sub}/${h}` }),
      404,
      'entity_not_found',
    );
    const rows = await app.sql`SELECT count(*)::int AS n FROM proof.proof_bindings WHERE habit_id = ${h}`;
    expect(rows[0]?.n).toBe(0);
  });
});

describe('Proof MCP tools', () => {
  it('should bind through proof.bind with the same rules and read it with proof.binding', async () => {
    const a = await app.user();
    await app.pro(a);
    const h = await app.habit(a);
    await connectStrava(a, 900_004);
    const bound = await app.mcp(a, 'proof.bind', { userId: a.sub, habitId: h, ...bindBody });
    expect(bound.ok).toBe(true);
    const got = await app.mcp(a, 'proof.binding', { userId: a.sub, habitId: h });
    expect((got.data as { pluginKey: string }).pluginKey).toBe('strava');
    const other = await app.user();
    expect((await app.mcp(other, 'proof.binding', { userId: a.sub, habitId: h })).ok).toBe(false);
  });
});
