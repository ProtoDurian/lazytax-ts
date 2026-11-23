// HTTP routes, declared by a context and mounted by the kernel under the context's http.prefix.
//
//   route.post('/:userId', {
//     policy: 'registered',                 // layer 2: required, a route without one fails the start
//     subject: 'userId',                    // layer 3: :userId must equal the token's sub, or admin
//     guards: [vacationAllowed],            // layer 5: cheap reads that can refuse early
//     body: CreateVacationReq,              // zod schema; a bad body is a 400 validation_error
//     handler: ({ params, body }) => service.create(Owner.user(params.userId), body),
//   })
//
// The handler's return value is the 200 JSON body (or `status`); `undefined` is a 204; a
// `Response` passes through untouched. Throw a `Problem` for every error.
import type { z } from 'zod';
import type { Principal } from '../auth/principal';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// Built-ins are 'public', 'registered' and 'admin'; others come from policies.yaml.
export type PolicyName = 'public' | 'registered' | 'admin' | (string & {});

// "/:userId/:id/end-today" -> { userId: string; id: string }
export type ParamsOf<P extends string> = P extends `${string}:${infer K}/${infer Rest}`
  ? { [k in K]: string } & ParamsOf<`/${Rest}`>
  : P extends `${string}:${infer K}`
    ? { [k in K]: string }
    : Record<never, string>;

type Out<S> = S extends z.ZodType ? z.output<S> : undefined;

// Layer 5. A guard runs after policy and subject, before the handler, on HTTP and MCP alike.
export interface GuardCall {
  principal: Principal;
  // The subject param / input value when the route has a subject, else the caller's sub.
  userId: string;
  // Path params + query + body for HTTP, the input for MCP.
  args: Record<string, unknown>;
}

export interface Guard {
  // Printed in `bun run policies`, e.g. "plan:vacationWindows".
  name: string;
  check: (call: GuardCall) => Promise<void> | void;
}

export const guard = (name: string, check: Guard['check']): Guard => ({ name, check });

export interface RouteCall<P extends string, SB, SQ> {
  principal: Principal;
  params: ParamsOf<P>;
  body: Out<SB>;
  query: Out<SQ>;
  requestId: string;
  // The request headers (for webhook signatures). Never log them.
  headers: Headers;
  // The raw request body text ("" when empty), read once, for HMAC checks.
  rawBody: string;
}

export interface RouteOptions<P extends string, SB extends z.ZodType | undefined, SQ extends z.ZodType | undefined> {
  policy: PolicyName;
  subject?: keyof ParamsOf<P> & string;
  guards?: Guard[];
  body?: SB;
  query?: SQ;
  // Success status when the handler returns a value. Default 200.
  status?: 200 | 201 | 202;
  handler: (call: RouteCall<P, SB, SQ>) => unknown;
}

export interface RouteDef {
  readonly method: HttpMethod;
  // Relative to the context's http.prefix; Hono syntax (":param").
  readonly path: string;
  readonly policy: PolicyName;
  readonly subject?: string;
  readonly guards: readonly Guard[];
  readonly body?: z.ZodType;
  readonly query?: z.ZodType;
  readonly status?: number;
  // biome-ignore lint/suspicious/noExplicitAny: the typed call is checked in RouteOptions
  readonly handler: (call: any) => unknown;
}

const make =
  (method: HttpMethod) =>
  <P extends string, SB extends z.ZodType | undefined = undefined, SQ extends z.ZodType | undefined = undefined>(
    path: P,
    opts: RouteOptions<P, SB, SQ>,
  ): RouteDef => ({ method, path, ...opts, guards: opts.guards ?? [] });

export const route = {
  get: make('GET'),
  post: make('POST'),
  put: make('PUT'),
  patch: make('PATCH'),
  delete: make('DELETE'),
};
