import { expect, it } from 'bun:test';
import { addDays, isDone, previousWeek, weekSundayBounds } from '../../src/domain/weeks';

it('should run a week from Sunday to Saturday', () => {
  // 2026-11-18 is a Wednesday
  expect(weekSundayBounds('2026-11-18')).toEqual({ weekStart: '2026-11-15', weekEnd: '2026-11-21' });
  expect(weekSundayBounds('2026-11-15').weekStart).toBe('2026-11-15');
  expect(weekSundayBounds('2026-11-21').weekStart).toBe('2026-11-15');
});

it('should use the week that contains yesterday as the last completed week', () => {
  // Sunday 22 Nov: yesterday is Saturday 21 Nov, so the week 15..21
  expect(previousWeek('2026-11-22')).toEqual({ weekStart: '2026-11-15', weekEnd: '2026-11-21' });
  // Monday 23 Nov: yesterday is Sunday 22 Nov, so the week 22..28 has only just started: still 22..28
  expect(previousWeek('2026-11-23')).toEqual({ weekStart: '2026-11-22', weekEnd: '2026-11-28' });
});

it('should add days across month, year and leap boundaries', () => {
  expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
});

it('should treat only "done" as success', () => {
  expect(isDone('done')).toBe(true);
  expect(isDone('completed')).toBe(false);
  for (const s of ['missed', 'frozen', 'freeze', 'vacation', 'skipped']) expect(isDone(s)).toBe(false);
});
