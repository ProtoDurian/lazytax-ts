import { notFound, Owner, tool, z } from '@lazytax/kernel';
import { resolutionDto, tagDto, validTagId } from '../api/v1/nfc-routes';
import { bindingDto, habitIdOf, manifestDto } from '../api/v1/proof-routes';
import type { NfcTagService } from '../domain/nfc-service';
import type { ProofService } from '../domain/proof-service';
import type { StravaService } from '../domain/strava-service';

const Habit = z.object({ userId: z.string(), habitId: z.string() });

// Same policy, subject and service methods as the routes.
export const proofTools = (proof: ProofService, nfc: NfcTagService) => [
  tool('plugins', {
    description: 'List the proof plugins this server offers, with their settings schemas',
    policy: 'registered',
    input: z.object({}),
    handler: () => proof.listPlugins().map(manifestDto),
  }),
  tool('binding', {
    description: "A habit's proof binding (the manual proof when none is bound)",
    policy: 'registered',
    subject: 'userId',
    input: Habit,
    handler: async ({ input }) => {
      const habitId = habitIdOf(input.habitId);
      return bindingDto(habitId, await proof.getBinding(Owner.user(input.userId), habitId));
    },
  }),
  tool('bind', {
    description: 'Bind a habit to a proof plugin (settings is a JSON object as text), replacing its binding',
    policy: 'registered',
    subject: 'userId',
    input: Habit.extend({ pluginKey: z.string().min(1).max(64), settings: z.string().min(1).max(4096) }),
    handler: async ({ input }) => {
      const habitId = habitIdOf(input.habitId);
      return bindingDto(habitId, await proof.bind(Owner.user(input.userId), habitId, input.pluginKey, input.settings));
    },
  }),
  tool('unbind', {
    description: "Back to the manual proof: remove a habit's binding",
    policy: 'registered',
    subject: 'userId',
    input: Habit,
    handler: async ({ input }) => {
      const habitId = habitIdOf(input.habitId);
      return { removed: await proof.unbind(Owner.user(input.userId), habitId) };
    },
  }),
  tool('nfcLink', {
    description: 'Link an NFC tag to a habit (first come, first served)',
    policy: 'registered',
    subject: 'userId',
    input: z.object({ userId: z.string(), tagId: z.string(), habitId: z.string() }),
    handler: async ({ input }) =>
      tagDto(await nfc.link(Owner.user(input.userId), validTagId(input.tagId), habitIdOf(input.habitId))),
  }),
  tool('nfcResolve', {
    description: "Resolve an NFC tag to its habit's current version and today's execution",
    policy: 'registered',
    subject: 'userId',
    input: z.object({ userId: z.string(), tagId: z.string() }),
    handler: async ({ input }) => {
      const tagId = validTagId(input.tagId);
      const r = await nfc.resolve(Owner.user(input.userId), tagId);
      if (!r) throw notFound('NFC Tag', tagId);
      return resolutionDto(r);
    },
  }),
];

export const stravaTools = (strava: StravaService, enabled: () => boolean) => [
  tool('stravaStatus', {
    description: 'Whether the user has linked Strava',
    policy: 'registered',
    subject: 'userId',
    input: z.object({ userId: z.string() }),
    handler: async ({ input }) => {
      if (!enabled()) throw notFound('Strava', '');
      const conn = await strava.get(Owner.user(input.userId));
      return { connected: conn !== null, connectedAtUtc: conn?.connectedAt.toISOString() ?? null };
    },
  }),
  tool('stravaDisconnect', {
    description: "Revoke LazyTax in Strava and delete the user's Strava data",
    policy: 'registered',
    subject: 'userId',
    input: z.object({ userId: z.string() }),
    handler: async ({ input }) => {
      if (!enabled()) throw notFound('Strava', '');
      if (!(await strava.disconnect(Owner.user(input.userId)))) throw notFound('Strava Connection', input.userId);
      return { disconnected: true };
    },
  }),
];
