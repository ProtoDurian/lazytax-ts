import { conflict, type Owner, ownerFilter, type UnitOfWork } from '@lazytax/kernel';
import type { Encryptor } from '../domain/crypto';
import type { StravaConnection, StravaInboxItem, StravaTokens, StravaWebhookEvent } from '../domain/strava-model';
import { ownerUserId } from './binding-repository';

interface Row {
  id: string;
  user_id: string;
  athlete_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: Date;
  scope: string;
  connected_at: Date;
}

const COLUMNS =
  'id, user_id, athlete_id::text AS athlete_id, access_token, refresh_token, expires_at, scope, connected_at';

export class StravaConnectionRepository {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly enc: Encryptor,
  ) {}

  private toConnection(r: Row): StravaConnection {
    return {
      id: r.id,
      userId: r.user_id,
      athleteId: Number(r.athlete_id),
      tokens: {
        accessToken: this.enc.decrypt(r.access_token),
        refreshToken: this.enc.decrypt(r.refresh_token),
        expiresAt: r.expires_at,
      },
      scope: r.scope,
      connectedAt: r.connected_at,
    };
  }

  async get(owner: Owner): Promise<StravaConnection | null> {
    const db = this.uow.db();
    const rows = await db<Row[]>`
      SELECT ${db.unsafe(COLUMNS)} FROM proof.strava_connections c WHERE true ${ownerFilter(db, owner, 'c.user_id')}`;
    return rows[0] ? this.toConnection(rows[0]) : null;
  }

  // A webhook names a Strava athlete, not a user, so this is a system read.
  async getByAthlete(owner: Owner, athleteId: number): Promise<StravaConnection | null> {
    const db = this.uow.db();
    const rows = await db<Row[]>`
      SELECT ${db.unsafe(COLUMNS)} FROM proof.strava_connections c
      WHERE c.athlete_id = ${athleteId} ${ownerFilter(db, owner, 'c.user_id')}`;
    return rows[0] ? this.toConnection(rows[0]) : null;
  }

  // Links (or relinks) the user's Strava. 409 when the athlete is linked to another user.
  async upsert(owner: Owner, athleteId: number, tokens: StravaTokens, scope: string): Promise<void> {
    const userId = ownerUserId(owner);
    try {
      await this.uow.db()`
        INSERT INTO proof.strava_connections (user_id, athlete_id, access_token, refresh_token, expires_at, scope)
        VALUES (${userId}, ${athleteId}, ${this.enc.encrypt(tokens.accessToken)},
                ${this.enc.encrypt(tokens.refreshToken)}, ${tokens.expiresAt}, ${scope})
        ON CONFLICT (user_id) DO UPDATE SET
          athlete_id = EXCLUDED.athlete_id, access_token = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token, expires_at = EXCLUDED.expires_at, scope = EXCLUDED.scope,
          refresh_lease_until = NULL, updated_at = now()`;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('strava_athlete_taken', 'That Strava account is linked to another user');
      throw e;
    }
  }

  // Takes the refresh lease: null when the user is not connected or another worker holds it. The
  // refresh token is single use, so only the lease holder may spend it. HTTP never runs inside a
  // transaction, so this is a short claim, not the row lock LazyTax held across the HTTP call.
  async claimRefresh(owner: Owner, now: Date, leaseMs: number): Promise<StravaConnection | null> {
    const db = this.uow.db();
    const until = new Date(now.getTime() + leaseMs);
    const rows = await db<Row[]>`
      UPDATE proof.strava_connections c SET refresh_lease_until = ${until}
      WHERE (c.refresh_lease_until IS NULL OR c.refresh_lease_until < ${now}) ${ownerFilter(db, owner, 'c.user_id')}
      RETURNING ${db.unsafe(COLUMNS)}`;
    return rows[0] ? this.toConnection(rows[0]) : null;
  }

  // Saves the refreshed tokens and gives the lease back. false when the connection is gone.
  async saveTokens(owner: Owner, tokens: StravaTokens): Promise<boolean> {
    const db = this.uow.db();
    const rows = await db<{ id: string }[]>`
      UPDATE proof.strava_connections c SET access_token = ${this.enc.encrypt(tokens.accessToken)},
        refresh_token = ${this.enc.encrypt(tokens.refreshToken)}, expires_at = ${tokens.expiresAt},
        refresh_lease_until = NULL, updated_at = now()
      WHERE true ${ownerFilter(db, owner, 'c.user_id')} RETURNING id`;
    return rows.length > 0;
  }

  async releaseRefresh(owner: Owner): Promise<void> {
    const db = this.uow.db();
    await db`UPDATE proof.strava_connections c SET refresh_lease_until = NULL
             WHERE true ${ownerFilter(db, owner, 'c.user_id')}`;
  }

  // Deletes the connection (and the events still queued for its athlete). false when not connected.
  async delete(owner: Owner): Promise<boolean> {
    const db = this.uow.db();
    await db`DELETE FROM proof.strava_events e USING proof.strava_connections c
             WHERE e.owner_id = c.athlete_id ${ownerFilter(db, owner, 'c.user_id')}`;
    const rows = await db<{ id: string }[]>`
      DELETE FROM proof.strava_connections c WHERE true ${ownerFilter(db, owner, 'c.user_id')} RETURNING id`;
    return rows.length > 0;
  }

  async purgeUser(userId: string): Promise<void> {
    const db = this.uow.db();
    await db`DELETE FROM proof.strava_events WHERE owner_id IN
             (SELECT athlete_id FROM proof.strava_connections WHERE user_id = ${userId})`;
    await db`DELETE FROM proof.strava_connections WHERE user_id = ${userId}`;
  }
}

