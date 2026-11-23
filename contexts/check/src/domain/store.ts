// What the check service needs from its repository. Every method takes the Owner first and the
// repository filters on it in its first query (layer 4).
import type { Owner } from '@lazytax/kernel';
import type {
  CheckRow,
  DayRecord,
  ExecutionRow,
  ExecutionSearch,
  HabitDebt,
  NewCheck,
  NewEvidence,
  NewExecution,
} from './model';

export interface CheckStore {
  // Inserts the checks that do not exist yet (unique per habit and local date).
  createPending(owner: Owner, checks: NewCheck[]): Promise<number>;
  listDuePending(owner: Owner, deadlineBefore: Date, limit: number): Promise<CheckRow[]>;
  listPending(owner: Owner, habitIds: string[]): Promise<CheckRow[]>;
  listForDate(owner: Owner, habitIds: string[], localDate: string): Promise<CheckRow[]>;
  // Checks of the habit whose window [opensAt, deadline) holds `at`.
  listCovering(owner: Owner, habitId: string, at: Date): Promise<CheckRow[]>;
  getForDay(owner: Owner, habitId: string, localDate: string): Promise<CheckRow | null>;
  updatePendingWindow(owner: Owner, id: string, timezone: string, opensAt: Date, deadline: Date): Promise<boolean>;
  deletePending(owner: Owner, ids: string[]): Promise<number>;
  // The check, row-locked for the settle (FOR UPDATE).
  lockForSettle(owner: Owner, checkId: string): Promise<CheckRow | null>;
  // Ids of these checks whose day already has an execution.
  listRecorded(owner: Owner, checkIds: string[]): Promise<Set<string>>;
  evidenceExists(owner: Owner, habitId: string, proofKey: string, externalId: string): Promise<boolean>;
  countSkips(owner: Owner, from: string, to: string): Promise<number>;
  // Inserts the day's execution unless one exists. null when the day was already recorded.
  insertExecution(owner: Owner, e: NewExecution): Promise<ExecutionRow | null>;
  markSettled(
    owner: Owner,
    checkId: string,
    s: { status: string; settledAt: Date; settledBy: string; executionId: string },
  ): Promise<void>;
  insertEvidence(owner: Owner, e: NewEvidence): Promise<void>;
  // Every execution of these habits, oldest first.
  daysForHabits(owner: Owner, habitIds: string[]): Promise<Map<string, DayRecord[]>>;
  // Every execution of the owner's live habits, grouped per habit, oldest first.
  daysForLiveHabits(owner: Owner): Promise<Map<string, DayRecord[]>>;
  searchExecutions(owner: Owner, q: ExecutionSearch): Promise<ExecutionRow[]>;
  getExecution(owner: Owner, id: string): Promise<ExecutionRow | null>;
  // The habit's execution on that date (any version): a done one first, else the latest.
  executionForDate(owner: Owner, habitId: string, date: string): Promise<ExecutionRow | null>;
  // Deletes the owner's evidence rows of this proof (every external id when null).
  deleteEvidence(owner: Owner, proofKey: string, externalId: string | null): Promise<number>;
  openDebts(owner: Owner): Promise<HabitDebt[]>;
  // The habits were deleted: drop their pending checks, keep their history out of streaks.
  markHabitsDeleted(owner: Owner, habitIds: string[]): Promise<void>;
  purgeUser(userId: string): Promise<void>;
}
