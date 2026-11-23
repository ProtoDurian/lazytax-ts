import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { expectProblem } from '@lazytax/kernel/testing';
import type { StravaWebhookEvent } from '../../src/domain/strava-model';
import { signState, signWebhook } from '../../src/domain/strava-state';
import { fakeStrava } from '../../src/gateways/strava-fake';
import { connectStrava, type ProofApp, startProofApp } from './support';

const SECRET = 'lazytax-dev-webhook-secret';
let app: ProofApp;
beforeAll(async () => {
  app = await startProofApp({ strava: { enabled: true } });
  app.clock.set('2026-03-01T12:00:00Z');
});
afterAll(() => app.close());
beforeEach(() => fakeStrava.reset());

let nextAthlete = 100;
// A pro user with Strava connected and a habit bound to the given sport types.
async function proUser(sports = ['Run']) {
  const a = await app.user();
  await app.pro(a);
  const athlete = nextAthlete++;
  await connectStrava(app, a, athlete);
  const h = await app.habit(a);
  const res = await app.request(a, {
    method: 'PUT',
    path: `/api/v1/Proof/${a.sub}/${h}`,
    body: { pluginKey: 'strava', settings: JSON.stringify({ sportTypes: sports }) },
  });
  expect(res.status).toBe(200);
  return { a, athlete, h };
}

const evt = (over: Partial<StravaWebhookEvent> & { ownerId: number; objectId: number }): StravaWebhookEvent => ({
  objectType: 'activity',
  aspectType: 'create',
  eventTime: new Date('2026-03-01T11:59:00Z'),
  deauthorized: false,
  ...over,
});
const raw = (e: StravaWebhookEvent) => ({
  object_type: e.objectType,
  aspect_type: e.aspectType,
  object_id: e.objectId,
  owner_id: e.ownerId,
  event_time: Math.floor(e.eventTime.getTime() / 1000),
  ...(e.deauthorized ? { updates: { authorized: 'false' } } : {}),
});
const nowSec = () => Math.floor(app.clock.now().getTime() / 1000);
const post = (body: string, headers: Record<string, string>) => app.postWebhook(body, headers);
const deliver = (e: StravaWebhookEvent, ts = nowSec(), sig?: string, body = JSON.stringify(raw(e))) =>
  post(body, { 'x-lazytax-timestamp': String(ts), 'x-lazytax-signature': sig ?? signWebhook(SECRET, ts, body) });
const queued = async () => ((await app.sql`SELECT count(*)::int AS n FROM proof.strava_events`)[0] as { n: number }).n;
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
const revoked = () =>
  app.sql`SELECT payload FROM kernel.outbox_events WHERE type = 'proof.evidenceRevoked' ORDER BY created_at`;

