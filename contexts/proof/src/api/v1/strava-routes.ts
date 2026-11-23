import { type Clock, type Logger, notFound, Owner, route, unauthorized, z } from '@lazytax/kernel';
import type { StravaConnectionRepository, StravaInboxRepository } from '../../data/strava-repository';
import type { ProofConfigT } from '../../domain/config';
import { STRAVA_REQUIRED_SCOPE } from '../../domain/strava-model';
import type { StravaService } from '../../domain/strava-service';
import { signState, verifyState, verifyWebhook } from '../../domain/strava-state';
import { parseWebhookEvent } from '../../domain/strava-webhook';

// "read" is Strava's default profile scope; activity:read_all also sees "Only You" activities.
const REQUESTED_SCOPE = `read,${STRAVA_REQUIRED_SCOPE}`;

const CallbackQuery = z.object({
  code: z.string().optional(),
  scope: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

const ChallengeQuery = z.object({
  'hub.mode': z.string().optional(),
  'hub.verify_token': z.string().optional(),
  'hub.challenge': z.string().optional(),
});

export interface StravaRoutesDeps {
  service: StravaService;
  inbox: StravaInboxRepository;
  connections: StravaConnectionRepository;
  config: () => ProofConfigT['strava'];
  clock: Clock;
  log: Logger;
}

export const stravaRoutes = ({ service, inbox, config, clock, log }: StravaRoutesDeps) => {
  // Off: the strava proof plugin isn't offered and the endpoints return 404.
  const enabled = () => {
    if (!config().enabled) throw notFound('Strava', '');
    return config();
  };
  const toApp = (result: string): Response => {
    const url = new URL(config().appRedirectUri);
    url.searchParams.set('result', result);
    return new Response(null, { status: 302, headers: { Location: url.toString() } });
  };

  return [
    // The Strava authorize URLs to open: appUrl in the Strava app when installed, else url in an
    // in-app browser. Both come back to /callback, which redirects to the app's deep link.
    route.get('/Strava/connect-url/:userId', {
      policy: 'registered',
      subject: 'userId',
      handler: ({ params }) => {
        const c = enabled();
        const expires = new Date(clock.now().getTime() + c.stateLifetimeMinutes * 60_000);
        const query = new URLSearchParams({
          client_id: c.clientId,
          redirect_uri: c.callbackUrl,
          response_type: 'code',
          approval_prompt: 'auto',
          scope: REQUESTED_SCOPE,
          state: signState(params.userId, expires, c.clientSecret),
        }).toString();
        return {
          url: `https://www.strava.com/oauth/mobile/authorize?${query}`,
          appUrl: `strava://oauth/mobile/authorize?${query}`,
        };
      },
    }),
    // Strava redirects here after the user approves or cancels. Always ends at the app's deep link
    // with ?result=connected|denied|scope_missing|athlete_taken|expired|error.
    route.get('/Strava/callback', {
      policy: 'public',
      query: CallbackQuery,
      handler: async ({ query }) => {
        const c = enabled();
        const userId = verifyState(query.state, clock.now(), c.clientSecret);
        if (userId === null) return toApp('expired');
        if (query.error !== undefined || query.code === undefined) return toApp('denied');
        try {
          return toApp(await service.connect(userId, query.code, query.scope ?? ''));
        } catch (err) {
          log.error('Strava connect failed', { userId, error: String(err) });
          return toApp('error');
        }
      },
    }),
    // Strava's subscription check: echo hub.challenge when the verify token matches.
    route.get('/Strava/webhook', {
      policy: 'public',
      query: ChallengeQuery,
      handler: ({ query }) => {
        const c = enabled();
        const challenge = query['hub.challenge'];
        if (query['hub.mode'] !== 'subscribe' || challenge === undefined || query['hub.verify_token'] !== c.verifyToken)
          throw unauthorized();
        return { 'hub.challenge': challenge };
      },
    }),
    // Must answer within 2 seconds: queue the event and let the worker fetch the activity. A
    // delivery must carry a fresh signature (constant-time compare); the worker only trusts what it
    // fetches with the owner's own token.
    route.post('/Strava/webhook', {
      policy: 'public',
      handler: async ({ headers, rawBody }) => {
        const c = enabled();
        const ts = Number(headers.get('x-lazytax-timestamp'));
        const sig = headers.get('x-lazytax-signature');
        if (!Number.isInteger(ts) || !sig) throw unauthorized('Missing webhook signature');
        const checked = verifyWebhook(c.webhookSecret, ts, sig, rawBody, clock.now(), c.webhookToleranceSec);
        if (checked !== 'ok') {
          log.warn('Refusing Strava webhook', { reason: checked });
          throw unauthorized('Invalid webhook signature');
        }
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          // falls through to the unreadable case
        }
        const event = parseWebhookEvent(parsed, c.subscriptionId);
        if (!event) {
          // The endpoint is public, so the body is never logged.
          log.warn('Ignoring Strava webhook event: unreadable');
          return new Response(null, { status: 200 });
        }
        await inbox.enqueue(event);
        // LazyTax answers 200 with an empty body, and Strava expects exactly that.
        return new Response(null, { status: 200 });
      },
    }),
    route.get('/Strava/:userId', {
      policy: 'registered',
      subject: 'userId',
      handler: async ({ params }) => {
        enabled();
        const conn = await service.get(Owner.user(params.userId));
        return { connected: conn !== null, connectedAtUtc: conn?.connectedAt.toISOString() ?? null };
      },
    }),
    // Revokes LazyTax in Strava and deletes the user's Strava data; their Strava habits go back to
    // manual check-in. Checks already done stay done.
    route.delete('/Strava/:userId', {
      policy: 'registered',
      subject: 'userId',
      handler: async ({ params }) => {
        enabled();
        if (!(await service.disconnect(Owner.user(params.userId)))) throw notFound('Strava Connection', params.userId);
      },
    }),
  ];
};
