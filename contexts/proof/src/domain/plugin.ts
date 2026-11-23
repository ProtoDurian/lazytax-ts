// What a plugin author writes (LazyTax Domain/Proof/Plugin.cs). Stored settings and the event
// payload arrive as the plugin's own types, so a plugin never touches JSON.
import { validationFailed, z } from '@lazytax/kernel';
import type { PluginManifest, ProofBinding, ProofEvent, ProofWindow, Verdict } from './model';

export interface ProofPlugin {
  readonly manifest: PluginManifest;
  // Parses and checks a binding's settings; returns them normalized for storage, or throws a 400.
  validateSettings(settings: string): string;
  onBind(binding: ProofBinding): Promise<void>;
  onUnbind(binding: ProofBinding): Promise<void>;
  // binding is null when an always-bound plugin proves a habit it isn't bound to. A null verdict:
  // the event says nothing about this check (not relevant, or not enough yet).
  evaluate(binding: ProofBinding | null, e: ProofEvent, window: ProofWindow): Promise<Verdict | null>;
}

type Errors = Record<string, string[]>;

export const invalidBinding = (errors: Errors) => validationFailed('Invalid proof binding', errors);

const EmptySettings = z.strictObject({});

export interface PluginDef<S extends z.ZodType, P extends z.ZodType> {
  manifest: Omit<PluginManifest, 'minTier' | 'alwaysBound' | 'settingsSchema'> &
    Partial<Pick<PluginManifest, 'minTier' | 'alwaysBound'>> & { settingsSchema?: string };
  // Settings are user input: unknown fields are rejected so a typo doesn't silently do nothing.
  settings?: S;
  // Payloads come from other systems (Strava, Apple): unknown fields are ignored.
  payload?: P;
  // Rules beyond the settings' shape, as field -> messages. Empty when valid.
  validate?: (settings: z.output<S>) => Errors;
  onBind?: (binding: ProofBinding, settings: z.output<S>) => Promise<void>;
  onUnbind?: (binding: ProofBinding, settings: z.output<S>) => Promise<void>;
  evaluate: (
    settings: z.output<S>,
    payload: z.output<P>,
    e: ProofEvent,
    window: ProofWindow,
  ) => Promise<Verdict | null> | Verdict | null;
}

const issuesToErrors = (error: z.ZodError): Errors => {
  const out: Errors = {};
  for (const issue of error.issues) {
    const field = issue.path.length === 0 ? 'settings' : issue.path.join('.');
    const list = out[field] ?? [];
    list.push(issue.message);
    out[field] = list;
  }
  return out;
};

export function definePlugin<S extends z.ZodType = typeof EmptySettings, P extends z.ZodType = z.ZodType<unknown>>(
  def: PluginDef<S, P>,
): ProofPlugin {
  const settingsSchema = (def.settings ?? EmptySettings) as z.ZodType;
  const payloadSchema = (def.payload ?? z.unknown()) as z.ZodType;
  const manifest: PluginManifest = {
    ...def.manifest,
    minTier: def.manifest.minTier ?? null,
    alwaysBound: def.manifest.alwaysBound ?? false,
    settingsSchema: def.manifest.settingsSchema ?? '{"type":"object","properties":{},"additionalProperties":false}',
  };

  const parseSettings = (text: string): z.output<S> => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw invalidBinding({ settings: [(e as Error).message] });
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw invalidBinding({ settings: ['Settings must be a JSON object'] });
    const parsed = settingsSchema.safeParse(raw);
    if (!parsed.success) throw invalidBinding(issuesToErrors(parsed.error));
    return parsed.data as z.output<S>;
  };

  // Stored settings were normalized by validateSettings when bound.
  const settingsOf = (binding: ProofBinding): z.output<S> =>
    settingsSchema.parse(JSON.parse(binding.settings)) as z.output<S>;

  return {
    manifest,
    validateSettings(text) {
      const parsed = parseSettings(text);
      const errors = def.validate?.(parsed) ?? {};
      if (Object.keys(errors).length > 0) throw invalidBinding(errors);
      return JSON.stringify(parsed);
    },
    onBind: binding => def.onBind?.(binding, settingsOf(binding)) ?? Promise.resolve(),
    onUnbind: binding => def.onUnbind?.(binding, settingsOf(binding)) ?? Promise.resolve(),
    async evaluate(binding, e, window) {
      const payload = payloadSchema.safeParse(e.payload ?? {});
      return def.evaluate(
        binding === null ? (settingsSchema.parse({}) as z.output<S>) : settingsOf(binding),
        (payload.success ? payload.data : {}) as z.output<P>,
        e,
        window,
      );
    },
  };
}
