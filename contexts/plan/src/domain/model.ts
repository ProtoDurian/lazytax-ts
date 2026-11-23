// plan's model (LazyTax Domain/Subscription/Model.cs) and config (App/StartUp/Options/SubscriptionOption.cs).
import { z } from '@lazytax/kernel';

const UNLIMITED = 2147483647;

const Tier = z.object({
  priceCents: z.number().int().min(0),
  currency: z.string().default('USD'),
  habitsMax: z.number().int().min(0),
  skipsMonthly: z.number().int().min(0),
  vacationWindowsYearly: z.number().int().min(0),
  freezeBase: z.number().int().min(0),
});

// Defaults = LazyTax App/Config/settings.yaml Subscription.Tiers.
export const PlanConfig = z.object({
  gracePeriodDays: z.number().int().min(1).max(90).default(7),
  // Length of a period an admin grants with PUT /:userId/tier.
  periodDays: z.number().int().min(1).default(30),
  tiers: z.record(z.string(), Tier).default({
    free: { priceCents: 0, currency: 'USD', habitsMax: 2, skipsMonthly: 3, vacationWindowsYearly: 0, freezeBase: 0 },
    pro: {
      priceCents: 499,
      currency: 'USD',
      habitsMax: 10,
      skipsMonthly: 20,
      vacationWindowsYearly: 6,
      freezeBase: 14,
    },
    ultimate: {
      priceCents: 799,
      currency: 'USD',
      habitsMax: UNLIMITED,
      skipsMonthly: 60,
      vacationWindowsYearly: 12,
      freezeBase: 30,
    },
  }),
});
export type PlanConfig = z.output<typeof PlanConfig>;

export const FREE = 'free';

export type SubscriptionStatus = 'pending_activation' | 'active' | 'grace' | 'cancelled';

export interface Subscription {
  id: string;
  userId: string;
  tier: string;
  status: SubscriptionStatus;
  periodStart: Date;
  periodEnd: Date;
  cancelAtPeriodEnd: boolean;
  nextTier: string | null;
}

export interface SubscriptionChange {
  id: string;
  subscriptionId: string;
  fromTier: string;
  toTier: string;
  changedBy: string;
  createdAt: Date;
}

// Entitlement keys (LazyTax App/StartUp/Registry/EntitlementKeys.cs).
export const KEYS = {
  habits: 'ent.habits.max',
  skips: 'ent.skips.monthly',
  vacationWindows: 'ent.vacation.windows.yearly',
  freeze: 'ent.freeze.base',
} as const;
