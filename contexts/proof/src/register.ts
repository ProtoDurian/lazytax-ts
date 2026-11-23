import '@lazytax/account-contract/v1';
import '@lazytax/habit-contract/v1';
import '@lazytax/plan-contract/v1';
import '@lazytax/proof-contract/v1';
import type { CheckV1 } from '@lazytax/check-contract/v1';
import { type Clock, defineContext, Owner, subscribe } from '@lazytax/kernel';
import { nfcRoutes } from './api/v1/nfc-routes';
import { proofRoutes } from './api/v1/proof-routes';
import { stravaRoutes } from './api/v1/strava-routes';
import { BindingRepository } from './data/binding-repository';
import { NfcTagRepository } from './data/nfc-repository';
import { StravaConnectionRepository, StravaInboxRepository } from './data/strava-repository';
import { ProofConfig } from './domain/config';
import { createEncryptor } from './domain/crypto';
import type { CheckPort, HabitPort } from './domain/model';
import { toEvent } from './domain/model';
import { NfcTagService } from './domain/nfc-service';
import { ProofService } from './domain/proof-service';
import { ProofPluginRegistry } from './domain/registry';
import { ProofRouter } from './domain/router';
import { StravaService } from './domain/strava-service';
import { fakeStrava } from './gateways/strava-fake';
import { proofTools, stravaTools } from './mcp/proof-tools';
import { manualPlugin } from './plugins/manual';
import { nfcPlugin } from './plugins/nfc';
import { stravaPlugin } from './plugins/strava';

// check.v1 may not offer executionForDate yet; until it does, NFC resolve reports no execution.
type CheckWithDate = CheckV1 & { executionForDate?: (owner: Owner, habitId: string, date: string) => Promise<unknown> };

export default defineContext({
  config: ProofConfig,
  migrations: 'src/data/migrations',
  build: ({ deps, uow, outbox, log, config, clock }) => {
    const habit = deps.get('habit.v1');
    const check = deps.get('check.v1') as CheckWithDate;
    const account = deps.get('account.v1');
    const plan = deps.get('plan.v1');
    const cfg = config.strava;
    const clk: Clock = clock;
    if (cfg.enabled) fakeStrava.useClock(clk);

    const habitPort: HabitPort = {
      owns: (userId, habitId) => habit.owns(userId, habitId),
      current: async (userId, habitId) => {
        const v = await habit.getCurrent(Owner.user(userId), habitId);
        return v ? { id: v.id, habitId: v.habitId, version: v } : null;
      },
    };
    const checkPort: CheckPort = {
      pendingCheckAt: async (userId, habitId, at) => {
        const c = await check.pendingCheckAt(userId, habitId, at.toISOString());
        return c
          ? {
              localDate: c.localDate,
              timezone: c.timezone,
              opensAt: new Date(c.opensAt),
              deadline: new Date(c.deadline),
            }
          : null;
      },
      report: async (userId, habitId, e) => {
        const x = await check.report(userId, habitId, {
          proofKey: e.proofKey,
          externalId: e.externalId,
          verdict: e.verdict,
          occurredAt: e.occurredAt.toISOString(),
          data: e.data,
          notes: e.notes,
        });
        return x?.id ?? null;
      },
      executionForDate: async (userId, habitId, date) =>
        check.executionForDate ? check.executionForDate(Owner.user(userId), habitId, date) : null,
    };

    const bindings = new BindingRepository(uow);
    const tags = new NfcTagRepository(uow);
    const connections = new StravaConnectionRepository(uow, createEncryptor(cfg.encryptionKey));
    const inbox = new StravaInboxRepository(uow);

    const nfcLookup = {
      isLinked: async (userId: string, tagId: string, habitId: string) =>
        (await tags.get(Owner.user(userId), tagId))?.habitId === habitId,
    };
    const registry = new ProofPluginRegistry([
      manualPlugin,
      nfcPlugin(nfcLookup),
      ...(cfg.enabled
        ? [stravaPlugin({ isConnected: async userId => (await connections.get(Owner.user(userId))) !== null })]
        : []),
    ]);

    const router = new ProofRouter(registry, bindings, checkPort, uow, clk);
    const proof = new ProofService(registry, bindings, habitPort, { ensureTier: plan.ensureTier.bind(plan) }, uow);
    const nfc = new NfcTagService(tags, habitPort, { today: u => account.today(u) }, checkPort, router, clk);
    const strava = new StravaService(
      fakeStrava,
      connections,
      inbox,
      bindings,
      router,
      outbox,
      uow,
      clk,
      log,
      cfg.maxAttempts,
    );

    return {
      provides: {
        'proof.v1': {
          route: async e => (await router.route(toEvent(e))).map(o => ({ ...o })),
          listPlugins: () => proof.listPlugins(),
          getBinding: async (owner, habitId) => {
            const b = await bindings.getForHabit(owner, habitId);
            return b
              ? { habitId: b.habitId, pluginKey: b.pluginKey, pluginVersion: b.pluginVersion, settings: b.settings }
              : null;
          },
          listPluginKeys: owner => bindings.listPluginKeys(owner),
          listTaggedHabits: owner => tags.listTaggedHabits(owner),
        },
      },
      http: [
        ...proofRoutes(proof),
        ...nfcRoutes(nfc),
        ...stravaRoutes({ service: strava, inbox, connections, config: () => cfg, clock: clk, log }),
      ],
      mcp: [...proofTools(proof, nfc), ...stravaTools(strava, () => cfg.enabled)],
      users: {
        beforePurge: userId => strava.revokeForUser(userId),
        purgeUser: async userId => {
          await bindings.purgeUser(userId);
          await tags.purgeUser(userId);
          await connections.purgeUser(userId);
        },
      },
      subscribers: [
        // A deleted habit releases its tag links and its binding.
        subscribe('habit.deleted', async e => {
          const { userId, habitIds } = e.payload;
          await proof.releaseHabits(userId, habitIds);
          await nfc.releaseHabits(userId, habitIds);
        }),
      ],
      workers: cfg.enabled
        ? [{ name: 'strava-inbox', everyMs: cfg.pollMs, tick: async () => void (await strava.drain()), tx: false }]
        : [],
    };
  },
});
