import { describe, expect, it } from 'bun:test';
import type { Logger, Outbox, UnitOfWork } from '@lazytax/kernel';
import { FakePledgeGateway } from '../../src/adapters/fake-pledge-gateway';
import type { DisbursementStore, NewDisbursement } from '../../src/domain/disbursement-repository';
import { DisbursementService } from '../../src/domain/disbursement-service';
import type { DisbursementRow } from '../../src/domain/model';
import type { CharityTargets, PayoutCandidate, PenaltyPayouts } from '../../src/domain/ports';

const donor = { firstName: 'Lazy', lastName: 'Tax', email: 'd@x.club' };
const defaults = { donor, minPayoutCents: 0, maxGroups: 10, reconcileLeaseMs: 600_000 };
const CH1 = '11111111-1111-1111-1111-111111111111';
const CH2 = '22222222-2222-2222-2222-222222222222';

class Rig {
  rows = new Map<string, DisbursementRow>();
  inUnit = false;
  gatewayCalledInUnit = false;
  events: string[] = [];
  released: string[] = [];
  stamped: string[] = [];
  candidates: PayoutCandidate[] = [];
  orgs = new Map<string, string>([
    [CH1, 'org_1'],
    [CH2, 'org_2'],
  ]);
  now = new Date('2026-03-01T00:00:00Z');
  gateway = new FakePledgeGateway();
  n = 0;

  uow = {
    run: async <T>(fn: () => Promise<T>) => {
      const was = this.inUnit;
      this.inUnit = true;
      try {
        return await fn();
      } finally {
        this.inUnit = was;
      }
    },
  } as unknown as UnitOfWork;
  outbox = { add: async (e: { type: string }) => void this.events.push(e.type) } as unknown as Outbox;
  log = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

  store: DisbursementStore = {
    insertPending: async (_o, r: NewDisbursement) => {
      this.rows.set(r.id, {
        ...r,
        status: 'pending',
        providerDonationId: null,
        attempts: 0,
        lastError: null,
        createdAt: r.now,
        updatedAt: r.now,
      });
    },
    get: async (_o, id) => this.rows.get(id) ?? null,
    getForUpdate: async (_o, id) => this.rows.get(id) ?? null,
    markCompleted: async (_o, id, don, now) => {
      const r = this.rows.get(id);
      if (r) Object.assign(r, { status: 'completed', providerDonationId: don, updatedAt: now });
    },
    markFailed: async (_o, id, error, now) => {
      const r = this.rows.get(id);
      if (r) Object.assign(r, { status: 'failed', lastError: error, attempts: r.attempts + 1, updatedAt: now });
    },
    listReconcilable: async (_o, cutoff, size) =>
      [...this.rows.values()].filter(r => r.status === 'pending' && r.updatedAt < cutoff).slice(0, size),
  };
  penalty: PenaltyPayouts = {
    payoutCandidates: async () => this.candidates,
    claimForPayout: async (id, charityId, currency) => {
      this.stamped.push(id);
      return this.candidates.find(c => c.charityId === charityId && c.currency === currency)?.amountCents ?? 0;
    },
    releasePayout: async id => void this.released.push(id),
  };
  charity: CharityTargets = { pledgeOrganizationId: async id => this.orgs.get(id) ?? null };

  svc() {
    const gw = this.gateway;
    const orig = gw.createDonation.bind(gw);
    gw.createDonation = async req => {
      if (this.inUnit) this.gatewayCalledInUnit = true;
      return orig(req);
    };
    return new DisbursementService(
      this.store,
      this.penalty,
      this.charity,
      gw,
      this.uow,
      this.outbox,
      { now: () => this.now },
      this.log,
      defaults,
      () => `id-${++this.n}`,
    );
  }
}

