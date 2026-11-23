// Strava connect, disconnect and the webhook inbox (LazyTax Domain/Strava/Service.cs).
// HTTP (the gateway) never runs inside a unit of work: every gateway call below sits between units.

import type { Outbox } from '@lazytax/kernel';
import { type Clock, type Logger, Owner, type UnitOfWork } from '@lazytax/kernel';
import type { BindingRepository } from '../data/binding-repository';
import type { StravaConnectionRepository, StravaInboxRepository } from '../data/strava-repository';
import { STRAVA_KEY } from '../plugins/strava';
import type { ProofRouter } from './router';
import {
  STRAVA_REQUIRED_SCOPE,
  type StravaApi,
  type StravaConnection,
  type StravaConnectOutcome,
  type StravaWebhookEvent,
} from './strava-model';

// Refresh a little early so a token never expires between the check and the call.
const REFRESH_MARGIN_MS = 5 * 60_000;
// How long one worker may hold a refresh; a crashed worker's claim frees itself after this.
const REFRESH_LEASE_MS = 60_000;

export class StravaService {
  constructor(
    private readonly api: StravaApi,
    private readonly connections: StravaConnectionRepository,
    private readonly inbox: StravaInboxRepository,
    private readonly bindings: BindingRepository,
    private readonly router: ProofRouter,
    private readonly outbox: Outbox,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly maxAttempts: number,
  ) {}

  // Swaps the callback's code for tokens and links the user's Strava.
  async connect(userId: string, code: string, grantedScope: string): Promise<StravaConnectOutcome> {
    const scopes = grantedScope.split(/[,\s]+/).filter(s => s !== '');
    if (!scopes.includes(STRAVA_REQUIRED_SCOPE)) return 'scope_missing';

    const grant = await this.api.exchangeCode(code);
    const existing = await this.connections.getByAthlete(Owner.system(), grant.athleteId);
    if (existing && existing.userId !== userId) {
      // Don't leave LazyTax authorized on a Strava account we refuse to link.
      await this.revokeQuietly(grant.tokens.refreshToken);
      return 'athlete_taken';
    }
    try {
      await this.connections.upsert(Owner.user(userId), grant.athleteId, grant.tokens, scopes.join(','));
    } catch (e) {
      if (e instanceof Error && 'id' in e && (e as { id: unknown }).id === 'strava_athlete_taken') {
        await this.revokeQuietly(grant.tokens.refreshToken);
        return 'athlete_taken';
      }
      throw e;
    }
    this.log.info('Strava connected', { userId });
    return 'connected';
  }

  get(owner: Owner): Promise<StravaConnection | null> {
    return this.connections.get(owner);
  }

  // Revokes LazyTax in Strava (best effort), then deletes the connection, the Strava bindings and
  // the Strava evidence. false when not connected.
  async disconnect(owner: Owner): Promise<boolean> {
    const conn = await this.connections.get(owner);
    if (!conn) return false;
    // Revoking the refresh token revokes its access tokens too.
    await this.revokeQuietly(conn.tokens.refreshToken);
    await this.removeData(conn.userId);
    return true;
  }

  // The best-effort part of account deletion (kernel beforePurge): tell Strava, outside any unit.
  async revokeForUser(userId: string): Promise<void> {
    const conn = await this.connections.get(Owner.user(userId));
    if (conn) await this.revokeQuietly(conn.tokens.refreshToken);
  }

  // One webhook event, from the inbox. Idempotent: a replay finds the evidence already there.
  async process(e: StravaWebhookEvent): Promise<void> {
    const system = Owner.system();
    const conn = await this.connections.getByAthlete(system, e.ownerId);
    if (!conn) return;

    if (e.objectType === 'athlete') {
      if (!e.deauthorized) return;
      // The user removed LazyTax in Strava's settings: a disconnect, minus the revoke.
      this.log.info('Strava deauthorized', { userId: conn.userId });
      await this.removeData(conn.userId);
      return;
    }
    if (e.objectType !== 'activity') return;

    if (e.aspectType === 'delete') {
      // The evidence of an activity deleted in Strava goes; the day it proved stays done.
      await this.uow.run(() =>
        this.outbox.add({
          type: 'proof.evidenceRevoked',
          payload: { userId: conn.userId, proofKey: STRAVA_KEY, externalId: String(e.objectId) },
          userId: conn.userId,
        }),
      );
      return;
    }

    // create, or update (the sport type may have changed): fetch and route. Replays are idempotent
    // on the activity id.
    const now = this.clock.now();
    const token = await this.accessToken(conn, now);
    if (token === null) return;
    const activity = await this.api.getActivity(token, e.objectId);
    if (!activity) return;
    await this.router.route({
      pluginKey: STRAVA_KEY,
      userId: conn.userId,
      externalId: String(e.objectId),
      occurredAt: new Date(activity.startDate),
      payload: activity,
    });
  }

