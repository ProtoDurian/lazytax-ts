// check.v1: the daily checks of every habit, their settled executions, streaks and the tick
// (LazyTax Domain/Check + the execution, streak and overview parts of Domain/Habit).
// check owns the complete and skip routes; habit tells check about schedule changes only
// through `habit.changed`. Interfaces and DTOs only. Never rename or remove a member once
// merged; add new ones.
import type { Owner } from '@lazytax/kernel';

// How a check day ended. "pending" only appears on checks, never on executions or events.
export type CheckStatus = 'pending' | 'done' | 'missed' | 'skipped' | 'frozen' | 'vacation';
export type SettledStatus = Exclude<CheckStatus, 'pending'>;

// One check per scheduled habit per user-local date (LazyTax HabitChecks).
export interface CheckDto {
  id: string;
  habitId: string;
  userId: string;
  // User-local date, "YYYY-MM-DD".
  localDate: string;
  // IANA zone the window was computed in.
  timezone: string;
  // ISO 8601 instants. The window is [opensAt, deadline).
  opensAt: string;
  deadline: string;
  status: CheckStatus;
  settledAt: string | null;
  // "manual", a proof key ("nfc", "strava"), "scheduler", "vacation", "freeze" or "adopted".
  settledBy: string | null;
  executionId: string | null;
}

// The settled outcome of one check day (LazyTax HabitExecutions).
export interface ExecutionDto {
  id: string;
  habitId: string;
  habitVersionId: string;
  userId: string;
  // User-local date, "YYYY-MM-DD".
  date: string;
  status: SettledStatus;
  // ISO 8601; set only when status is "done".
  completedAt: string | null;
  notes: string | null;
}

// What a proof plugin reports (LazyTax Domain/Check/Evidence).
// (habitId, proofKey, externalId) is the idempotency key: a replay changes nothing.
export interface EvidenceDto {
  // "manual", "nfc", "strava", ...
  proofKey: string;
  externalId: string;
  verdict: 'passed' | 'failed';
  // ISO 8601. Clamped to now (no evidence from the future).
  occurredAt: string;
  data?: string | null;
  notes?: string | null;
}

export interface StreakDto {
  habitId: string;
  // Done days after the last missed day, up to today.
  current: number;
  // The longest run of done days; a missed day resets it, other statuses do not.
  max: number;
}

export interface CheckV1 {
  // The one way to complete (or fail) a habit: settles the check that was open at
  // evidence.occurredAt. Trusted callers only (proof). null when nothing changed (a replay, the
  // day is already settled, or the evidence came in past deadline + grace). Throws 404 when the
  // habit is not the user's, not live or not enabled.
  report(userId: string, habitId: string, evidence: EvidenceDto): Promise<ExecutionDto | null>;
  // The pending check whose window holds `at` (ISO 8601, clamped to now), opened on demand.
  // null when that day is settled, not scheduled, or past grace. Throws 404 like report.
  pendingCheckAt(userId: string, habitId: string, at: string): Promise<CheckDto | null>;
  // Current and max streak per habit. Habits with no executions get zeros.
  streaks(userId: string, habitIds: string[]): Promise<StreakDto[]>;
  // The longest streak across all of the user's habits (what protection and plan cap freezes by).
  maxStreak(userId: string): Promise<number>;
  // An execution of the owner's, or null (owner-scoped first read).
  getExecution(owner: Owner, executionId: string): Promise<ExecutionDto | null>;
  // True when the execution exists and belongs to the user.
  ownsExecution(userId: string, executionId: string): Promise<boolean>;
  // The owner's execution of the habit (any version) on that user-local date ("YYYY-MM-DD"), a
  // done one winning, else the latest; null when none (or not the owner's).
  executionForDate(owner: Owner, habitId: string, date: string): Promise<ExecutionDto | null>;
}

// One check settled: written in the settle's unit of work (LazyTax CheckEvents "CheckSettled").
// penalty stakes it, protection awards freezes from it, friend posts friend stakes from it.
export interface CheckSettled {
  userId: string;
  habitId: string;
  habitVersionId: string;
  checkId: string;
  executionId: string;
  // User-local date, "YYYY-MM-DD".
  date: string;
  status: SettledStatus;
  // The habit version's stake at settle time; integer cents.
  stakeCents: number;
  // Basis points of the stake that goes to the charity (10000 = 100%).
  ratioBps: number;
  currency: string;
  // null for a habit without a money stake.
  charityId: string | null;
  // The user's max streak across habits after this settle.
  maxStreak: number;
  // True when the check only adopted an execution that was already recorded for the day.
  adopted: boolean;
}

declare module '@lazytax/kernel' {
  interface ContractRegistry {
    'check.v1': CheckV1;
  }
  interface EventRegistry {
    'check.settled': CheckSettled;
  }
}
