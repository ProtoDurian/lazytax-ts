// Mounts every context's routes on one Hono app, with layers 1-3 and 5, problem-details errors
// and one log line per request.
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import type { Authenticator } from '../auth/jwt';
import type { PolicyTable } from '../auth/policies';
import { ANONYMOUS, type Principal } from '../auth/principal';
import { Problem, problemType, toProblemJson, validationFailed } from '../errors';
import type { Logger } from '../log';
import { authorize, runGuards, zodErrors } from './pipeline';
import type { RouteDef } from './route';

export interface MountedRoute {
  context: string;
  method: string;
  // Full Hono path, e.g. /api/v1/Vacation/:userId
  path: string;
  route: RouteDef;
}

export interface HttpDeps {
  auth: Authenticator;
  policies: PolicyTable;
  log: Logger;
}

export function requestIdOf(req: Request): string {
  const given = req.headers.get('x-request-id');
  return given && /^[A-Za-z0-9._-]{1,100}$/.test(given) ? given : randomUUID();
}

export function problemResponse(err: unknown, requestId: string, instance: string): Response {
  const body = toProblemJson(err, requestId, instance);
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: { 'content-type': 'application/problem+json', 'x-request-id': requestId },
  });
}

async function parse(schema: RouteDef['body'], value: unknown, what: string): Promise<unknown> {
  if (schema === undefined) return undefined;
  const r = await schema.safeParseAsync(value);
  if (!r.success) throw validationFailed(`Invalid ${what}`, zodErrors(r.error.issues));
  return r.data;
}

export function mountRoutes(app: Hono, routes: MountedRoute[], deps: HttpDeps): void {
  for (const m of routes) {
    const label = `${m.method} ${m.path}`;
    app.on(m.method, m.path, async c => {
      const started = performance.now();
      const requestId = requestIdOf(c.req.raw);
      let principal: Principal = ANONYMOUS;
      let res: Response;
      let err: unknown;
      try {
        principal = await deps.auth.fromHeader(c.req.header('authorization'));
        const params = c.req.param() as Record<string, string>;
        const userId = authorize(deps.policies, m.route, principal, params);
        const query = await parse(m.route.query, c.req.query(), 'query');
        let raw: unknown;
        const text = await c.req.text();
        if (m.route.body !== undefined) {
          try {
            raw = text === '' ? undefined : JSON.parse(text);
          } catch {
            throw validationFailed('Invalid JSON body', { body: ['is not valid JSON'] });
          }
        }
        const body = await parse(m.route.body, raw, 'request body');
        const args: Record<string, unknown> = { ...(query as object), ...(body as object), ...params };
        await runGuards(m.route, principal, userId, args);
        const out = await m.route.handler({
          principal,
          params,
          body,
          query,
          requestId,
          headers: c.req.raw.headers,
          rawBody: text,
        });
        if (out instanceof Response) res = out;
        else if (out === undefined) res = new Response(null, { status: 204 });
        else res = Response.json(out, { status: m.route.status ?? 200 });
        res.headers.set('x-request-id', requestId);
      } catch (e) {
        err = e;
        res = problemResponse(e, requestId, new URL(c.req.url).pathname);
      }
      logRequest(deps.log, {
        context: m.context,
        route: label,
        principal,
        requestId,
        status: res.status,
        started,
        err,
      });
      return res;
    });
  }
}

export function logRequest(
  log: Logger,
  r: {
    context: string;
    route?: string;
    tool?: string;
    principal: Principal;
    requestId: string;
    status: number;
    started: number;
    err?: unknown;
  },
): void {
  const fields = {
    context: r.context,
    route: r.route,
    tool: r.tool,
    sub: r.principal.sub || null,
    requestId: r.requestId,
    status: r.status,
    durationMs: Math.round((performance.now() - r.started) * 10) / 10,
  };
  if (r.status < 400) {
    log.info(r.tool ? 'tool' : 'request', fields);
    return;
  }
  const problem = r.err instanceof Problem ? problemType(r.err.id) : problemType('internal_error');
  const detail =
    r.err instanceof Problem || r.err === undefined ? undefined : String((r.err as Error)?.message ?? r.err);
  log.error(r.tool ? 'tool failed' : 'request failed', { ...fields, problem, error: detail });
}
