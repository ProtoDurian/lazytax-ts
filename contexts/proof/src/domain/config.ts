import { z } from '@lazytax/kernel';

// Override with env LAZYTAX_PROOF_CONFIG='{"strava":{"enabled":true}}'. The secrets below are
// development defaults: a real deployment sets its own.
export const ProofConfig = z.object({
  strava: z
    .object({
      // Off: the strava plugin isn't offered, its endpoints return 404 and its worker doesn't run.
      enabled: z.boolean().default(false),
      clientId: z.string().default('lazytax-dev-client'),
      // Also signs the connect flow's state.
      clientSecret: z.string().default('lazytax-dev-strava-client-secret'),
      // Our own token, echoed by Strava when the webhook subscription is created.
      verifyToken: z.string().default('lazytax-dev-verify-token'),
      // Signs every webhook delivery (HMAC-SHA256, see docs/README.md).
      webhookSecret: z.string().default('lazytax-dev-webhook-secret'),
      // A delivery whose timestamp is further than this from now is refused.
      webhookToleranceSec: z.number().int().positive().default(300),
      // Encrypts the stored tokens (AES-256-GCM).
      encryptionKey: z.string().default('lazytax-dev-token-encryption-key'),
      // The subscription id Strava returned; events with another id are ignored. 0 = not checked.
      subscriptionId: z.number().int().min(0).default(0),
      callbackUrl: z.string().default('http://127.0.0.1:9300/api/v1/Strava/callback'),
      // The app's deep link the callback redirects to, with ?result=...
      appRedirectUri: z.string().default('lazytax://strava'),
      maxAttempts: z.number().int().min(1).default(5),
      // How often the worker drains the inbox. Runs are usually synced within a minute of
      // finishing; 20 s keeps the habit feeling instant.
      pollMs: z.number().int().positive().default(20_000),
      stateLifetimeMinutes: z.number().int().positive().default(15),
    })
    .prefault({}),
});

export type ProofConfigT = z.output<typeof ProofConfig>;
