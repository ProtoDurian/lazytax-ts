// LazyTax Domain/Strava/Model.cs.
export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface StravaConnection {
  id: string;
  userId: string;
  athleteId: number;
  tokens: StravaTokens;
  scope: string;
  connectedAt: Date;
}

// What Strava returns for an authorization code.
export interface StravaGrant {
  athleteId: number;
  tokens: StravaTokens;
}

// The only activity fields we read. Strava's terms allow showing Strava data only to its owner
// and caching it for at most 7 days, so this lives in memory and is never stored.
export interface StravaActivity {
  sportType: string;
  startDate: string;
  manual: boolean;
}

// A webhook event as Strava sends it: IDs only.
export interface StravaWebhookEvent {
  objectType: 'activity' | 'athlete';
  aspectType: 'create' | 'update' | 'delete';
  objectId: number;
  ownerId: number;
  eventTime: Date;
  // athlete update with updates.authorized = "false": the user removed LazyTax in Strava.
  deauthorized: boolean;
}

export interface StravaInboxItem {
  id: string;
  attempts: number;
  event: StravaWebhookEvent;
}

export type StravaConnectOutcome = 'connected' | 'scope_missing' | 'athlete_taken';

// read_all so runs set to "Only You" count too (decided 2026-11-11).
export const STRAVA_REQUIRED_SCOPE = 'activity:read_all';

// Strava's HTTP API. Only a fake implements it in this build: no network.
export interface StravaApi {
  exchangeCode(code: string): Promise<StravaGrant>;
  // null when Strava rejects the refresh token (the user deauthorized LazyTax).
  refresh(refreshToken: string): Promise<StravaTokens | null>;
  // null when the activity doesn't exist (deleted) or the token can't see it.
  getActivity(accessToken: string, activityId: number): Promise<StravaActivity | null>;
  revoke(token: string): Promise<void>;
}
