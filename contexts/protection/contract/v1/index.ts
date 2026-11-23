// protection.v1: the user's freeze-day balance (LazyTax Domain/Protection). Interfaces and DTOs
// only. Never rename or remove a member once merged; add new ones.
import type { Owner } from '@lazytax/kernel';

export interface FreezeBalanceDto {
  userId: string;
  // Banked freeze days. Never above cap.
  balance: number;
  // The user's current cap: plan base plus streak bonus (plan.v1 freezeCap).
  cap: number;
}

export interface ProtectionV1 {
  // Cuts the user's banked freezes to the cap for this max streak (plan.v1 freezeCap) and returns
  // the balance and cap. Cut freezes are gone; a later higher cap does not restore them. check
  // passes the user's max streak across habits; protection remembers it for balance().
  reconcileCap(userId: string, maxStreak: number): Promise<FreezeBalanceDto>;
  // Spends one freeze day for this user-local date ("YYYY-MM-DD"). True when the date is frozen
  // (already consumed for that date, or one was just spent); false when the balance is 0.
  // Idempotent per (user, date). Joins the caller's unit of work.
  tryConsumeFreeze(userId: string, date: string): Promise<boolean>;
  // The balance of Owner.user(id), cut to the cap first. Throws for Owner.anyone.
  balance(owner: Owner): Promise<FreezeBalanceDto>;
}

// A perfect week for one habit earned one freeze day.
export interface ProtectionAwarded {
  userId: string;
  habitId: string;
  // The Sunday that starts the awarded week, "YYYY-MM-DD".
  weekStart: string;
  balance: number;
  cap: number;
}

declare module '@lazytax/kernel' {
  interface ContractRegistry {
    'protection.v1': ProtectionV1;
  }
  interface EventRegistry {
    'protection.awarded': ProtectionAwarded;
  }
}
