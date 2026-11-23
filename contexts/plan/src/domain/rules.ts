// Pure plan rules, ported 1:1 so they unit-test without a database.
import { Problem } from '@lazytax/kernel';
import { FREE, KEYS, type PlanConfig, type Subscription } from './model';

const DAY = 86_400_000;

// LazyTax Domain/Subscription/EffectiveSubscription.cs: null = no effective paid plan.
export function effective(sub: Subscription | null, cfg: PlanConfig, now: Date): Subscription | null {
  if (!sub || (sub.status !== 'active' && sub.status !== 'grace')) return null;
  if (sub.tier === FREE || !cfg.tiers[sub.tier]) return null;
  if (now.getTime() > sub.periodEnd.getTime()) {
    if (sub.cancelAtPeriodEnd) return null;
    const next = cfg.tiers[sub.nextTier ?? sub.tier];
    if (!next || now.getTime() > sub.periodEnd.getTime() + cfg.gracePeriodDays * DAY) return null;
  }
  return sub;
}

// LazyTax App/Modules/Protection/FreezePolicy.cs.
export function freezeMax(baseCap: number, maxStreak: number): number {
  if (baseCap <= 0) return 0;
  let bonus = 0;
  if (maxStreak >= 30) bonus += 1;
  if (maxStreak >= 80) bonus += 1;
  if (maxStreak >= 150) bonus += 1 + Math.floor((maxStreak - 150) / 150);
  return baseCap + bonus;
}

const NOUNS: Record<string, [string, string]> = {
  [KEYS.habits]: ['habit', ''],
  [KEYS.skips]: ['skip', ' per month'],
  [KEYS.vacationWindows]: ['vacation window', ' per year'],
  [KEYS.freeze]: ['streak freeze', ''],
};

// LazyTax App/Error/V1/TierInsufficient.cs (a DomainProblem -> 400).
export function tierInsufficient(tier: string, limitKey: string, limitValue: number, detail?: string): Problem {
  const plan = tier || 'current';
  const noun = NOUNS[limitKey];
  let d = detail;
  if (d === undefined) {
    if (!noun)
      d = limitKey
        ? `Your ${plan} plan has reached its limit of ${limitValue} for '${limitKey}'.`
        : `Your ${plan} plan does not allow this action.`;
    else if (limitValue <= 0) d = `Your ${plan} plan does not include ${noun[0]}s.`;
    else d = `Your ${plan} plan allows up to ${limitValue} ${noun[0]}${limitValue === 1 ? '' : 's'}${noun[1]}.`;
  }
  return new Problem({
    kind: 'validation',
    id: 'tier_insufficient',
    title: 'Tier Insufficient',
    detail: d,
    data: { tier, limitKey, limitValue },
  });
}

export const invalidTier = (tier: string) =>
  new Problem({
    kind: 'validation',
    id: 'invalid_subscription_tier',
    title: 'Invalid Subscription Tier',
    detail: `Unknown tier '${tier}'`,
    data: { tier },
  });
