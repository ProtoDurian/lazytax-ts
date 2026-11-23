// The proof context's integration harness: the whole app through startTestApp (real account,
// plan, habit and check), plus a few arrange helpers that go through those contexts' own routes.
import { type Actor, startTestApp, type TestApp } from '@lazytax/kernel/testing';

const ALL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// What check recorded for a proof (check's evidence row).
interface Report {
  userId: string;
  habitId: string;
  proofKey: string;
  externalId: string;
  verdict: 'passed' | 'failed';
  data: string | null;
}

export interface ProofApp extends TestApp {
  // A real habit of the actor, scheduled every day in UTC (configures the user on first use).
  habit(actor: Actor): Promise<string>;
  // Moves the actor to the pro tier (the admin tier route of plan).
  pro(actor: Actor): Promise<void>;
  // Completes today's check of the habit through check's route.
  complete(actor: Actor, habitId: string): Promise<void>;
  // Deletes the habit through habit's route (habit emits habit.deleted).
  deleteHabit(actor: Actor, habitId: string): Promise<void>;
  // Every evidence row check holds.
  reports(): Promise<Report[]>;
  // POSTs a raw body to the Strava webhook (the signature covers these exact bytes).
  postWebhook(body: string, headers: Record<string, string>): Promise<Response>;
}

export async function startProofApp(proofConfig: unknown = {}): Promise<ProofApp> {
  // 1 Mar 2026, a Sunday, noon UTC.
  const app = await startTestApp({ config: { proof: proofConfig }, now: '2026-03-01T12:00:00Z' });
  const configured = new Set<string>();
  const versions = new Map<string, string>();
  const ok = async (res: Response, what: string) => {
    if (res.status >= 300) throw new Error(`${what}: HTTP ${res.status} ${await res.text()}`);
    return res;
  };

  return {
    ...app,
    habit: async actor => {
      if (!configured.has(actor.sub)) {
        await ok(
          await app.request(actor, {
            method: 'POST',
            path: `/api/v1/Configuration/${actor.sub}`,
            body: { timezone: 'UTC' },
          }),
          'configure',
        );
        configured.add(actor.sub);
      }
      const res = await ok(
        await app.request(actor, {
          method: 'POST',
          path: `/api/v1/Habit/${actor.sub}`,
          body: { task: 'Run', daysOfWeek: ALL_DAYS, notificationTime: '07:00:00', stake: '0', timezone: 'UTC' },
        }),
        'create habit',
      );
      const v = (await res.json()) as { id: string; habitId: string };
      versions.set(v.habitId, v.id);
      return v.habitId;
    },
    pro: async actor => {
      const admin = await app.admin();
      await ok(
        await app.request(admin, {
          method: 'PUT',
          path: `/api/v1/Subscription/${actor.sub}/tier`,
          body: { tier: 'pro' },
        }),
        'set tier',
      );
    },
    complete: async (actor, habitId) => {
      await ok(
        await app.request(actor, {
          method: 'POST',
          path: `/api/v1/Habit/${actor.sub}/${versions.get(habitId)}/executions`,
          body: { notes: null },
        }),
        'complete',
      );
    },
    deleteHabit: async (actor, habitId) => {
      await ok(
        await app.request(actor, { method: 'DELETE', path: `/api/v1/Habit/${actor.sub}/${habitId}` }),
        'delete habit',
      );
    },
    reports: async () =>
      (
        (await app.sql`
          SELECT user_id, habit_id::text AS habit_id, proof_key, external_id, passed, data
          FROM "check".evidence ORDER BY received_at`) as {
          user_id: string;
          habit_id: string;
          proof_key: string;
          external_id: string;
          passed: boolean;
          data: string | null;
        }[]
      ).map(r => ({
        userId: r.user_id,
        habitId: r.habit_id,
        proofKey: r.proof_key,
        externalId: r.external_id,
        verdict: r.passed ? 'passed' : 'failed',
        data: r.data,
      })),
    postWebhook: (body, headers) =>
      app.request(null, { method: 'POST', path: '/api/v1/Strava/webhook', body: JSON.parse(body), headers }),
  };
}

// Links the actor's Strava through the real connect flow (connect-url, then the callback).
export async function connectStrava(app: ProofApp, actor: Actor, athleteId: number): Promise<void> {
  const res0 = await app.request(actor, { method: 'GET', path: `/api/v1/Strava/connect-url/${actor.sub}` });
  const { url } = (await res0.json()) as { url: string };
  const state = new URL(url).searchParams.get('state') ?? '';
  const res = await app.request(null, {
    method: 'GET',
    path: '/api/v1/Strava/callback',
    query: { code: `athlete-${athleteId}`, scope: 'read,activity:read_all', state },
  });
  const where = res.headers.get('location') ?? '';
  if (!where.includes('result=connected')) throw new Error(`strava connect failed: ${res.status} ${where}`);
}
