// Airwallex webhook signature (LazyTax AirwallexHmacCalculator + AirwallexWebhookService).
// HMAC-SHA256(secret, x-timestamp + raw body), lower-case hex, compared in constant time, and the
// timestamp must be fresh. LazyTax compared with `==` and had no freshness check.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Problem, z } from '@lazytax/kernel';

const signatureInvalid = (detail: string) =>
  new Problem({ kind: 'unauthorized', id: 'webhook_signature_invalid', title: 'Unauthorized', detail });

export function computeSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret)
    .update(timestamp + rawBody)
    .digest('hex');
}

export function verifySignature(opts: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  now: Date;
  toleranceSec: number;
}): void {
  const { timestamp, signature } = opts;
  if (!timestamp || !signature) throw signatureInvalid('Missing x-timestamp or x-signature');
  // Airwallex sends milliseconds since the epoch.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) throw signatureInvalid('Bad x-timestamp');
  if (Math.abs(opts.now.getTime() - ts) > opts.toleranceSec * 1000) throw signatureInvalid('Stale x-timestamp');
  const expected = Buffer.from(computeSignature(opts.secret, timestamp, opts.rawBody), 'utf8');
  const given = Buffer.from(signature.toLowerCase(), 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    throw signatureInvalid('Incorrect Signature');
}

// The fields of LazyTax's AirwallexEvent the service reads; everything else is ignored.
export const AirwallexEvent = z.object({
  id: z.string().default(''),
  name: z.string(),
  data: z
    .object({
      object: z
        .object({
          id: z.string().default(''),
          status: z.string().default(''),
          customer_id: z.string().default(''),
          merchant_trigger_reason: z.string().nullish(),
          merchant_order_id: z.string().default(''),
        })
        .passthrough(),
    })
    .passthrough(),
});

export type AirwallexEvent = z.output<typeof AirwallexEvent>;