describe('Strava connect flow', () => {
  it('should hand out signed authorize urls for the caller only', async () => {
    const a = await app.user();
    const b = await app.user();
    const res = await app.request(a, { method: 'GET', path: `/api/v1/Strava/connect-url/${a.sub}` });
    const { url, appUrl } = (await res.json()) as { url: string; appUrl: string };
    expect(new URL(url).searchParams.get('scope')).toBe('read,activity:read_all');
    expect(appUrl.startsWith('strava://')).toBe(true);
    await expectProblem(
      await app.request(b, { method: 'GET', path: `/api/v1/Strava/connect-url/${a.sub}` }),
      403,
      'unauthorized',
    );
    await expectProblem(await app.request(null, { method: 'GET', path: `/api/v1/Strava/connect-url/${a.sub}` }), 401);
  });

  it('should end every callback at the app deep link with the outcome', async () => {
    const a = await app.user();
    const b = await app.user();
    const state = (sub: string, minutes = 5) =>
      signState(sub, new Date(app.clock.now().getTime() + minutes * 60_000), 'lazytax-dev-strava-client-secret');
    const cb = async (query: Record<string, string>) =>
      (await app.request(null, { method: 'GET', path: '/api/v1/Strava/callback', query })).headers.get('location') ??
      '';
    const ok = { code: 'athlete-777', scope: 'read,activity:read_all' };

    expect(await cb({ ...ok, state: 'forged.x' })).toContain('result=expired');
    expect(await cb({ ...ok, state: state(a.sub, -1) })).toContain('result=expired');
    expect(await cb({ state: state(a.sub), error: 'access_denied' })).toContain('result=denied');
    expect(await cb({ code: 'athlete-777', scope: 'read', state: state(a.sub) })).toContain('result=scope_missing');
    expect(await cb({ code: 'bad', scope: ok.scope, state: state(a.sub) })).toContain('result=error');
    expect(await cb({ ...ok, state: state(a.sub) })).toContain('result=connected');
    expect(await cb({ ...ok, state: state(b.sub) })).toContain('result=athlete_taken');
    // The refused account is revoked at Strava, and b has no connection.
    expect(fakeStrava.calls.some(c => c.startsWith('revoke:'))).toBe(true);
    const rows = await app.sql`SELECT user_id FROM proof.strava_connections WHERE athlete_id = 777`;
    expect(rows.map((r: { user_id: string }) => r.user_id)).toEqual([a.sub]);
  });

  it('should store the tokens encrypted, report status, and disconnect with revoke', async () => {
    const { a, h } = await proUser();
    const row = (
      await app.sql`SELECT access_token, refresh_token FROM proof.strava_connections WHERE user_id = ${a.sub}`
    )[0];
    expect(row?.access_token).toStartWith('v1:');
    expect(row?.refresh_token).not.toContain('rt-');
    const st = await app.request(a, { method: 'GET', path: `/api/v1/Strava/${a.sub}` });
    expect(((await st.json()) as { connected: boolean }).connected).toBe(true);

    const del = await app.request(a, { method: 'DELETE', path: `/api/v1/Strava/${a.sub}` });
    expect(del.status).toBe(204);
    expect(fakeStrava.calls.some(c => c.startsWith('revoke:rt-'))).toBe(true);
    const bound = await app.sql`SELECT count(*)::int AS n FROM proof.proof_bindings WHERE habit_id = ${h}`;
    expect(bound[0]?.n).toBe(0);
    expect(
      (await revoked()).some((r: { payload: unknown }) => (parse(r.payload) as { userId: string }).userId === a.sub),
    ).toBe(true);
    await expectProblem(
      await app.request(a, { method: 'DELETE', path: `/api/v1/Strava/${a.sub}` }),
      404,
      'entity_not_found',
    );
  });

  it('should 404 Strava endpoints when the feature is off', async () => {
    const off = await startProofApp();
    try {
      const a = await off.user();
      await expectProblem(await off.request(a, { method: 'GET', path: `/api/v1/Strava/${a.sub}` }), 404);
      const plugins = (await (await off.request(a, { method: 'GET', path: '/api/v1/Proof/plugins' })).json()) as {
        key: string;
      }[];
      expect(plugins.map(p => p.key)).toEqual(['manual', 'nfc']);
    } finally {
      await off.close();
    }
  });
});

describe('Strava webhook', () => {
  it('should answer the subscription challenge only with the verify token', async () => {
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'lazytax-dev-verify-token', 'hub.challenge': 'abc' };
    const ok = await app.request(null, { method: 'GET', path: '/api/v1/Strava/webhook', query: q });
    expect(await ok.json()).toEqual({ 'hub.challenge': 'abc' });
    const bad = await app.request(null, {
      method: 'GET',
      path: '/api/v1/Strava/webhook',
      query: { ...q, 'hub.verify_token': 'x' },
    });
    expect(bad.status).toBe(403);
  });

  it('should queue a validly signed, fresh event and refuse the rest with 403', async () => {
    // Arrange
    const e = evt({ ownerId: 1, objectId: 5 });
    const before = await queued();
    // Act / Assert
    expect((await deliver(e)).status).toBe(200);
    expect(await queued()).toBe(before + 1);
    expect((await deliver(e, nowSec(), 'deadbeef')).status).toBe(403);
    expect((await deliver(e, nowSec(), signWebhook('wrong', nowSec(), JSON.stringify(raw(e))))).status).toBe(403);
    // A valid signature over other bytes does not cover this body.
    expect(
      (await deliver(e, nowSec(), signWebhook(SECRET, nowSec(), JSON.stringify(raw(evt({ ownerId: 2, objectId: 5 }))))))
        .status,
    ).toBe(403);
    const old = nowSec() - 301;
    expect((await deliver(e, old)).status).toBe(403);
    const none = await post(JSON.stringify(raw(e)), {});
    expect(none.status).toBe(403);
    expect(await queued()).toBe(before + 1);
  });

  it('should answer 200 and queue nothing for a signed but unreadable body', async () => {
    const before = await queued();
    const ts = nowSec();
    const body = JSON.stringify({ hello: 'world' });
    const res = await post(body, {
      'x-lazytax-timestamp': String(ts),
      'x-lazytax-signature': signWebhook(SECRET, ts, body),
    });
    expect(res.status).toBe(200);
    expect(await queued()).toBe(before);
  });
});

