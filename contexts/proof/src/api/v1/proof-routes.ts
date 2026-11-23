import { notFound, Owner, route, z } from '@lazytax/kernel';
import type { PluginManifestDto, ProofBindingDto } from '@lazytax/proof-contract/v1';
import type { PluginManifest, ProofBinding } from '../../domain/model';
import type { ProofService } from '../../domain/proof-service';
import { MANUAL_KEY } from '../../plugins/manual';

const BindProofReq = z.object({
  pluginKey: z.string().min(1).max(64),
  settings: z.string().min(1).max(4096),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `{habitId:guid}` in LazyTax: a path that is not a uuid matches no route (404).
export const habitIdOf = (id: string): string => {
  if (!UUID.test(id)) throw notFound('Habit', id);
  return id.toLowerCase();
};

export const manifestDto = (m: PluginManifest): PluginManifestDto => ({ ...m });

// A habit with no binding reports the manual proof.
export const bindingDto = (habitId: string, b: ProofBinding | null): ProofBindingDto =>
  b
    ? { habitId: b.habitId, pluginKey: b.pluginKey, pluginVersion: b.pluginVersion, settings: b.settings }
    : { habitId, pluginKey: MANUAL_KEY, pluginVersion: 1, settings: '{}' };

// Registered before the :userId routes: "plugins" is a path of its own.
export const proofRoutes = (svc: ProofService) => [
  // The proof plugins this server offers; the app renders a binding form from settingsSchema.
  route.get('/Proof/plugins', {
    policy: 'registered',
    handler: () => svc.listPlugins().map(manifestDto),
  }),
  route.get('/Proof/:userId/:habitId', {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => {
      const habitId = habitIdOf(params.habitId);
      return bindingDto(habitId, await svc.getBinding(Owner.user(params.userId), habitId));
    },
  }),
  route.put('/Proof/:userId/:habitId', {
    policy: 'registered',
    subject: 'userId',
    body: BindProofReq,
    handler: async ({ params, body }) => {
      const habitId = habitIdOf(params.habitId);
      return bindingDto(habitId, await svc.bind(Owner.user(params.userId), habitId, body.pluginKey, body.settings));
    },
  }),
  // Back to manual only.
  route.delete('/Proof/:userId/:habitId', {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => {
      const habitId = habitIdOf(params.habitId);
      if (!(await svc.unbind(Owner.user(params.userId), habitId))) throw notFound('Proof Binding', habitId);
    },
  }),
];
