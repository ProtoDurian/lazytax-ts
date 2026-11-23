import { describe, expect, it } from 'bun:test';
import {
  addDays,
  fromStandardDate,
  isScheduledOn,
  localDate,
  localToUtc,
  monthBounds,
  resolveTimezone,
  toStandardDate,
  weekBounds,
  windowFor,
} from '../../src/domain/window';

describe('window', () => {
  it('should give the user-local date of an instant', () => {
    // Arrange
    const at = new Date('2026-03-01T16:30:00Z');
    // Act
    const sg = localDate(at, 'Asia/Singapore');
    const utc = localDate(at, 'UTC');
    // Assert
    expect(sg).toBe('2026-03-02');
    expect(utc).toBe('2026-03-01');
  });

  it('should open at local midnight and end after the deadline minute', () => {
    // Act
    const w = windowFor('2026-03-02', 'Asia/Singapore', '23:59:00');
    // Assert
    expect(w.opensAt.toISOString()).toBe('2026-03-01T16:00:00.000Z');
    expect(w.deadline.toISOString()).toBe('2026-03-02T16:00:00.000Z');
  });

  it('should move a local time inside a DST gap forward', () => {
    // Act: 02:30 does not exist in New York on 8 Mar 2026
    const t = localToUtc('2026-03-08', '02:30', 'America/New_York');
    // Assert: 03:00 EDT
    expect(t.toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  it('should keep the deadline after the opening even for a 00:00 deadline', () => {
    // Act
    const w = windowFor('2026-03-02', 'UTC', '00:00:00');
    // Assert
    expect(w.deadline.getTime() - w.opensAt.getTime()).toBe(60_000);
  });

  it('should fall back to UTC for an unknown zone', () => {
    // Act & Assert
    expect(resolveTimezone('Mars/Olympus')).toBe('UTC');
    expect(resolveTimezone(null)).toBe('UTC');
    expect(resolveTimezone('Europe/London')).toBe('Europe/London');
  });

  it('should compute weeks from Sunday and whole months', () => {
    // Act & Assert
    expect(weekBounds('2026-03-04')).toEqual({ start: '2026-03-01', end: '2026-03-07' });
    expect(monthBounds('2026-02-14')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('should match weekdays case-insensitively', () => {
    // Act & Assert
    expect(isScheduledOn(['monday'], '2026-03-02')).toBe(true);
    expect(isScheduledOn(['Tuesday'], '2026-03-02')).toBe(false);
  });

  it('should convert LazyTax dd-MM-yyyy dates both ways', () => {
    // Act & Assert
    expect(toStandardDate('2026-03-02')).toBe('02-03-2026');
    expect(fromStandardDate('02-03-2026')).toBe('2026-03-02');
    expect(fromStandardDate('31-02-2026')).toBeNull();
    expect(fromStandardDate('2026-03-02')).toBeNull();
  });
});