  // The worker: claims a batch, processes each event on its own, and leaves a failed one claimed
  // until its lease runs out (then it is retried; after maxAttempts it is dropped).
  async drain(batchSize = 50, leaseMs = 5 * 60_000): Promise<number> {
    const claimed = await this.uow.run(() => this.inbox.claim(this.clock.now(), batchSize, leaseMs));
    for (const item of claimed) {
      try {
        await this.process(item.event);
        await this.uow.run(() => this.inbox.delete(item.id));
      } catch (err) {
        // One bad event must not stop the batch.
        if (item.attempts >= this.maxAttempts) {
          this.log.error('Dropping Strava event', { id: item.id, attempts: item.attempts, error: String(err) });
          await this.uow.run(() => this.inbox.delete(item.id));
        } else {
          this.log.warn('Strava event failed; will retry', {
            id: item.id,
            attempts: item.attempts,
            error: String(err),
          });
        }
      }
    }
    return claimed.length;
  }

  // Deletes the connection, the user's Strava bindings and the Strava evidence on their habits
  // (Strava's terms: delete Strava data on disconnect). Check results stay.
  private async removeData(userId: string): Promise<void> {
    const owner = Owner.user(userId);
    await this.uow.run(async () => {
      await this.uow.lockUser(userId);
      await this.bindings.deleteForPlugin(owner, STRAVA_KEY);
      await this.connections.delete(owner);
      await this.outbox.add({
        type: 'proof.evidenceRevoked',
        payload: { userId, proofKey: STRAVA_KEY, externalId: null },
        userId,
      });
    });
    this.log.info('Purged Strava data', { userId });
  }

  // A valid access token, refreshing under a short lease when it is about to expire. null when
  // Strava rejected the refresh token: the connection is purged.
  private async accessToken(conn: StravaConnection, now: Date): Promise<string | null> {
    if (conn.tokens.expiresAt.getTime() - REFRESH_MARGIN_MS > now.getTime()) return conn.tokens.accessToken;

    const owner = Owner.user(conn.userId);
    const claimed = await this.connections.claimRefresh(owner, now, REFRESH_LEASE_MS);
    if (!claimed) {
      // Another worker is refreshing (or the user just disconnected). Retry the event later.
      const again = await this.connections.get(owner);
      if (!again) return null;
      if (again.tokens.expiresAt.getTime() - REFRESH_MARGIN_MS > now.getTime()) return again.tokens.accessToken;
      throw new Error('Strava refresh in progress on another worker');
    }
    // Another worker may have refreshed while this one waited for the claim.
    if (claimed.tokens.expiresAt.getTime() - REFRESH_MARGIN_MS > now.getTime()) {
      await this.connections.releaseRefresh(owner);
      return claimed.tokens.accessToken;
    }

    let tokens: Awaited<ReturnType<StravaApi['refresh']>>;
    try {
      tokens = await this.api.refresh(claimed.tokens.refreshToken);
    } catch (err) {
      await this.connections.releaseRefresh(owner);
      throw err;
    }
    if (!tokens) {
      this.log.warn('Strava refresh token rejected; disconnecting', { userId: conn.userId });
      await this.removeData(conn.userId);
      return null;
    }
    await this.connections.saveTokens(owner, tokens);
    return tokens.accessToken;
  }

  private async revokeQuietly(token: string): Promise<void> {
    try {
      await this.api.revoke(token);
    } catch (err) {
      this.log.warn('Strava revoke failed; continuing', { error: String(err) });
    }
  }
}
