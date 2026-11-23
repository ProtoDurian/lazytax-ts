// In-memory fakes for the penalty unit tests. No database, no network.
import type { Clock, Logger, Outbox, OutboxEventInput, Owner, UnitOfWork } from '@lazytax/kernel';
import type { CharityDto } from '@lazytax/charity-contract/v1';
import type {
  ChargeGateway,
  ChargeOutcome,
  CharityBalanceDto,
  NewPenalty,
  PayoutGroupDto,
  PenaltyDto,
  PenaltyRepo,
  PenaltySearchQuery,
} from '../../src/domain/model';
import { type PenaltyConfig, PenaltyService } from '../../src/domain/penalty-service';

const owns = (owner: Owner, p: PenaltyDto) => owner.kind === 'anyone' || owner.userId === p.userId;

class FakeRepo implements PenaltyRepo {
  rows: PenaltyDto[] = [];
  balances = new Map<string, number>();
  private n = 0;
  constructor(private readonly clock: Clock) {}

  seed(p: Partial<PenaltyDto> & { userId: string }): PenaltyDto {
    const at = this.clock.now().toISOString();
    const row: PenaltyDto = {
      id: `p${++this.n}`,
      habitExecutionId: `e${this.n}`,
      habitId: 'h1',
      charityId: 'c1',
      amountCents: 500,
      currency: 'USD',
      status: 'pending',
      paymentIntentId: null,
      attempts: 0,
      lastError: null,
      disbursementId: null,
      createdAt: at,
      updatedAt: at,
      ...p,
    };
    this.rows.push(row);
    return row;
  }
  async enqueue(_o: Owner, p: NewPenalty) {
    if (this.rows.some(r => r.habitExecutionId === p.habitExecutionId)) return false;
    this.seed({ ...p });
    return true;
  }
  async get(o: Owner, id: string) {
    return this.rows.find(r => r.id === id && owns(o, r)) ?? null;
  }
  async search(o: Owner, q: Required<Pick<PenaltySearchQuery, 'limit' | 'skip'>> & PenaltySearchQuery) {
    return this.rows.filter(r => owns(o, r) && (!q.status || r.status === q.status)).slice(q.skip, q.skip + q.limit);
  }
  async outstanding(o: Owner) {
    const m = new Map<string, { currency: string; totalCents: number; count: number }>();
    for (const r of this.rows.filter(r => owns(o, r) && r.status !== 'charged')) {
      const g = m.get(r.currency) ?? { currency: r.currency, totalCents: 0, count: 0 };
      g.totalCents += r.amountCents;
      g.count += 1;
      m.set(r.currency, g);
    }
    return [...m.values()];
  }
  async charityBalances(_o: Owner): Promise<CharityBalanceDto[]> {
    return [...this.balances].map(([k, v]) => {
      const [charityId = '', currency = ''] = k.split('|');
      return { charityId, currency, accruedCents: v, updatedAt: '' };
    });
  }
  async claimPending(_o: Owner, batchSize: number, staleBefore: Date) {
    const due = this.rows
      .filter(r => r.status === 'pending' || (r.status === 'processing' && new Date(r.updatedAt) < staleBefore))
      .slice(0, batchSize);
    for (const r of due) {
      r.status = 'processing';
      r.updatedAt = this.clock.now().toISOString();
    }
    return due.map(r => ({ ...r }));
  }
  async lockForSettle(o: Owner, id: string) {
    const r = await this.get(o, id);
    return r ? { ...r } : null;
  }
  private row(id: string) {
    const r = this.rows.find(x => x.id === id);
    if (!r) throw new Error(`no row ${id}`);
    return r;
  }
  async markCharged(_o: Owner, p: PenaltyDto, intent: string) {
    const r = this.row(p.id);
    if (r.status === 'charged') return;
    Object.assign(r, { status: 'charged', paymentIntentId: intent, lastError: null });
    const k = `${r.charityId}|${r.currency}`;
    this.balances.set(k, (this.balances.get(k) ?? 0) + r.amountCents);
  }
  async markPending(_o: Owner, id: string, intent: string | null, attempts: number, error: string | null) {
    const r = this.row(id);
    Object.assign(r, {
      status: 'pending',
      attempts,
      paymentIntentId: intent ?? r.paymentIntentId,
      lastError: error ?? r.lastError,
    });
  }
  async markFailed(_o: Owner, id: string, attempts: number, error: string) {
    Object.assign(this.row(id), { status: 'failed', attempts, lastError: error });
  }
  async markSkipped(_o: Owner, id: string) {
    this.row(id).status = 'skipped';
  }
  async payoutCandidates(_o: Owner, min: number): Promise<PayoutGroupDto[]> {
    const m = new Map<string, PayoutGroupDto>();
    for (const r of this.rows.filter(r => r.status === 'charged' && !r.disbursementId)) {
      const k = `${r.charityId}|${r.currency}`;
      const g = m.get(k) ?? { charityId: r.charityId, currency: r.currency, amountCents: 0 };
      g.amountCents += r.amountCents;
      m.set(k, g);
    }
    return [...m.values()].filter(g => g.amountCents >= min).sort((a, b) => b.amountCents - a.amountCents);
  }
  async claimForPayout(_o: Owner, d: string, charityId: string, currency: string) {
    let total = 0;
    for (const r of this.rows)
      if (r.status === 'charged' && !r.disbursementId && r.charityId === charityId && r.currency === currency) {
        r.disbursementId = d;
        total += r.amountCents;
      }
    return total;
  }
  async releasePayout(_o: Owner, d: string) {
    for (const r of this.rows) if (r.disbursementId === d) r.disbursementId = null;
  }
  async purgeUser(userId: string) {
    for (const r of this.rows) if (r.userId === userId) r.userId = 'deleted-user';
  }
}

