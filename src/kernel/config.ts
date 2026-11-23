// The one typed config, from env, with defaults for local use (mock Logto on 9301, Postgres on 55430).
//
// Kernel settings live here. Each context's own settings are a zod schema in its
// defineContext({ config }) with defaults; override them with env LAZYTAX_<NAME>_CONFIG as JSON
// (deep-merged), e.g. LAZYTAX_PLAN_CONFIG='{"tiers":{"free":{"vacationWindowsYearly":1}}}'.
// The kernel validates every context's config at start, before it listens.
import type { LogLevel } from './log';

export interface KernelConfig {
  port: number;
  databaseUrl: string;
  auth: {
    jwksUrl: string;
    issuer: string;
    audience: string;
  };
  log: {
    level: LogLevel;
    // Also append JSON lines here (LOG_FILE).
    file?: string;
  };
  outbox: {
    pollMs: number;
    maxAttempts: number;
  };
}

const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

export function loadKernelConfig(env: Record<string, string | undefined> = process.env): KernelConfig {
  const issuer = env.AUTH_ISSUER ?? 'http://127.0.0.1:9301';
  return {
    port: num(env.PORT, 9300),
    databaseUrl: env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:55430/lazytax',
    auth: {
      jwksUrl: env.AUTH_JWKS_URL ?? `${issuer}/jwks`,
      issuer,
      audience: env.AUTH_AUDIENCE ?? 'lazytax-api',
    },
    log: {
      level: (env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
      file: env.LOG_FILE || undefined,
    },
    outbox: {
      pollMs: num(env.OUTBOX_POLL_MS, 1000),
      maxAttempts: num(env.OUTBOX_MAX_ATTEMPTS, 5),
    },
  };
}

// Reads LAZYTAX_<NAME>_CONFIG (JSON) for one context; {} when unset.
export function contextConfigOverride(name: string, env: Record<string, string | undefined> = process.env): unknown {
  const raw = env[`LAZYTAX_${name.toUpperCase()}_CONFIG`];
  if (raw === undefined || raw === '') return {};
  return JSON.parse(raw);
}
