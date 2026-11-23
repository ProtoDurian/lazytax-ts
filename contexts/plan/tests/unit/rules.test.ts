import { describe, expect, it } from 'bun:test';
import { PlanConfig, type Subscription } from '../../src/domain/model';
import { effective, freezeMax } from '../../src/domain/rules';

const cfg = PlanConfig.parse({});
const sub = (over: Partial<Subscription> = {}): Subscription => ({
  id: 's',
  userId: 'u',
  tier: 'pro',
  status: 'active',
  periodStart: new Date('2026-01-01T00:00:00Z'),
  periodEnd: new Date('2026-02-01T00:00:00Z'),
  cancelAtPeriodEnd: false,
  nextTier: null,
  ...over,
});

describe('effective subscription', () => {
  it('should keep a lapsed period during the grace window', () => {
    // Act
    const r = effective(sub(), cfg, new Date('2026-02-05T00:00:00Z'));

    // Assert
    expect(r?.tier).toBe('pro');
  });

  it('should drop it after the grace window or when cancelled at period end', () => {
    // Act
    const late = effective(sub(), cfg, new Date('2026-02-09T00:00:00Z'));
    const cancelled = effective(sub({ cancelAtPeriodEnd: true }), cfg, new Date('2026-02-02T00:00:00Z'));

    // Assert
    expect(late).toBeNull();
    expect(cancelled).toBeNull();
  });
});

describe('freeze cap', () => {
  it('should add streak bonuses only when the tier has a base', () => {
    // Act + Assert
    expect(freezeMax(0, 500)).toBe(0);
    expect(freezeMax(14, 29)).toBe(14);
    expect(freezeMax(14, 80)).toBe(16);
    expect(freezeMax(14, 300)).toBe(18);
  });
});
