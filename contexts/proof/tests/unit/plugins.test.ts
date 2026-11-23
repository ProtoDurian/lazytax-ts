import { describe, expect, it } from 'bun:test';
import { Problem } from '@lazytax/kernel';
import type { ProofBinding, ProofEvent, ProofWindow } from '../../src/domain/model';
import { manualPlugin } from '../../src/plugins/manual';
import { nfcPlugin } from '../../src/plugins/nfc';
import { stravaPlugin } from '../../src/plugins/strava';

const window: ProofWindow = {
  localDate: '2026-03-01',
  timezone: 'UTC',
  opensAt: new Date('2026-03-01T00:00:00Z'),
  deadline: new Date('2026-03-01T23:59:00Z'),
};
const event = (over: Partial<ProofEvent> = {}): ProofEvent => ({
  pluginKey: 'strava',
  userId: 'u1',
  externalId: '1',
  occurredAt: new Date('2026-03-01T10:00:00Z'),
  ...over,
});
const binding = (settings: string): ProofBinding => ({
  id: 'b1',
  habitId: 'h1',
  userId: 'u1',
  pluginKey: 'strava',
  pluginVersion: 1,
  settings,
});
const strava = stravaPlugin({ isConnected: async () => true });

const errorsOf = (fn: () => unknown): Record<string, string[]> => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Problem);
    return (e as Problem).data.errors as Record<string, string[]>;
  }
  throw new Error('expected a validation problem');
};

describe('manual plugin', () => {
  it('should always pass and be always-bound', async () => {
    // Act
    const verdict = await manualPlugin.evaluate(null, event({ pluginKey: 'manual' }), window);
    // Assert
    expect(verdict).toEqual({ verdict: 'passed' });
    expect(manualPlugin.manifest.alwaysBound).toBe(true);
  });
});

describe('strava plugin settings', () => {
  it('should normalize valid settings', () => {
    expect(strava.validateSettings('{ "sportTypes": ["Run", "Ride"] }')).toBe('{"sportTypes":["Run","Ride"]}');
  });

  it('should reject an unknown field so a typo does not silently do nothing', () => {
    expect(Object.keys(errorsOf(() => strava.validateSettings('{"sportTypes":["Run"],"sportTypez":[]}')))).toHaveLength(
      1,
    );
  });

  it('should reject empty and unknown sport types', () => {
    expect(errorsOf(() => strava.validateSettings('{"sportTypes":[]}')).sportTypes).toEqual([
      'Pick at least one sport type',
    ]);
    expect(errorsOf(() => strava.validateSettings('{"sportTypes":["Flying"]}')).sportTypes?.[0]).toContain('Flying');
  });

  it('should reject text that is not a JSON object', () => {
    expect(errorsOf(() => strava.validateSettings('nope')).settings).toBeDefined();
    expect(errorsOf(() => strava.validateSettings('[1]')).settings).toEqual(['Settings must be a JSON object']);
  });

  it('should refuse to bind when Strava is not connected', async () => {
    // Arrange
    const none = stravaPlugin({ isConnected: async () => false });
    // Act / Assert
    await expect(none.onBind(binding('{"sportTypes":["Run"]}'))).rejects.toBeInstanceOf(Problem);
  });
});

describe('strava plugin evaluation', () => {
  const run = binding('{"sportTypes":["Run"]}');

  it('should pass a recorded activity of a bound sport type', async () => {
    const v = await strava.evaluate(run, event({ payload: { sportType: 'Run', manual: false } }), window);
    expect(v).toEqual({ verdict: 'passed' });
  });

  it('should say nothing for another sport type', async () => {
    expect(await strava.evaluate(run, event({ payload: { sportType: 'Swim', manual: false } }), window)).toBeNull();
  });

  it('should never count an activity typed in by hand', async () => {
    expect(await strava.evaluate(run, event({ payload: { sportType: 'Run', manual: true } }), window)).toBeNull();
  });

  it('should ignore payload fields it does not model', async () => {
    const v = await strava.evaluate(run, event({ payload: { sportType: 'Run', startDate: 'x', extra: 1 } }), window);
    expect(v).toEqual({ verdict: 'passed' });
  });
});

describe('nfc plugin', () => {
  const nfc = nfcPlugin({ isLinked: async (u, t, h) => u === 'u1' && t === 'tag-12345' && h === 'h1' });

  it('should pass a tap on a tag linked to the habit', async () => {
    const e = event({ pluginKey: 'nfc', habitId: 'h1', payload: { tagId: 'tag-12345' } });
    expect(await nfc.evaluate(null, e, window)).toEqual({ verdict: 'passed' });
  });

  it('should say nothing for a tag that is not linked, or an event without a habit', async () => {
    expect(await nfc.evaluate(null, event({ habitId: 'h2', payload: { tagId: 'tag-12345' } }), window)).toBeNull();
    expect(await nfc.evaluate(null, event({ payload: { tagId: 'tag-12345' } }), window)).toBeNull();
  });
});
