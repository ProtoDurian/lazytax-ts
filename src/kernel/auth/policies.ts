// Layer 2: policies, shaped like nitroso's (zinc/App/Config/settings.yaml):
//   admin: { field: scope, type: any, target: [admin] }
// Built in: public (no token needed), registered (any valid token), admin (scope has admin, as
// LazyTax App/StartUp/Registry/AuthPolicies.cs). More come from /policies.yaml and each
// context's policies.yaml.
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Principal } from './principal';

const PolicySchema = z.strictObject({
  field: z.enum(['scope', 'roles']),
  type: z.enum(['any', 'all']),
  target: z.array(z.string().min(1)).min(1),
});

export type Policy = z.output<typeof PolicySchema>;

const PolicyFileSchema = z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), PolicySchema);

export const ADMIN_POLICY: Policy = { field: 'scope', type: 'any', target: ['admin'] };

export type PolicyTable = ReadonlyMap<string, Policy | 'public' | 'registered'>;

export function readPolicyFile(path: string): Record<string, Policy> {
  if (!existsSync(path)) return {};
  const parsed = PolicyFileSchema.safeParse(Bun.YAML.parse(readFileSync(path, 'utf8')) ?? {});
  if (!parsed.success) throw new Error(`${path}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function passes(policy: Policy, principal: Pick<Principal, 'scopes' | 'roles'>): boolean {
  const have = new Set(policy.field === 'scope' ? principal.scopes : principal.roles);
  return policy.type === 'any' ? policy.target.some(t => have.has(t)) : policy.target.every(t => have.has(t));
}

// true = allowed, false = 403. Unknown names are refused at start, never here.
export function allowed(table: PolicyTable, name: string, principal: Principal): boolean {
  const p = table.get(name);
  if (p === undefined) return false;
  if (p === 'public') return true;
  if (!principal.authenticated) return false;
  if (p === 'registered') return true;
  return passes(p, principal);
}
