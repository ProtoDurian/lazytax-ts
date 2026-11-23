// Streaks and the week view (LazyTax Domain/Habit/StreakService.cs, StreakRepository.cs).
import type { SettledStatus } from '@lazytax/check-contract/v1';
import type { DayRecord } from './model';
import { localDate, weekBounds, weekday, windowFor } from './window';

export type DayStatus = 'succeeded' | 'failed' | 'vacation' | 'skip' | 'frozen' | 'not_applicable';

export const dayStatus = (s: SettledStatus | undefined): DayStatus => {
  switch (s) {
    case 'done':
      return 'succeeded';
    case 'missed':
      return 'failed';
    case 'skipped':
      return 'skip';
    case 'frozen':
      return 'frozen';
    case 'vacation':
      return 'vacation';
    default:
      return 'not_applicable';
  }
};

// Max: the longest run of done days; a missed day resets it, other statuses do not.
export function maxStreak(days: readonly DayRecord[]): number {
  let run = 0;
  let max = 0;
  for (const d of days) {
    if (d.status === 'done') max = Math.max(max, ++run);
    else if (d.status === 'missed') run = 0;
  }
  return max;
}

// Current: done days after the last missed day, up to today.
export function currentStreak(days: readonly DayRecord[], today: string): number {
  let since = '';
  for (const d of days) if (d.date <= today && d.status === 'missed' && d.date > since) since = d.date;
  return days.filter(d => d.status === 'done' && d.date > since && d.date <= today).length;
}

interface WeekStatus {
  sunday: DayStatus;
  monday: DayStatus;
  tuesday: DayStatus;
  wednesday: DayStatus;
  thursday: DayStatus;
  friday: DayStatus;
  saturday: DayStatus;
  // "YYYY-MM-DD"
  start: string;
  end: string;
}

export interface StreakStatus {
  currentStreak: number;
  maxStreak: number;
  isCompleteToday: boolean;
  week: WeekStatus;
  today: string;
  todayStatus: DayStatus;
  timeLeftToEodMinutes: number;
}

// days: every execution of one habit, oldest first. One zone (the user's) drives today, the week
// and the time left; each day's status comes from its execution's own date.
export function streakStatus(days: readonly DayRecord[], tz: string, deadlineTime: string, now: Date): StreakStatus {
  const today = localDate(now, tz);
  const { start, end } = weekBounds(today);
  const week: WeekStatus = {
    sunday: 'not_applicable',
    monday: 'not_applicable',
    tuesday: 'not_applicable',
    wednesday: 'not_applicable',
    thursday: 'not_applicable',
    friday: 'not_applicable',
    saturday: 'not_applicable',
    start,
    end,
  };
  for (const d of days)
    if (d.date >= start && d.date <= end) week[weekday(d.date).toLowerCase() as DayStatusKey] = dayStatus(d.status);
  const todays = days.find(d => d.date === today);
  const { deadline } = windowFor(today, tz, deadlineTime);
  return {
    currentStreak: currentStreak(days, today),
    maxStreak: maxStreak(days),
    isCompleteToday: todays?.status === 'done',
    week,
    today,
    todayStatus: dayStatus(todays?.status),
    timeLeftToEodMinutes: Math.max(0, Math.round((deadline.getTime() - now.getTime()) / 60_000)),
  };
}

type DayStatusKey = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';
