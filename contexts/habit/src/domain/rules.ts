// The rules the create and update requests share (LazyTax App/Modules/Habit/API/V1/HabitValidator.cs).
// Pure functions: no database, no kernel.
import { DEFAULT_DEADLINE } from './model';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

// A weekday name in any case ("Friday", "friday"). Numbers ("1", "999") and lists
// ("Monday,Tuesday") are not names.
export function canonicalDay(day: string): string | null {
  if (!/^\p{L}+$/u.test(day)) return null;
  const lower = day.toLowerCase();
  return DAYS.find(d => d.toLowerCase() === lower) ?? null;
}

// "HH:mm:ss" (LazyTax Utils.StandardTimeFormat).
export const isTime = (s: string): boolean => /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(s);

export const isTimezone = (s: string): boolean => {
  if (s.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
    return true;
  } catch {
    return false;
  }
};

// Stakes are whole cents. A decimal string such as "10.50"; "10.500" is the same as "10.5".
// Returns null when it is not a valid non-negative amount with at most 2 decimal places.
export function parseStakeCents(s: string): number | null {
  const m = /^\s*(\+?)(\d+)(?:\.(\d*))?\s*$/.exec(s);
  if (!m) return null;
  const whole = m[2] as string;
  const frac = m[3] ?? '';
  if (/[1-9]/.test(frac.slice(2))) return null;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

export const hasMoneyStake = (s: string): boolean => {
  const cents = parseStakeCents(s);
  return cents !== null && cents > 0;
};

export const deadlineOrDefault = (t: string | null | undefined): string => t ?? DEFAULT_DEADLINE;

export const formatMoney = (cents: number): string => (cents / 100).toFixed(2);
// Basis points as a percentage with one decimal ("100.0").
export const formatRatio = (bps: number): string => (bps / 100).toFixed(1);
