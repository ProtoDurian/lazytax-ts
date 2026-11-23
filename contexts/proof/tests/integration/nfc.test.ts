import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { expectOwnerScoped, expectProblem } from '@lazytax/kernel/testing';
import { type ProofApp, startProofApp } from './support';

let app: ProofApp;
beforeAll(async () => {
  app = await startProofApp();
});
afterAll(() => app.close());

const tag = () => `tag-${crypto.randomUUID()}`;
const link = (actor: { sub: string; token: string }, tagId: string, habitId: string) =>
  app.request(actor, { method: 'PUT', path: `/api/v1/NfcTag/${actor.sub}/${tagId}`, body: { habitId } });

describe('NfcTag routes', () => {
  it('should link, resolve with the current version and today, re-point and unlink a tag', async () => {
    // Arrange
    const a = await app.user();
    const h1 = await app.habit(a);
    const h2 = await app.habit(a);
    const t = tag();
    await app.complete(a, h1);
    // Act
    const linked = await link(a, t, h1);
    const resolved = await app.request(a, { method: 'GET', path: `/api/v1/NfcTag/${a.sub}/${t}` });
    const repointed = await link(a, t, h2);
    const unlinked = await app.request(a, { method: 'DELETE', path: `/api/v1/NfcTag/${a.sub}/${t}` });
    const gone = await app.request(a, { method: 'GET', path: `/api/v1/NfcTag/${a.sub}/${t}` });
    // Assert
    expect(linked.status).toBe(200);
    const body = (await resolved.json()) as {
      tag: { habitId: string; claimedAt: string };
      today: string;
      todayExecution: unknown;
    };
    expect(body.tag.habitId).toBe(h1);
    expect(body.tag.claimedAt).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    expect(body.today).toBe('2026-03-01');
    expect(body.todayExecution).toMatchObject({ habitId: h1, date: '2026-03-01', status: 'done' });
    expect(((await repointed.json()) as { habitId: string }).habitId).toBe(h2);
    expect(unlinked.status).toBe(204);
    await expectProblem(gone, 404, 'entity_not_found');
  });

  it('should be first come, first served: another user gets 409 and cannot resolve or unlink it (404)', async () => {
    const a = await app.user();
    const b = await app.user();
    const t = tag();
    await link(a, t, await app.habit(a));
    await expectProblem(await link(b, t, await app.habit(b)), 409, 'entity_conflict');
    await expectProblem(
      await app.request(b, { method: 'GET', path: `/api/v1/NfcTag/${b.sub}/${t}` }),
      404,
      'entity_not_found',
    );
    await expectProblem(
      await app.request(b, { method: 'DELETE', path: `/api/v1/NfcTag/${b.sub}/${t}` }),
      404,
      'entity_not_found',
    );
    const rows = await app.sql`SELECT user_id FROM proof.nfc_tags WHERE id = ${t}`;
    expect(rows[0]?.user_id).toBe(a.sub);
  });

  it('should let only one of two users racing for an unclaimed tag win', async () => {
    const a = await app.user();
    const b = await app.user();
    const t = tag();
    const [ha, hb] = [await app.habit(a), await app.habit(b)];
    const [x, y] = await Promise.all([link(a, t, ha), link(b, t, hb)]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
  });

  it("should 404 linking a tag to another user's habit, and 400 a bad tag id", async () => {
    const a = await app.user();
    const b = await app.user();
    await expectProblem(await link(b, tag(), await app.habit(a)), 404, 'entity_not_found');
    await expectProblem(await link(a, 'short', await app.habit(a)), 400, 'validation_error');
  });

  it('should 401, 403 and admin-allow the tag routes', async () => {
    const a = await app.user();
    const b = await app.user();
    const t = tag();
    await link(a, t, await app.habit(a));
    await expectProblem(await app.request(null, { method: 'GET', path: `/api/v1/NfcTag/${a.sub}/${t}` }), 401);
    await expectProblem(
      await app.request(b, { method: 'GET', path: `/api/v1/NfcTag/${a.sub}/${t}` }),
      403,
      'unauthorized',
    );
  });

  it("should 404 user B on user A's tag and change nothing (nfc tag entity)", () =>
    expectOwnerScoped(app, {
      seed: async a => {
        const t = tag();
        await link(a, t, await app.habit(a));
        return t;
      },
      request: (id, b) => ({ method: 'GET', path: `/api/v1/NfcTag/${b.sub}/${id}` }),
      unchanged: id => app.sql`SELECT * FROM proof.nfc_tags WHERE id = ${id}`,
    }));

  it('should prove the tag habit on a tap through the router, once', async () => {
    // Arrange
    const a = await app.user();
    const h = await app.habit(a);
    const t = tag();
    await link(a, t, h);
    // Act
    const tap = await app.request(a, { method: 'POST', path: `/api/v1/NfcTag/${a.sub}/${t}/tap` });
    const again = await app.request(a, { method: 'POST', path: `/api/v1/NfcTag/${a.sub}/${t}/tap` });
    // Assert
    expect(((await tap.json()) as { habitId: string; executionId: string }[])[0]?.habitId).toBe(h);
    expect(((await again.json()) as { executionId: string | null }[])[0]?.executionId).toBeNull();
    expect((await app.reports()).filter(r => r.habitId === h && r.proofKey === 'nfc')).toHaveLength(1);
  });

  it('should list tagged habits through the contract and via MCP resolve', async () => {
    const a = await app.user();
    const h = await app.habit(a);
    const t = tag();
    await link(a, t, h);
    const proof = app.contract('proof.v1') as { listTaggedHabits(o: unknown): Promise<string[]> };
    expect(await proof.listTaggedHabits({ kind: 'user', userId: a.sub })).toEqual([h]);
    const res = await app.mcp(a, 'proof.nfcResolve', { userId: a.sub, tagId: t });
    expect((res.data as { tag: { id: string } }).tag.id).toBe(t);
  });

  it('should release the tag and the binding when the habit is deleted', async () => {
    const a = await app.user();
    const h = await app.habit(a);
    const t = tag();
    await link(a, t, h);
    // habit emits habit.deleted; proof reacts once the outbox runs.
    await app.deleteHabit(a, h);
    await app.drainOutbox();
    const rows = await app.sql`SELECT count(*)::int AS n FROM proof.nfc_tags WHERE id = ${t}`;
    expect(rows[0]?.n).toBe(0);
  });
});
