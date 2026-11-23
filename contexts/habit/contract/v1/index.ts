// habit.v1: habits, their versions and routines (LazyTax Domain/Habit + Domain/Routine).
// check owns the complete and skip routes, executions, streaks and the tick; it reads habits
// only through this contract. Interfaces and DTOs only. Never rename or remove a member once
// merged; add new ones.
import type { Owner } from '@lazytax/kernel';

// One version of a habit: the blueprint a check is settled against. A habit has many versions;
// every update writes a new one and moves the habit's current-version pointer.
export interface HabitVersionDto {
  // The habit version id (what the complete and skip routes take).
  id: string;
  habitId: string;
  userId: string;
  version: number;
  // Of the habit, not of the version: false when the user switched the habit off.
  enabled: boolean;
  routineId: string | null;
  task: string;
  // Canonical names: "Monday" ... "Sunday".
  daysOfWeek: string[];
  // "HH:mm:ss". Phone reminder only.
  notificationTime: string;
  // "HH:mm:ss". The day's check deadline (default "23:59:00").
  deadlineTime: string;
  // Money is integer cents + currency.
  stakeCents: number;
  currency: string;
  // Basis points of the stake that goes to the charity (10000 = 100%).
  ratioBps: number;
  // null for a habit without a money stake.
  charityId: string | null;
  // IANA zone the habit's days and deadline are read in.
  timezone: string;
}

export interface HabitListQuery {
  enabled?: boolean;
  // Case-insensitive "contains" on the task.
  task?: string;
  // Default 20.
  limit?: number;
  // Default 0.
  skip?: number;
}

export interface HabitV1 {
  // The current version of every live (not deleted), enabled habit, optionally narrowed to some
  // users and/or some habits. For check's tick and retime: trusted callers only, no Owner.
  listSchedulable(userIds?: string[], habitIds?: string[]): Promise<HabitVersionDto[]>;
  // Any version of a live habit by version id. null when there is none, or it is not the
  // owner's (the first read is owner-scoped: the LazyTax SkipHabit bug).
  getVersion(owner: Owner, versionId: string): Promise<HabitVersionDto | null>;
  // The current version of a live habit. null when none, or not the owner's.
  getCurrent(owner: Owner, habitId: string): Promise<HabitVersionDto | null>;
  // True when the habit is live and belongs to the user.
  owns(userId: string, habitId: string): Promise<boolean>;
  // Every version of a live habit, newest first. [] when none, or not the owner's.
  listVersions(owner: Owner, habitId: string): Promise<HabitVersionDto[]>;
  // The owner's live habits' current versions, in the user's habit order (not just enabled ones).
  listCurrent(owner: Owner, query?: HabitListQuery): Promise<HabitVersionDto[]>;
  // Versions by id, for trusted callers that hold ids from their own owner-scoped rows (a
  // penalty email naming the habit). Habits that were deleted still resolve here, so history
  // keeps its names. Unknown ids are left out.
  getVersionsByIds(versionIds: string[]): Promise<HabitVersionDto[]>;
  // The user's live habits, enabled or not.
  countHabits(userId: string): Promise<number>;
}

// Habits were created-updated-switched or removed: their schedule changed, so check retimes
// the pending checks (LazyTax CheckService.RetimePending).
export interface HabitChanged {
  userId: string;
  habitIds: string[];
}

// Habits were soft deleted (alone or with their routine). proof releases their NFC tags.
export interface HabitDeleted {
  userId: string;
  habitIds: string[];
}

declare module '@lazytax/kernel' {
  interface ContractRegistry {
    'habit.v1': HabitV1;
  }
  interface EventRegistry {
    'habit.changed': HabitChanged;
    'habit.deleted': HabitDeleted;
  }
}
