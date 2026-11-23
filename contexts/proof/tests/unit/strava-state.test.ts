import { describe, expect, it } from 'bun:test';
import { createEncryptor } from '../../src/domain/crypto';
import { signState, signWebhook, verifyState, verifyWebhook } from '../../src/domain/strava-state';
import { parseWebhookEvent } from '../../src/domain/strava-webhook';

const KEY = 'secret';
const NOW = new Date('2026-03-01T12:00:00Z');
const ts = Math.floor(NOW.getTime() / 1000);

describe('connect state', () => {
  it('should round trip the user id', () => {
    const s = signState('user:1', new Date(NOW.getTime() + 60_000), KEY);
    expect(verifyState(s, NOW, KEY)).toBe('user:1');
  });

  it('should refuse a forged, tampered, malformed or expired state', () => {
    const s = signState('u1', new Date(NOW.getTime() + 60_000), KEY);
    expect(verifyState(s, NOW, 'other')).toBeNull();
    expect(verifyState(`${s}x`, NOW, KEY)).toBeNull();
    expect(verifyState('nodot', NOW, KEY)).toBeNull();
    expect(verifyState(undefined, NOW, KEY)).toBeNull();
    expect(verifyState(s, new Date(NOW.getTime() + 120_000), KEY)).toBeNull();
  });
});

describe('webhook signature', () => {
  const body = '{"object_id":77}';
  const sig = signWebhook(KEY, ts, body);

  it('should accept a fresh, correctly signed body', () => {
    expect(verifyWebhook(KEY, ts, sig, body, NOW, 300)).toBe('ok');
  });

  it('should refuse a wrong secret, a changed byte and a changed timestamp', () => {
    expect(verifyWebhook('x', ts, sig, body, NOW, 300)).toBe('bad_signature');
    expect(verifyWebhook(KEY, ts, sig, '{"object_id":78}', NOW, 300)).toBe('bad_signature');
    expect(verifyWebhook(KEY, ts + 1, sig, body, NOW, 300)).toBe('bad_signature');
    expect(verifyWebhook(KEY, ts, 'short', body, NOW, 300)).toBe('bad_signature');
  });

  it('should refuse a validly signed body that is too old or from the future', () => {
    const old = ts - 301;
    expect(verifyWebhook(KEY, old, signWebhook(KEY, old, body), body, NOW, 300)).toBe('stale');
    const future = ts + 301;
    expect(verifyWebhook(KEY, future, signWebhook(KEY, future, body), body, NOW, 300)).toBe('stale');
  });
});

describe('webhook parser', () => {
  const body = {
    object_type: 'activity',
    aspect_type: 'create',
    object_id: 77,
    owner_id: 5,
    event_time: 1_772_366_340,
  };

  it('should parse a well-formed event', () => {
    expect(parseWebhookEvent(body, 0)).toMatchObject({
      objectType: 'activity',
      objectId: 77,
      ownerId: 5,
      deauthorized: false,
    });
  });

  it('should mark an athlete update with authorized=false as a deauthorization', () => {
    const e = parseWebhookEvent({ ...body, object_type: 'athlete', updates: { authorized: 'false' } }, 0);
    expect(e?.deauthorized).toBe(true);
  });

  it('should refuse malformed bodies, string numbers and another subscription', () => {
    expect(parseWebhookEvent(null, 0)).toBeNull();
    expect(parseWebhookEvent({ ...body, object_id: '77' }, 0)).toBeNull();
    expect(parseWebhookEvent({ ...body, object_type: 'club' }, 0)).toBeNull();
    expect(parseWebhookEvent({ ...body, aspect_type: 'remove' }, 0)).toBeNull();
    expect(parseWebhookEvent({ ...body, subscription_id: 9 }, 10)).toBeNull();
    expect(parseWebhookEvent({ ...body, subscription_id: 10 }, 10)).not.toBeNull();
  });
});

describe('token encryption', () => {
  it('should round trip, and not repeat a ciphertext', () => {
    const enc = createEncryptor('k');
    const a = enc.encrypt('tok');
    expect(enc.decrypt(a)).toBe('tok');
    expect(enc.encrypt('tok')).not.toBe(a);
    expect(a).not.toContain('tok');
  });

  it('should refuse a value sealed with another key', () => {
    expect(() => createEncryptor('b').decrypt(createEncryptor('a').encrypt('tok'))).toThrow();
  });
});
