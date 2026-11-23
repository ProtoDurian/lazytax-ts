// MCP tools, served by the kernel at POST /mcp (streamable HTTP, JSON-RPC: initialize,
// tools/list, tools/call). A tool is named "<context mcp.prefix>.<verb>", e.g. "vacation.create".
//
// It uses the same bearer JWT, the same policy, the same subject rule, the same guards and the
// SAME service method as the matching HTTP route:
//
//   tool('create', {
//     description: 'Create a vacation window for a user',
//     policy: 'registered',
//     subject: 'userId',
//     guards: [vacationAllowed],
//     input: z.object({ userId: z.string(), startDate: z.string(), endDate: z.string(), timezone: z.string() }),
//     handler: ({ input }) => service.create(Owner.user(input.userId), input),
//   })
//
// The return value is sent as JSON text content. A thrown Problem becomes an error result
// (`isError: true`) whose text is the problem-details JSON.
import type { z } from 'zod';
import type { Principal } from '../auth/principal';
import type { Guard, PolicyName } from '../http/route';

export interface ToolCall<S extends z.ZodObject> {
  principal: Principal;
  input: z.output<S>;
  requestId: string;
}

export interface ToolOptions<S extends z.ZodObject> {
  description: string;
  policy: PolicyName;
  subject?: keyof z.output<S> & string;
  guards?: Guard[];
  input: S;
  handler: (call: ToolCall<S>) => unknown;
}

export interface ToolDef {
  readonly verb: string;
  readonly description: string;
  readonly policy: PolicyName;
  readonly subject?: string;
  readonly guards: readonly Guard[];
  readonly input: z.ZodObject;
  // biome-ignore lint/suspicious/noExplicitAny: the typed call is checked in ToolOptions
  readonly handler: (call: any) => unknown;
}

export function tool<S extends z.ZodObject>(verb: string, opts: ToolOptions<S>): ToolDef {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(verb)) throw new Error(`MCP tool verb "${verb}" must be camelCase letters`);
  return { verb, ...opts, guards: opts.guards ?? [] };
}
