// plan.v1: the user's subscription tier and what it entitles them to (LazyTax Domain/Subscription
// + Domain/Entitlement). Interfaces and DTOs only. Never rename or remove a member once merged.

// The counted limits. habits: max habits; skips: per month; vacationWindows: per year.
export type QuotaKey = 'habits' | 'skips' | 'vacationWindows';

// A counted limit of the user's plan (LazyTax Domain/Entitlement/Quota.cs). The context that
// writes counts against it in the same unit of work, under uow.lockUser, then calls ensureWithin.
export interface QuotaDto {
  // The effective tier, e.g. "free", "pro", "ultimate".
  tier: string;
  // The entitlement key, e.g. "ent.vacation.windows.yearly".
  key: string;
  // 2147483647 means unlimited.
  limit: number;
}

export interface PlanV1 {
  // "free" unless an active (or in-grace) paid subscription says otherwise.
  effectiveTier(userId: string): Promise<string>;
  quota(userId: string, key: QuotaKey): Promise<QuotaDto>;
  // The freeze cap for the user's tier and max streak (LazyTax FreezePolicy.ComputeFreezeMax).
  freezeCap(userId: string, maxStreak: number): Promise<number>;
  // Throws 400 tier_insufficient unless the user's tier is minTier or pricier.
  ensureTier(userId: string, minTier: string): Promise<void>;
  // Throws 400 tier_insufficient when used >= quota.limit. Call it under uow.lockUser.
  ensureWithin(quota: QuotaDto, used: number): void;
}

export interface PlanTierChanged {
  userId: string;
  from: string;
  to: string;
}

declare module '@lazytax/kernel' {
  interface ContractRegistry {
    'plan.v1': PlanV1;
  }
  interface EventRegistry {
    'plan.tierChanged': PlanTierChanged;
  }
}
