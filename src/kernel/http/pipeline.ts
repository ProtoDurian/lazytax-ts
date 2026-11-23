// Layers 2, 3 and 5, shared by HTTP routes and MCP tools so both enforce exactly the same rules.
import { allowed, type PolicyTable } from '../auth/policies';
import type { Principal } from '../auth/principal';
import { unauthenticated, unauthorized, validationFailed } from '../errors';
import type { Guard } from './route';

export interface Gate {
  policy: string;
  subject?: string;
  guards: readonly Guard[];
}

// Layers 2 and 3. Returns the user the call is about (the subject value, else the caller).
export function authorize(
  policies: PolicyTable,
  gate: Gate,
  principal: Principal,
  args: Record<string, unknown>,
): string {
  // Layer 2.
  if (policies.get(gate.policy) !== 'public' && !principal.authenticated) throw unauthenticated();
  if (!allowed(policies, gate.policy, principal)) throw unauthorized();
  // Layer 3 (LazyTax GuardOrAny(target, scope, admin)).
  let userId = principal.sub;
  if (gate.subject !== undefined) {
    const target = args[gate.subject];
    if (typeof target !== 'string' || target === '')
      throw validationFailed('Invalid request', { [gate.subject]: ['is required'] });
    if (target !== principal.sub && !principal.isAdmin) throw unauthorized();
    userId = target;
  }
  return userId;
}

// Layer 5: cheap reads that may refuse early. Runs after the input is parsed.
export async function runGuards(
  gate: Gate,
  principal: Principal,
  userId: string,
  args: Record<string, unknown>,
): Promise<void> {
  for (const g of gate.guards) await g.check({ principal, userId, args });
}

// zod issues -> LazyTax ValidationError's { field: [messages] }.
export function zodErrors(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const i of issues) {
    const key = i.path.map(String).join('.') || '_';
    const list = out[key] ?? [];
    list.push(i.message);
    out[key] = list;
  }
  return out;
}