interface EventRow {
  id: string;
  attempts: number;
  object_type: 'activity' | 'athlete';
  aspect_type: 'create' | 'update' | 'delete';
  object_id: string;
  owner_id: string;
  event_time: Date;
  deauthorized: boolean;
}

// The webhook inbox. Events carry no user, only a Strava athlete, so it takes no owner.
export class StravaInboxRepository {
  constructor(private readonly uow: UnitOfWork) {}

  // owner-exempt: a system queue; webhook events carry a Strava athlete, never a user.
  async enqueue(e: StravaWebhookEvent): Promise<void> {
    await this.uow.db()`
      INSERT INTO proof.strava_events (object_type, aspect_type, object_id, owner_id, event_time, deauthorized)
      VALUES (${e.objectType}, ${e.aspectType}, ${e.objectId}, ${e.ownerId}, ${e.eventTime}, ${e.deauthorized})`;
  }

  // Claims up to batchSize events (oldest first) for the lease; an unfinished claim is retried once
  // its lease runs out. SKIP LOCKED hands each row to one worker across replicas.
  // owner-exempt: the worker claims across all users (a system queue).
  async claim(now: Date, batchSize: number, leaseMs: number): Promise<StravaInboxItem[]> {
    const until = new Date(now.getTime() + leaseMs);
    const rows = await this.uow.db()<EventRow[]>`
      UPDATE proof.strava_events SET attempts = attempts + 1, claimed_until = ${until}
      WHERE id IN (
        SELECT id FROM proof.strava_events
        WHERE claimed_until IS NULL OR claimed_until < ${now}
        ORDER BY received_at, id LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED)
      RETURNING id, attempts, object_type, aspect_type, object_id::text AS object_id,
                owner_id::text AS owner_id, event_time, deauthorized`;
    return rows
      .sort((a, b) => a.event_time.getTime() - b.event_time.getTime())
      .map(r => ({
        id: r.id,
        attempts: r.attempts,
        event: {
          objectType: r.object_type,
          aspectType: r.aspect_type,
          objectId: Number(r.object_id),
          ownerId: Number(r.owner_id),
          eventTime: r.event_time,
          deauthorized: r.deauthorized,
        },
      }));
  }

  // owner-exempt: removes a processed event from the system queue.
  async delete(id: string): Promise<void> {
    await this.uow.db()`DELETE FROM proof.strava_events WHERE id = ${id}`;
  }
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'errno' in e && String((e as { errno: unknown }).errno) === '23505';
}
