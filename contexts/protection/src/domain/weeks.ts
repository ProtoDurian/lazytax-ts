// Calendar-date helpers (LazyTax StreakCalculator.WeekSundayBounds). Dates are "YYYY-MM-DD"
// strings; arithmetic runs on UTC midnights so no timezone or DST can move a day.
const DAY_MS = 86_400_000;

const parse = (date: string): number => {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`bad date "${date}"`);
  return ms;
};

export const addDays = (date: string, days: number): string =>
  new Date(parse(date) + days * DAY_MS).toISOString().slice(0, 10);

// The Sunday-to-Saturday week that contains `date`.
export function weekSundayBounds(date: string): { weekStart: string; weekEnd: string } {
  const dow = new Date(parse(date)).getUTCDay(); // 0 = Sunday
  const weekStart = addDays(date, -dow);
  return { weekStart, weekEnd: addDays(weekStart, 6) };
}

// The last completed week for a user whose local today is `today`: the week containing yesterday.
export const previousWeek = (today: string) => weekSundayBounds(addDays(today, -1));

export const isDone = (status: string): boolean => status === 'done';
