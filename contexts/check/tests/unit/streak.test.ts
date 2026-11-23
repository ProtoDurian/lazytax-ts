import { describe, expect, it } from 'bun:test';
import type { DayRecord } from '../../src/domain/model';
import { currentStreak, maxStreak, streakStatus } from '../../src/domain/streak';

const days: DayRecord[] = [
  { date: '2026-03-01', status: 'done' },
  { date: '2026-03-02', status: 'done' },
  { date: '2026-03-03', status: 'done' },
  { date: '2026-03-04', status: 'missed' },
  { date: '2026-03-05', status: 'done' },
  { date: '2026-03-06', status: 'skipped' },
  { date: '2026-03-07', status: 'done' },
];

describe('streaks', () => {
  it('should reset the max run only on a missed day', () => {
    // Act & Assert
    expect(maxStreak(days)).toBe(3);
    expect(maxStreak([])).toBe(0);
  });

  it('should count done days after the last missed day up to today', () => {
    // Act & Assert
    expect(currentStreak(days, '2026-03-07')).toBe(2);
    expect(currentStreak(days, '2026-03-03')).toBe(3);
  });

  it('should map the week and today in the user zone', () => {
    // Arrange: 2026-03-07 10:00 in Singapore
    const now = new Date('2026-03-07T02:00:00Z');
    // Act
    const s = streakStatus(days, 'Asia/Singapore', '23:59:00', now);
    // Assert
    expect(s.today).toBe('2026-03-07');
    expect(s.week.start).toBe('2026-03-01');
    expect(s.week.wednesday).toBe('failed');
    expect(s.week.friday).toBe('skip');
    expect(s.todayStatus).toBe('succeeded');
    expect(s.isCompleteToday).toBe(true);
    expect(s.timeLeftToEodMinutes).toBe(14 * 60);
  });
});
