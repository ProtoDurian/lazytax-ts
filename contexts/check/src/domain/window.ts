// Check windows and user-local dates (LazyTax Domain/Check/CheckWindow.cs). Pure functions over
// IANA zones; dates are "YYYY-MM-DD", times "HH:mm[:ss]".

export const DEFAULT_DEADLINE = '23:59:00';

// Late evidence from before the deadline can still land this long after it, and the tick waits
// this long before settling a check as missed.
export const GRACE_MS = 30 * 60_000;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const formats = new Map<string, Intl.DateTimeFormat>();

function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formats.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz || tz.trim() === '') return false;
  try {
    format(tz);
    return true;
  } catch {
    return false;
  }
}

// The zone to compute in: the given one when it is valid, else UTC (LazyTax CheckWindow.Resolve).
export const resolveTimezone = (tz: string | null | undefined): string => (isValidTimezone(tz) ? tz : 'UTC');

// The wall clock of an instant in a zone, as a UTC-epoch number of the same fields.
function wallClock(instant: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const part of format(tz).formatToParts(new Date(instant)))
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Date.UTC(p.year ?? 1970, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
}

const isoDate = (epoch: number): string => new Date(epoch).toISOString().slice(0, 10);

function parseDate(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`bad date ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function parseTime(time: string): number {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!m) throw new Error(`bad time ${time}`);
  return (Number(m[1]) * 60 + Number(m[2])) * MINUTE + Number(m[3] ?? 0) * 1000;
}

// The user-local date of an instant.
export const localDate = (instant: Date, tz: string): string => isoDate(wallClock(instant.getTime(), tz));

export const addDays = (date: string, days: number): string => isoDate(parseDate(date) + days * DAY);

export const weekday = (date: string): (typeof WEEKDAYS)[number] =>
  WEEKDAYS[new Date(parseDate(date)).getUTCDay()] ?? 'Sunday';

export const isScheduledOn = (daysOfWeek: readonly string[], date: string): boolean => {
  const day = weekday(date).toLowerCase();
  return daysOfWeek.some(d => d.toLowerCase() === day);
};

// The UTC instant of a local wall time. A time inside a DST gap moves forward to the first one
// that exists, 15 minutes at a time, like LazyTax.
export function localToUtc(date: string, time: string, tz: string): Date {
  let local = parseDate(date) + parseTime(time);
  for (let i = 0; i < 16; i++, local += 15 * MINUTE) {
    let guess = local - (wallClock(local, tz) - local);
    guess = local - (wallClock(guess, tz) - guess);
    if (wallClock(guess, tz) === local) return new Date(guess);
  }
  throw new Error(`no valid local time near ${date} ${time} in ${tz}`);
}

export interface Window {
  opensAt: Date;
  deadline: Date;
}

// A check opens at local midnight; its deadline is the end of the deadline minute (23:59 means
// "until midnight"), both in the given zone.
export function windowFor(date: string, tz: string, deadlineTime: string): Window {
  const opensAt = localToUtc(date, '00:00', tz);
  let deadline = new Date(localToUtc(date, deadlineTime, tz).getTime() + MINUTE);
  if (deadline <= opensAt) deadline = new Date(opensAt.getTime() + MINUTE);
  return { opensAt, deadline };
}

// The Sunday-to-Saturday week holding the date.
export function weekBounds(date: string): { start: string; end: string } {
  const start = addDays(date, -new Date(parseDate(date)).getUTCDay());
  return { start, end: addDays(start, 6) };
}

// The first and last day of the date's month.
export function monthBounds(date: string): { start: string; end: string } {
  const d = new Date(parseDate(date));
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start: isoDate(start), end: isoDate(next - DAY) };
}

// "YYYY-MM-DD" -> "dd-MM-yyyy" (LazyTax Utils.StandardDateFormat).
export const toStandardDate = (date: string): string => `${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}`;

// "dd-MM-yyyy" -> "YYYY-MM-DD", or null when it is not a real date.
export function fromStandardDate(s: string): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const epoch = parseDate(iso);
  return isoDate(epoch) === iso ? iso : null;
}

// "HH:mm:ss" -> "HH:mm".
export const hhmm = (time: string): string => time.slice(0, 5);