describe('Strava worker', () => {
  it('should prove a bound habit from a recorded activity, once', async () => {
    // Arrange
    const { a, athlete, h } = await proUser(['Run']);
    fakeStrava.activities.set(9001, { sportType: 'Run', startDate: '2026-03-01T10:00:00Z', manual: false });
    // Act
    await deliver(evt({ ownerId: athlete, objectId: 9001 }));
    await app.tick('strava-inbox');
    await deliver(evt({ ownerId: athlete, objectId: 9001, aspectType: 'update' }));
    await app.tick('strava-inbox');
    // Assert
    const mine = (await app.reports()).filter(r => r.userId === a.sub);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ habitId: h, proofKey: 'strava', externalId: '9001', verdict: 'passed' });
    expect(mine[0]?.data).toBeNull();
    expect(await queued()).toBe(0);
  });

  it('should ignore another sport type, a manual activity and an activity Strava no longer shows', async () => {
    const { a, athlete } = await proUser(['Run']);
    fakeStrava.activities.set(9101, { sportType: 'Swim', startDate: '2026-03-01T10:00:00Z', manual: false });
    fakeStrava.activities.set(9102, { sportType: 'Run', startDate: '2026-03-01T10:00:00Z', manual: true });
    for (const id of [9101, 9102, 9103]) await deliver(evt({ ownerId: athlete, objectId: id }));
    await app.tick('strava-inbox');
    expect((await app.reports()).filter(r => r.userId === a.sub)).toHaveLength(0);
    expect(await queued()).toBe(0);
  });

  it('should keep an event whose fetch failed and retry it after the lease, then drop it after max attempts', async () => {
    const { a, athlete } = await proUser(['Run']);
    fakeStrava.activities.set(9201, { sportType: 'Run', startDate: '2026-03-01T10:00:00Z', manual: false });
    fakeStrava.failActivityFetch = true;
    await deliver(evt({ ownerId: athlete, objectId: 9201 }));
    await app.tick('strava-inbox');
    expect(await queued()).toBe(1);
    // Still claimed: another tick right away does not touch it.
    const calls = fakeStrava.calls.length;
    await app.tick('strava-inbox');
    expect(fakeStrava.calls.length).toBe(calls);
    // After the lease the event comes back, and succeeds once Strava is up.
    fakeStrava.failActivityFetch = false;
    app.clock.set('2026-03-01T12:10:00Z');
    await app.tick('strava-inbox');
    expect(await queued()).toBe(0);
    expect((await app.reports()).filter(r => r.userId === a.sub)).toHaveLength(1);
    app.clock.set('2026-03-01T12:00:00Z');

    // A poison event is dropped after maxAttempts (5).
    fakeStrava.failActivityFetch = true;
    await deliver(evt({ ownerId: athlete, objectId: 9202 }));
    for (let i = 0; i < 5; i++) {
      app.clock.set(new Date(Date.UTC(2026, 2, 1, 12, 20 + i * 10)));
      await app.tick('strava-inbox');
    }
    expect(await queued()).toBe(0);
    app.clock.set('2026-03-01T12:00:00Z');
  });

  it('should refresh an expiring token once, keep the new one, and let a second worker wait', async () => {
    // Arrange
    const { athlete } = await proUser(['Run']);
    fakeStrava.activities.set(9301, { sportType: 'Run', startDate: '2026-03-01T10:00:00Z', manual: false });
    fakeStrava.activities.set(9302, { sportType: 'Run', startDate: '2026-03-01T10:01:00Z', manual: false });
    app.clock.set('2026-03-01T20:00:00Z'); // past the 6 h token life
    fakeStrava.refreshDelayMs = 150;
    await deliver(evt({ ownerId: athlete, objectId: 9301 }), nowSec());
    await deliver(evt({ ownerId: athlete, objectId: 9302 }), nowSec());
    // Act: two workers at once (the second finds the refresh claimed).
    await Promise.all([app.tick('strava-inbox'), app.tick('strava-inbox')]);
    // Assert: one refresh; the other worker's event waits for its lease.
    expect(fakeStrava.calls.filter(c => c.startsWith('refresh:'))).toHaveLength(1);
    app.clock.set('2026-03-01T20:10:00Z');
    await app.tick('strava-inbox');
    expect(fakeStrava.calls.filter(c => c.startsWith('refresh:'))).toHaveLength(1);
    expect(await queued()).toBe(0);
    app.clock.set('2026-03-01T12:00:00Z');
  });

  it('should disconnect and purge Strava data when Strava rejects the refresh token', async () => {
    const { a, athlete, h } = await proUser(['Run']);
    fakeStrava.activities.set(9401, { sportType: 'Run', startDate: '2026-03-01T10:00:00Z', manual: false });
    const rt = (await app.sql`SELECT user_id FROM proof.strava_connections WHERE user_id = ${a.sub}`).length;
    expect(rt).toBe(1);
    // Strava no longer honours every refresh token.
    app.clock.set('2026-03-01T20:00:00Z');
    for (let i = 1; i <= 50; i++) fakeStrava.revoked.add(`rt-${i}`);
    for (let i = 1; i <= 50; i++) fakeStrava.revoked.add(`rt-${i}`);
    await deliver(evt({ ownerId: athlete, objectId: 9401 }), nowSec());
    await app.tick('strava-inbox');
    const left = await app.sql`SELECT count(*)::int AS n FROM proof.strava_connections WHERE user_id = ${a.sub}`;
    expect(left[0]?.n).toBe(0);
    const bound = await app.sql`SELECT count(*)::int AS n FROM proof.proof_bindings WHERE habit_id = ${h}`;
    expect(bound[0]?.n).toBe(0);
    app.clock.set('2026-03-01T12:00:00Z');
  });

  it('should treat a deauthorization like a disconnect without a revoke call', async () => {
    const { a, athlete, h } = await proUser(['Run']);
    await deliver(
      evt({ ownerId: athlete, objectId: athlete, objectType: 'athlete', aspectType: 'update', deauthorized: true }),
    );
    await app.tick('strava-inbox');
    expect(fakeStrava.calls.some(c => c.startsWith('revoke:'))).toBe(false);
    const left = await app.sql`SELECT count(*)::int AS n FROM proof.strava_connections WHERE user_id = ${a.sub}`;
    expect(left[0]?.n).toBe(0);
    const bound = await app.sql`SELECT count(*)::int AS n FROM proof.proof_bindings WHERE habit_id = ${h}`;
    expect(bound[0]?.n).toBe(0);
  });

  it('should ask check to drop the evidence of an activity deleted in Strava', async () => {
    const { a, athlete } = await proUser(['Run']);
    await deliver(evt({ ownerId: athlete, objectId: 9501, aspectType: 'delete' }));
    await app.tick('strava-inbox');
    const events = (await revoked()).map(
      (r: { payload: unknown }) => parse(r.payload) as { userId: string; proofKey: string; externalId: string | null },
    );
    expect(events).toContainEqual({ userId: a.sub, proofKey: 'strava', externalId: '9501' });
  });

  it('should never make a gateway call inside a unit of work', async () => {
    const { athlete } = await proUser(['Run']);
    fakeStrava.activities.set(9601, { sportType: 'Run', startDate: '2026-03-01T10:00:00Z', manual: false });
    await deliver(evt({ ownerId: athlete, objectId: 9601 }));
    // The kernel's fetch guard throws inside a unit; the fake would hide it, so assert the order.
    let inUnitCalls = 0;
    const orig = fakeStrava.getActivity.bind(fakeStrava);
    fakeStrava.getActivity = async (t, id) => {
      if (app.uow.inUnit()) inUnitCalls++;
      return orig(t, id);
    };
    try {
      await app.tick('strava-inbox');
    } finally {
      fakeStrava.getActivity = orig;
    }
    expect(inUnitCalls).toBe(0);
  });
});
