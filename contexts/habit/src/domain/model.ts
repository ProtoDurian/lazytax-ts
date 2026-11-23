// The habit context's own types. The contract's HabitVersionDto is what leaves the context.
import type { HabitVersionDto } from '@lazytax/habit-contract/v1';

export type HabitVersion = HabitVersionDto;

// What a create or an update writes as a new version.
export interface VersionInput {
  task: string;
  daysOfWeek: string[];
  notificationTime: string;
  deadlineTime: string;
  stakeCents: number;
  currency: string;
  ratioBps: number;
  charityId: string | null;
  timezone: string;
}

export interface HabitRow {
  id: string;
  userId: string;
  version: number;
  enabled: boolean;
  routineId: string | null;
  sortOrder: number;
}

export interface Routine {
  id: string;
  userId: string;
  name: string;
}

export interface HabitSearch {
  id?: string;
  task?: string;
  enabled?: boolean;
  limit: number;
  skip: number;
}

export interface RoutineSearch {
  name?: string;
  limit: number;
  skip: number;
}

export const DEFAULT_DEADLINE = '23:59:00';
export const DEFAULT_STAKE_CURRENCY = 'USD';
// 100%: all the stake goes to the charity (LazyTax fixes the ratio at 1.0).
export const FULL_RATIO_BPS = 10_000;
