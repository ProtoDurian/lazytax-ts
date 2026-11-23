import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { expectProblem, startTestApp, type TestApp } from '@lazytax/kernel/testing';
import { fakePledge } from '../../src/adapters/fake-pledge-gateway';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp({ now: '2026-03-01T00:00:00Z' });
});
afterAll(() => app.close());
beforeEach(async () => {
  fakePledge.reset();
  app.clock.set('2026-03-01T00:00:00Z');
  await app.sql`DELETE FROM disbursement.disbursements`;
  await app.sql`DELETE FROM penalty.penalties`;
});

const run = async () => {
  const admin = await app.admin();
  const res = await app.request(admin, { method: 'POST', path: '/api/v1/disbursement/run' });
  expect(res.status).toBe(200);
  return ((await res.json()) as { completed: number }).completed;
};

async function charityWithPledge(withOrg = true): Promise<string> {
  const [c] = await app.sql`INSERT INTO charity.charities (name) VALUES ('Test charity') RETURNING id`;
  if (withOrg) {
    await app.sql`INSERT INTO charity.external_ids (charity_id, source, external_key)
      VALUES (${c.id}, 'pledge', ${`org_${crypto.randomUUID()}`})`;
  }
  return c.id as string;
}

async function chargedPenalty(userId: string, charityId: string, cents: number, currency = 'USD') {
  await app.sql`INSERT INTO penalty.penalties
    (habit_execution_id, habit_id, user_id, charity_id, amount_cents, currency, status)
    VALUES (${crypto.randomUUID()}, ${crypto.randomUUID()}, ${userId}, ${charityId}, ${cents}, ${currency}, 'charged')`;
}

const stamped = (charityId: string) =>
  app.sql`SELECT payout_disbursement_id FROM penalty.penalties WHERE charity_id = ${charityId}`;

