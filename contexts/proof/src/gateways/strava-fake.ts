// The Strava gateway of this build: a fake with no network. Authorization codes of the form
// "athlete-<id>" grant that athlete; anything else is refused. Tests drive it through `fakeStrava`.
import type { Clock } from '@lazytax/kernel';
import type { StravaActivity, StravaApi, StravaGrant, StravaTokens } from '../domain/strava-model';

const HOUR = 3_600_000;

class FakeStravaApi implements StravaApi {
  readonly calls: string[] = [];
  // activity id -> activity; absent = deleted or invisible.
  readonly activities = new Map<number, StravaActivity>();
  // refresh tokens Strava no longer accepts (the user deauthorized).
  readonly revoked = new Set<string>();
  // Throw on getActivity (a Strava outage), so the inbox retries the event.
  failActivityFetch = false;
  // Delay before a refresh answers, to let tests overlap two refreshes.
  refreshDelayMs = 0;
  private seq = 0;

  constructor(private clock: Clock = { now: () => new Date() }) {}

  useClock(clock: Clock): void {
    this.clock = clock;
  }

  reset(): void {
    this.calls.length = 0;
    this.activities.clear();
    this.revoked.clear();
    this.failActivityFetch = false;
    this.refreshDelayMs = 0;
    this.seq = 0;
  }

  private tokens(expiresInMs = 6 * HOUR): StravaTokens {
    this.seq += 1;
    return {
      accessToken: `at-${this.seq}`,
      refreshToken: `rt-${this.seq}`,
      expiresAt: new Date(this.clock.now().getTime() + expiresInMs),
    };
  }

  async exchangeCode(code: string): Promise<StravaGrant> {
    this.calls.push(`exchange:${code}`);
    const m = /^athlete-(\d+)$/.exec(code);
    if (!m) throw new Error('Strava rejected the authorization code');
    return { athleteId: Number(m[1]), tokens: this.tokens() };
  }

  async refresh(refreshToken: string): Promise<StravaTokens | null> {
    this.calls.push(`refresh:${refreshToken}`);
    if (this.refreshDelayMs > 0) await new Promise(r => setTimeout(r, this.refreshDelayMs));
    if (this.revoked.has(refreshToken)) return null;
    // Strava invalidates the old refresh token as soon as it issues a new one.
    this.revoked.add(refreshToken);
    return this.tokens();
  }

  async getActivity(_accessToken: string, activityId: number): Promise<StravaActivity | null> {
    this.calls.push(`activity:${activityId}`);
    if (this.failActivityFetch) throw new Error('Strava is down');
    return this.activities.get(activityId) ?? null;
  }

  async revoke(token: string): Promise<void> {
    this.calls.push(`revoke:${token}`);
    this.revoked.add(token);
  }
}

// One per process: register.ts wires it, tests control it.
export const fakeStrava = new FakeStravaApi();
