import { afterAll, beforeAll, expect, it } from 'bun:test';
import { fakeStrava } from '../../src/gateways/strava-fake';
import { connectStrava, type ProofApp, startProofApp } from './support';

let app: ProofApp;
beforeAll(async () => {
  app = await startProofApp({ strava: { enabled: true } });
});
afterAll(() => app.close());

const count = async (table: string, userId: string) =>
  (
    (await app.sql.unsafe(`SELECT count(*)::int AS n FROM proof.${table} WHERE user_id = $1`, [userId]))[0] as {
      n: number;
    }
  ).n;

it("should delete every proof row of a deleted user and leave other users' rows", async () => {
  // Arrange: user A has a binding, an NFC tag and a Strava link; so does B.
  const make = async () => {
    const u = await app.user();
    await app.pro(u);
    await connectStrava(app, u, 4000 + Math.floor(Math.random() * 90_000));
    const h = await app.habit(u);
    await app.request(u, {
      method: 'PUT',
      path: `/api/v1/Proof/${u.sub}/${h}`,
      body: { pluginKey: 'strava', settings: '{"sportTypes":["Run"]}' },
    });
    await app.request(u, {
      method: 'PUT',
      path: `/api/v1/NfcTag/${u.sub}/tag-${crypto.randomUUID()}`,
      body: { habitId: h },
    });
    return u;
  };
  const a = await make();
  const b = await make();
  for (const t of ['proof_bindings', 'nfc_tags', 'strava_connections']) expect(await count(t, a.sub)).toBe(1);
  // Act
  const res = await app.request(a, { method: 'DELETE', path: '/api/v1/User/Me' });
  // Assert
  expect(res.status).toBe(204);
  for (const t of ['proof_bindings', 'nfc_tags', 'strava_connections']) {
    expect(await count(t, a.sub)).toBe(0);
    expect(await count(t, b.sub)).toBe(1);
  }
  // The best-effort hook told Strava, outside the transaction.
  expect(fakeStrava.calls.some(c => c.startsWith('revoke:'))).toBe(true);
});

it('should purge a user who never registered anything without failing', async () => {
  const u = await app.user();
  expect((await app.request(u, { method: 'DELETE', path: '/api/v1/User/Me' })).status).toBe(204);
});
