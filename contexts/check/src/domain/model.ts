// check's domain types. Rows as the repository returns them; Dates are instants.
import type { CheckStatus, SettledStatus } from '@lazytax/check-contract/v1';

export interface CheckRow {
  id: string;
  userId: string;
  habitId: string;
  localDate: string;
  timezone: string;
  opensAt: Date;
  deadline: Date;
  status: CheckStatus;
  settledAt: Date | null;
  settledBy: string | null;
  executionId: string | null;
}

export interface NewCheck {
  userId: string;
  habitId: string;
  localDate: string;
  timezone: string;
  opensAt: Date;
  deadline: Date;
}

export interface ExecutionRow {
  id: string;
  userId: string;
  habitId: string;
  habitVersionId: string;
  date: string;
  status: SettledStatus;
  completedAt: Date | null;
  notes: string | null;
  paymentProcessed: boolean;
}

export interface NewExecution {
  userId: string;
  habitId: string;
  habitVersionId: string;
  date: string;
  status: SettledStatus;
  completedAt: Date | null;
  notes: string | null;
  stakeCents: number;
  ratioBps: number;
  currency: string;
  charityId: string | null;
}

export interface NewEvidence {
  userId: string;
  habitId: string;
  checkId: string;
  proofKey: string;
  externalId: string;
  passed: boolean;
  occurredAt: Date;
  receivedAt: Date;
  data: string | null;
}

// What the scheduler needs about an enabled habit (LazyTax SchedulableHabit), with the stake the
// settle copies onto the execution and the event.
export interface Schedulable {
  habitId: string;
  userId: string;
  versionId: string;
  daysOfWeek: string[];
  deadlineTime: string;
  // The user's zone (account) when valid, else the habit version's.
  timezone: string;
  stakeCents: number;
  ratioBps: number;
  currency: string;
  charityId: string | null;
}

// A day's execution for streaks: date + status, oldest first.
export interface DayRecord {
  date: string;
  status: SettledStatus;
}

export interface ExecutionSearch {
  habitId?: string;
  date?: string;
  limit: number;
  skip: number;
}

// Open debt of one habit: failed executions with a money stake, cents to the charity.
export interface HabitDebt {
  habitId: string;
  cents: number;
}

interface SkipQuota {
  tier: string;
  key: string;
  limit: number;
  monthStart: string;
  monthEnd: string;
}

export interface SettleCommand {
  checkId: string;
  habit: Schedulable;
  status: SettledStatus;
  settledBy: string;
  settledAt: Date;
  completedAt?: Date | null;
  notes?: string | null;
  evidence?: NewEvidenceInput;
  skipQuota?: SkipQuota;
}

interface NewEvidenceInput {
  proofKey: string;
  externalId: string;
  passed: boolean;
  occurredAt: Date;
  data: string | null;
}

export interface SettleOutcome {
  execution: ExecutionRow;
  // True when the day was already recorded, so nothing new was settled.
  adopted: boolean;
}

export interface SettledCheck {
  habitId: string;
  localDate: string;
  status: SettledStatus;
}
