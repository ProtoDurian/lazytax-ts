// plan's service (LazyTax Domain/Subscription, App/Modules/Entitlement) and its plan.v1 implementation.
import type { PlanV1, QuotaDto, QuotaKey } from '@lazytax/plan-contract/v1';
import { type Clock, notFound, type Outbox, Owner, Problem, type UnitOfWork } from '@lazytax/kernel';
import type { SubscriptionRepository } from '../data/subscription-repository';
import { FREE, KEYS, type PlanConfig, type Subscription, type SubscriptionChange } from './model';
import { effective, freezeMax, invalidTier, tierInsufficient } from './rules';

const DAY = 86_400_000;

export interface SubscriptionView {
  userId: string;
  tier: string;
  status: string;
  periodStart: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  nextTier: string | null;
}

const view = (userId: string, s: Subscription | null): SubscriptionView =>
  s
    ? {
        userId,
        tier: s.tier,
        status: s.status,
        periodStart: s.periodStart.toISOString(),
        periodEnd: s.periodEnd.toISOString(),
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        nextTier: s.nextTier,
      }
    : {
        userId,
        tier: FREE,
        status: 'none',
        periodStart: null,
        periodEnd: null,
        cancelAtPeriodEnd: false,
        nextTier: null,
      };

export class PlanService implements PlanV1 {
  constructor(
    private readonly repo: SubscriptionRepository,
    private readonly cfg: PlanConfig,
    private readonly uow: UnitOfWork,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  // ── Routes ──────────────────────────────────────────────────────────────────────────────────
  plans() {
    return Object.entries(this.cfg.tiers)
      .sort(([, a], [, b]) => a.priceCents - b.priceCents)
      .map(([key, t]) => ({
        key,
        priceCents: t.priceCents,
        currency: t.currency,
        habitsMax: t.habitsMax === 2147483647 ? null : t.habitsMax,
        habitsUnlimited: t.habitsMax === 2147483647,
        skipsMonthly: t.skipsMonthly,
        vacationWindowsYearly: t.vacationWindowsYearly,
        freezeBase: t.freezeBase,
      }));
  }

  async get(owner: Owner, userId: string): Promise<SubscriptionView> {
    const s = await this.repo.getForUser(owner, userId);
    return view(userId, effective(s, this.cfg, this.clock.now()));
  }

  // Admin sets a tier (billing is out of scope). free cancels; a paid tier starts a fresh period.
  setTier(owner: Owner, userId: string, tier: string, changedBy: string): Promise<SubscriptionView> {
    if (!this.cfg.tiers[tier]) throw invalidTier(tier);
    return this.uow.run(async () => {
      await this.uow.lockUser(userId);
      const now = this.clock.now();
      const before = effective(await this.repo.getForUser(owner, userId), this.cfg, now)?.tier ?? FREE;
      const s = await this.repo.upsert(owner, userId, {
        tier,
        status: tier === FREE ? 'cancelled' : 'active',
        periodStart: now,
        periodEnd: new Date(now.getTime() + this.cfg.periodDays * DAY),
      });
      await this.repo.addChange(owner, s.id, before, tier, changedBy);
      if (before !== tier)
        await this.outbox.add({ type: 'plan.tierChanged', payload: { userId, from: before, to: tier }, userId });
      return view(userId, effective(s, this.cfg, now));
    });
  }

  // LazyTax Cancel: the paid plan runs to the period end, then lapses.
  cancel(owner: Owner, userId: string): Promise<SubscriptionView> {
    return this.uow.run(async () => {
      await this.uow.lockUser(userId);
      const now = this.clock.now();
      const s = effective(await this.repo.getForUser(owner, userId), this.cfg, now);
      if (!s)
        throw new Problem({
          kind: 'not_found',
          id: 'no_active_subscription',
          title: 'No Active Subscription',
          detail: 'There is no active subscription to cancel',
          data: { userId },
        });
      const updated = await this.repo.setCancelAtPeriodEnd(owner, s.id, true);
      return view(userId, effective(updated, this.cfg, now));
    });
  }

  async getChange(owner: Owner, changeId: string): Promise<SubscriptionChange> {
    const c = await this.repo.getChange(owner, changeId);
    if (!c) throw notFound('SubscriptionChange', changeId);
    return c;
  }

  listChanges(owner: Owner, userId: string): Promise<SubscriptionChange[]> {
    return this.repo.listChanges(owner, userId);
  }

  purgeUser(userId: string): Promise<void> {
    return this.repo.purgeUser(userId);
  }

  // ── plan.v1 ─────────────────────────────────────────────────────────────────────────────────
  async effectiveTier(userId: string): Promise<string> {
    const s = await this.repo.getForUser(Owner.user(userId), userId);
    return effective(s, this.cfg, this.clock.now())?.tier ?? FREE;
  }

  private limit(tier: string, key: string): number {
    const t = this.cfg.tiers[tier];
    if (!t) throw invalidTier(tier);
    // Unknown keys stay permissive (LazyTax SubscriptionService.GetLimitForTier).
    const caps: Record<string, number> = {
      [KEYS.habits]: t.habitsMax,
      [KEYS.skips]: t.skipsMonthly,
      [KEYS.vacationWindows]: t.vacationWindowsYearly,
      [KEYS.freeze]: t.freezeBase,
    };
    return caps[key] ?? 2147483647;
  }

  async quota(userId: string, key: QuotaKey): Promise<QuotaDto> {
    const tier = await this.effectiveTier(userId);
    const k = KEYS[key];
    return { tier, key: k, limit: this.limit(tier, k) };
  }

  async freezeCap(userId: string, maxStreak: number): Promise<number> {
    const tier = await this.effectiveTier(userId);
    return freezeMax(this.limit(tier, KEYS.freeze), maxStreak);
  }

  // Tiers have no explicit order; a plan is "at least" another when it costs as much or more.
  async ensureTier(userId: string, minTier: string): Promise<void> {
    const need = this.cfg.tiers[minTier];
    if (!need) throw invalidTier(minTier);
    const tier = await this.effectiveTier(userId);
    const have = this.cfg.tiers[tier];
    if (have && have.priceCents >= need.priceCents) return;
    throw tierInsufficient(tier, `tier.${minTier}`, 0, `This needs the ${minTier} plan or higher`);
  }

  ensureWithin(quota: QuotaDto, used: number): void {
    if (used >= quota.limit) throw tierInsufficient(quota.tier, quota.key, quota.limit);
  }
}
