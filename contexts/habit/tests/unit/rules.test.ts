import { describe, expect, it } from 'bun:test';
import { createHabitReq, toVersionInput } from '../../src/api/v1/schemas';
import { canonicalDay, isTime, isTimezone, parseStakeCents } from '../../src/domain/rules';

describe('rules', () => {
  it('should accept a weekday name in any case', () => {
    expect(canonicalDay('friday')).toBe('Friday');
    expect(canonicalDay('MONDAY')).toBe('Monday');
  });
  it('should refuse numbers, lists and unknown names as days', () => {
    expect(canonicalDay('1')).toBeNull();
    expect(canonicalDay('Monday,Tuesday')).toBeNull();
    expect(canonicalDay('Funday')).toBeNull();
  });
  it('should parse stakes as whole cents', () => {
    expect(parseStakeCents('10.50')).toBe(1050);
    expect(parseStakeCents('10.500')).toBe(1050);
    expect(parseStakeCents('0')).toBe(0);
    expect(parseStakeCents('7')).toBe(700);
  });
  it('should refuse a negative, a 3-decimal or a non-number stake', () => {
    expect(parseStakeCents('-1')).toBeNull();
    expect(parseStakeCents('1.005')).toBeNull();
    expect(parseStakeCents('abc')).toBeNull();
    expect(parseStakeCents('')).toBeNull();
  });
  it('should validate times and timezones', () => {
    expect(isTime('07:30:00')).toBe(true);
    expect(isTime('7:30')).toBe(false);
    expect(isTime('24:00:00')).toBe(false);
    expect(isTimezone('Asia/Singapore')).toBe(true);
    expect(isTimezone('Mars/Base')).toBe(false);
  });
});

describe('createHabitReq', () => {
  const base = {
    task: 'Run',
    daysOfWeek: ['monday', 'MONDAY', 'Friday'],
    notificationTime: '07:00:00',
    stake: '0',
    timezone: 'Asia/Singapore',
  };
  const schema = createHabitReq(1_000_000);

  it('should map a valid request to a version with canonical, distinct days and the default deadline', () => {
    const parsed = schema.parse(base);
    const input = toVersionInput(parsed);
    expect(input.daysOfWeek).toEqual(['Monday', 'Friday']);
    expect(input.deadlineTime).toBe('23:59:00');
    expect(input.ratioBps).toBe(10_000);
    expect(input.charityId).toBeNull();
  });
  it('should need a charity for a money stake', () => {
    const r = schema.safeParse({ ...base, stake: '5.00' });
    expect(r.success).toBe(false);
  });
  it('should accept a stake with a charity and treat the empty guid as none', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(schema.safeParse({ ...base, stake: '5.00', charityId: id }).success).toBe(true);
    expect(
      schema.safeParse({ ...base, stake: '5.00', charityId: '00000000-0000-0000-0000-000000000000' }).success,
    ).toBe(false);
    expect(
      toVersionInput(schema.parse({ ...base, charityId: '00000000-0000-0000-0000-000000000000' })).charityId,
    ).toBeNull();
  });
  it('should refuse a stake above the configured maximum', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(schema.safeParse({ ...base, stake: '10000.01', charityId: id }).success).toBe(false);
    expect(schema.safeParse({ ...base, stake: '10000.00', charityId: id }).success).toBe(true);
  });
  it('should refuse a bad timezone, empty days and an empty task', () => {
    expect(schema.safeParse({ ...base, timezone: 'Nope/Nope' }).success).toBe(false);
    expect(schema.safeParse({ ...base, daysOfWeek: [] }).success).toBe(false);
    expect(schema.safeParse({ ...base, task: '' }).success).toBe(false);
  });
});
