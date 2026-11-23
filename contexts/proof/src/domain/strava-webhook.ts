import type { StravaWebhookEvent } from './strava-model';

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

// null for a malformed event or another subscription's (subscriptionId 0 skips that check).
export function parseWebhookEvent(body: unknown, subscriptionId: number): StravaWebhookEvent | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const { object_type: type, aspect_type: aspect, object_id: oid, owner_id: owner, event_time: at } = b;
  if (type !== 'activity' && type !== 'athlete') return null;
  if (aspect !== 'create' && aspect !== 'update' && aspect !== 'delete') return null;
  if (!isInt(oid) || !isInt(owner) || !isInt(at) || at < 0 || at > 8_640_000_000_000) return null;
  if (subscriptionId !== 0 && b.subscription_id !== subscriptionId) return null;

  const updates = b.updates;
  const authorized =
    updates !== null && typeof updates === 'object' && (updates as Record<string, unknown>).authorized;
  return {
    objectType: type,
    aspectType: aspect,
    objectId: oid,
    ownerId: owner,
    eventTime: new Date(at * 1000),
    deauthorized: type === 'athlete' && authorized === 'false',
  };
}