describe('POST /api/v1/disbursement/run', () => {
  it('should donate the summed charged penalties of every user to the charity once', async () => {
    const ch = await charityWithPledge();
    const a = await app.user();
    const b = await app.user();
    await chargedPenalty(a.sub, ch, 300);
    await chargedPenalty(b.sub, ch, 200);

    expect(await run()).toBe(1);

    expect(fakePledge.donations).toHaveLength(1);
    expect(fakePledge.donations[0]?.request.amountCents).toBe(500);
    const rows = await app.sql`SELECT status, amount_cents, provider_donation_id FROM disbursement.disbursements`;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(1);
    expect(Number(rows[0].amount_cents)).toBe(500);
    expect((await stamped(ch)).every((r: { payout_disbursement_id: string | null }) => r.payout_disbursement_id)).toBe(
      true,
    );
    // A second pass finds nothing new.
    expect(await run()).toBe(0);
    expect(fakePledge.donations).toHaveLength(1);
  });

  it('should keep currencies apart', async () => {
    const ch = await charityWithPledge();
    const a = await app.user();
    await chargedPenalty(a.sub, ch, 300, 'USD');
    await chargedPenalty(a.sub, ch, 400, 'SGD');
    expect(await run()).toBe(2);
    expect(fakePledge.donations.map(d => d.request.currency).sort()).toEqual(['SGD', 'USD']);
  });

  it('should leave penalties of a charity with no Pledge org unclaimed', async () => {
    const ch = await charityWithPledge(false);
    await chargedPenalty((await app.user()).sub, ch, 300);
    expect(await run()).toBe(0);
    expect(fakePledge.donations).toHaveLength(0);
    expect((await stamped(ch))[0].payout_disbursement_id).toBeNull();
  });

  it('should release the penalties when Pledge definitively refuses', async () => {
    const ch = await charityWithPledge();
    await chargedPenalty((await app.user()).sub, ch, 300);
    fakePledge.createMode = 'reject';
    expect(await run()).toBe(0);
    const [d] = await app.sql`SELECT status, attempts FROM disbursement.disbursements`;
    expect(d.status).toBe(2);
    expect(d.attempts).toBe(1);
    expect((await stamped(ch))[0].payout_disbursement_id).toBeNull();
    // Next pass re-claims them into a fresh disbursement.
    fakePledge.createMode = 'ok';
    expect(await run()).toBe(1);
  });

  it('should reconcile an ambiguous failure that did land, without donating twice', async () => {
    const ch = await charityWithPledge();
    await chargedPenalty((await app.user()).sub, ch, 300);
    fakePledge.createMode = 'ambiguous';
    fakePledge.landsOnAmbiguous = true;
    expect(await run()).toBe(0);
    const [d] = await app.sql`SELECT status FROM disbursement.disbursements`;
    expect(d.status).toBe(0);
    expect((await stamped(ch))[0].payout_disbursement_id).not.toBeNull();

    fakePledge.createMode = 'ok';
    app.clock.set('2026-03-01T00:30:00Z');
    expect(await run()).toBe(1);
    expect(fakePledge.donations).toHaveLength(1);
    const [after] = await app.sql`SELECT status, provider_donation_id FROM disbursement.disbursements`;
    expect(after.status).toBe(1);
    expect(after.provider_donation_id).toBe(fakePledge.donations[0]?.donationId);
  });

  it('should let only one of two concurrent passes donate a group', async () => {
    const ch = await charityWithPledge();
    await chargedPenalty((await app.user()).sub, ch, 300);
    const admin = await app.admin();
    const call = () => app.request(admin, { method: 'POST', path: '/api/v1/disbursement/run' });
    const results = await Promise.all([call(), call()]);
    for (const r of results) expect(r.status).toBe(200);
    expect(fakePledge.donations).toHaveLength(1);
    expect(await app.sql`SELECT 1 FROM disbursement.disbursements`).toHaveLength(1);
  });

  it('should be 401 without a token, 401 with an expired one and 403 for a non-admin', async () => {
    await expectProblem(await app.request(null, { method: 'POST', path: '/api/v1/disbursement/run' }), 401);
    const a = await app.user();
    const expired = { sub: a.sub, token: await app.token(a.sub, { expiresInSec: -60 }) };
    await expectProblem(await app.request(expired, { method: 'POST', path: '/api/v1/disbursement/run' }), 401);
    await expectProblem(await app.request(a, { method: 'POST', path: '/api/v1/disbursement/run' }), 403);
    expect(await app.sql`SELECT 1 FROM disbursement.disbursements`).toHaveLength(0);
  });

  it('should be 404 on a path that does not exist', async () => {
    const admin = await app.admin();
    const res = await app.request(admin, { method: 'POST', path: '/api/v1/disbursement/nope' });
    expect(res.status).toBe(404);
  });

  it('should run through the MCP tool for an admin only', async () => {
    const a = await app.user();
    expect((await app.mcp(a, 'disbursement.run', {})).ok).toBe(false);
    const ok = await app.mcp(await app.admin(), 'disbursement.run', {});
    expect(ok.ok).toBe(true);
    expect(ok.data).toEqual({ completed: 0 });
  });
});

// Owner-scoped 404: a disbursement is not a user's entity (it sums many users' penalties) and has no
// route that takes an id, so there is nothing for user B to reach; the 403 above is the whole check.

describe('user purge', () => {
  it('should leave payouts alone when a user is deleted (no row is the user)', async () => {
    const ch = await charityWithPledge();
    const a = await app.user();
    await chargedPenalty(a.sub, ch, 300);
    expect(await run()).toBe(1);
    const res = await app.request(a, { method: 'DELETE', path: '/api/v1/User/Me' });
    expect(res.status).toBeLessThan(300);
    const rows = await app.sql`SELECT * FROM disbursement.disbursements`;
    expect(rows).toHaveLength(1);
    // no column of the schema carries the user
    expect(JSON.stringify(rows)).not.toContain(a.sub);
  });
});