describe('DisbursementService.processPending', () => {
  it('should donate each (charity, currency) group and complete it', async () => {
    const r = new Rig();
    r.candidates = [
      { charityId: CH1, currency: 'USD', amountCents: 500 },
      { charityId: CH2, currency: 'SGD', amountCents: 300 },
    ];
    const done = await r.svc().processPending();
    expect(done).toBe(2);
    expect(r.gateway.donations.map(d => d.request.organizationId)).toEqual(['org_1', 'org_2']);
    expect(r.rows.get('id-1')?.status).toBe('completed');
    expect(r.rows.get('id-1')?.providerDonationId).toBe('don_1');
    expect(r.events).toEqual(['disbursement.completed', 'disbursement.completed']);
  });

  it('should never call the gateway inside a unit of work', async () => {
    const r = new Rig();
    r.candidates = [{ charityId: CH1, currency: 'USD', amountCents: 500 }];
    await r.svc().processPending();
    expect(r.gateway.donations).toHaveLength(1);
    expect(r.gatewayCalledInUnit).toBe(false);
  });

  it('should leave a charity with no Pledge org id unclaimed', async () => {
    const r = new Rig();
    r.orgs.delete(CH1);
    r.candidates = [{ charityId: CH1, currency: 'USD', amountCents: 500 }];
    expect(await r.svc().processPending()).toBe(0);
    expect(r.rows.size).toBe(0);
    expect(r.stamped).toEqual([]);
  });

  it('should claim at most maxGroups groups', async () => {
    const r = new Rig();
    r.candidates = [
      { charityId: CH1, currency: 'USD', amountCents: 500 },
      { charityId: CH2, currency: 'USD', amountCents: 400 },
    ];
    expect(await r.svc().processPending({ maxGroups: 1 })).toBe(1);
    expect(r.rows.size).toBe(1);
  });

  it('should release the penalties on a definitive rejection', async () => {
    const r = new Rig();
    r.gateway.createMode = 'reject';
    r.candidates = [{ charityId: CH1, currency: 'USD', amountCents: 500 }];
    expect(await r.svc().processPending()).toBe(0);
    expect(r.rows.get('id-1')?.status).toBe('failed');
    expect(r.rows.get('id-1')?.attempts).toBe(1);
    expect(r.released).toEqual(['id-1']);
    expect(r.events).toEqual(['disbursement.failed']);
  });

  it('should leave the row pending and not release on an ambiguous failure', async () => {
    const r = new Rig();
    r.gateway.createMode = 'ambiguous';
    r.candidates = [{ charityId: CH1, currency: 'USD', amountCents: 500 }];
    expect(await r.svc().processPending()).toBe(0);
    expect(r.rows.get('id-1')?.status).toBe('pending');
    expect(r.released).toEqual([]);
  });

  it('should complete a landed-but-unanswered donation by reconcile, without donating twice', async () => {
    const r = new Rig();
    r.gateway.createMode = 'ambiguous';
    r.gateway.landsOnAmbiguous = true;
    r.candidates = [{ charityId: CH1, currency: 'USD', amountCents: 500 }];
    const svc = r.svc();
    await svc.processPending();
    r.gateway.createMode = 'ok';
    r.candidates = [];
    r.now = new Date('2026-03-01T00:11:00Z'); // past the lease
    expect(await svc.processPending()).toBe(1);
    expect(r.rows.get('id-1')?.status).toBe('completed');
    expect(r.gateway.donations).toHaveLength(1);
    expect(r.released).toEqual([]);
  });

  it('should release for retry when reconcile conclusively finds no donation', async () => {
    const r = new Rig();
    r.gateway.createMode = 'ambiguous';
    r.candidates = [{ charityId: CH1, currency: 'USD', amountCents: 500 }];
    const svc = r.svc();
    await svc.processPending();
    r.candidates = [];
    r.now = new Date('2026-03-01T00:11:00Z');
    await svc.processPending();
    expect(r.rows.get('id-1')?.status).toBe('failed');
    expect(r.released).toEqual(['id-1']);
  });

  it('should keep the row pending when the reconcile lookup is inconclusive', async () => {
    const r = new Rig();
    r.gateway.createMode = 'ambiguous';
    r.candidates = [{ charityId: CH1, currency: 'USD', amountCents: 500 }];
    const svc = r.svc();
    await svc.processPending();
    r.candidates = [];
    r.gateway.lookupFails = true;
    r.now = new Date('2026-03-01T00:11:00Z');
    expect(await svc.processPending()).toBe(0);
    expect(r.rows.get('id-1')?.status).toBe('pending');
    expect(r.released).toEqual([]);
  });

  it('should not reconcile a row still inside the lease', async () => {
    const r = new Rig();
    r.gateway.createMode = 'ambiguous';
    r.gateway.landsOnAmbiguous = true;
    r.candidates = [{ charityId: CH1, currency: 'USD', amountCents: 500 }];
    const svc = r.svc();
    await svc.processPending();
    r.candidates = [];
    r.now = new Date('2026-03-01T00:05:00Z');
    expect(await svc.processPending()).toBe(0);
    expect(r.rows.get('id-1')?.status).toBe('pending');
  });

  it('should never undo a completed disbursement', async () => {
    const r = new Rig();
    r.candidates = [{ charityId: CH1, currency: 'USD', amountCents: 500 }];
    const svc = r.svc();
    await svc.processPending();
    // a second, stale failure for the same id must be a no-op
    await (svc as unknown as { markFailed(id: string, e: string): Promise<void> }).markFailed('id-1', 'late');
    expect(r.rows.get('id-1')?.status).toBe('completed');
    expect(r.released).toEqual([]);
  });

  it('should roll back the claim when the stamped sum differs from the candidate sum', async () => {
    const r = new Rig();
    r.candidates = [{ charityId: CH1, currency: 'USD', amountCents: 500 }];
    r.penalty.claimForPayout = async () => 499;
    await expect(r.svc().processPending()).rejects.toThrow('claim mismatch');
  });
});
