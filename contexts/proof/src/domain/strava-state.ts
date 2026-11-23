// The OAuth state for the connect flow, and the webhook signature. Both are HMAC-SHA256 and are
// compared in constant time. (LazyTax App/Modules/Strava/StravaState.cs; the webhook signature is new.)
import { createHmac, timingSafeEqual } from 'node:crypto';

const mac = (key: string, body: string): string => createHmac('sha256', key).update(body).digest('base64url');

// Constant time on equal-length input; a length difference is not secret.
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signState(userId: string, expiresAt: Date, key: string): string {
  const payload = `${Math.floor(expiresAt.getTime() / 1000)}:${userId}`;
  const body = Buffer.from(payload).toString('base64url');
  return `${body}.${mac(key, body)}`;
}

// The user id, or null when the state is forged, malformed or expired.
export function verifyState(state: string | undefined, now: Date, key: string): string | null {
  const parts = state?.split('.');
  if (parts?.length !== 2) return null;
  const [body, tag] = parts as [string, string];
  if (!safeEqual(mac(key, body), tag)) return null;
  const payload = Buffer.from(body, 'base64url').toString('utf8');
  const sep = payload.indexOf(':');
  if (sep <= 0) return null;
  const expires = Number(payload.slice(0, sep));
  if (!Number.isInteger(expires) || expires * 1000 < now.getTime()) return null;
  const userId = payload.slice(sep + 1);
  return userId.length === 0 ? null : userId;
}

// A delivery carries X-Lazytax-Timestamp (unix seconds) and X-Lazytax-Signature (hex HMAC-SHA256 of
// "<timestamp>.<raw body>"), so the signature covers the exact bytes received.
export const signWebhook = (secret: string, ts: number, rawBody: string): string =>
  createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');

export type WebhookCheck = 'ok' | 'bad_signature' | 'stale';

// Checks the signature first (constant time), then the timestamp's freshness, so a replayed event
// older than the tolerance (or from the future) is refused even with a valid signature.
export function verifyWebhook(
  secret: string,
  ts: number,
  sig: string,
  rawBody: string,
  now: Date,
  toleranceSec: number,
): WebhookCheck {
  if (!safeEqual(signWebhook(secret, ts, rawBody), sig)) return 'bad_signature';
  return Math.abs(now.getTime() / 1000 - ts) > toleranceSec ? 'stale' : 'ok';
}
