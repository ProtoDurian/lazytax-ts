import { describe, expect, it } from 'bun:test';
import { endToday, isDate, validateRange, windowYear } from '../../src/domain/rules';

const v = (startDate: string, endDate: string) => ({
  id: 'v',
  userId: 'u',
  record: { startDate, endDate, timezone: 'UTC' },
  createdAt: new Date(),
});

describe('vacation rules', () => {
  it('should accept real dates only', () => {
    // Act + Assert
    expect(isDate('2026-02-28')).toBe(true);
    expect(isDate('2026-02-30')).toBe(false);
    expect(isDate('26-2-1')).toBe(false);
  });

  it('should refuse a start after the end', () => {
    // Act
    const act = () => validateRange({ startDate: '2026-02-02', endDate: '2026-02-01', timezone: 'UTC' });

    // Assert
    expect(act).toThrow('Invalid CreateVacationReq');
  });

  it('should count a window spanning New Year in its start year', () => {
    // Act
    const y = windowYear({ startDate: '2026-12-30', endDate: '2027-01-03', timezone: 'UTC' });

    // Assert
    expect(y).toBe(2026);
  });

  it('should end today, never extend, and refuse before the start', () => {
    // Act + Assert
    expect(endToday(v('2026-01-01', '2026-01-10'), '2026-01-05').endDate).toBe('2026-01-05');
    expect(endToday(v('2026-01-01', '2026-01-10'), '2026-01-20').endDate).toBe('2026-01-10');
    expect(() => endToday(v('2026-01-01', '2026-01-10'), '2025-12-31')).toThrow();
  });
});