class FakeUow implements UnitOfWork {
  depth = 0;
  units = 0;
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.depth === 0) this.units++;
    this.depth++;
    try {
      return await fn();
    } finally {
      this.depth--;
    }
  }
  db(): never {
    throw new Error('FakeUow has no database');
  }
  async lockUser() {}
  inUnit() {
    return this.depth > 0;
  }
  afterCommit(fn: () => void) {
    fn();
  }
}

class FakeGateway implements ChargeGateway {
  calls: { id: string; inUnit: boolean }[] = [];
  next: (p: PenaltyDto) => ChargeOutcome | Promise<ChargeOutcome> = () => ({
    kind: 'succeeded',
    paymentIntentId: 'int_1',
  });
  constructor(private readonly uow: FakeUow) {}
  async charge(p: PenaltyDto) {
    this.calls.push({ id: p.id, inUnit: this.uow.inUnit() });
    return this.next(p);
  }
}

export interface Fixture {
  clock: { now(): Date };
  repo: FakeRepo;
  uow: FakeUow;
  gateway: FakeGateway;
  events: OutboxEventInput[];
  service: PenaltyService;
}

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
} as unknown as Logger;

export function fixture(config: Partial<PenaltyConfig> = {}): Fixture {
  const clock = { now: () => new Date('2026-03-01T00:00:00Z') };
  const repo = new FakeRepo(clock);
  const uow = new FakeUow();
  const gateway = new FakeGateway(uow);
  const events: OutboxEventInput[] = [];
  const outbox: Outbox = {
    async add(e) {
      if (!uow.inUnit()) throw new Error('outbox.add outside a unit');
      events.push(e as OutboxEventInput);
    },
  };
  const service = new PenaltyService(
    repo,
    gateway,
    { get: async id => (id === 'c1' ? ({ name: 'Doctors Without Borders' } as CharityDto) : null) },
    uow,
    outbox,
    clock,
    { batchSize: 100, maxAttempts: 5, claimLeaseMs: 600_000, blockDeletionOnDebt: true, ...config },
    silent,
  );
  return { clock, repo, uow, gateway, events, service };
}
