// One MCP endpoint at /mcp over streamable HTTP (JSON responses, stateless), using the official
// @modelcontextprotocol/sdk with its fetch-native WebStandardStreamableHTTPServerTransport.
// Each tools/call runs the same layers as an HTTP route: JWT, policy, subject, guards.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Principal } from '../auth/principal';
import { notFound, Problem, toProblemJson, validationFailed } from '../errors';
import { authorize, runGuards, zodErrors } from '../http/pipeline';
import { type HttpDeps, logRequest, problemResponse, requestIdOf } from '../http/server';
import type { ToolDef } from './tool';

export interface MountedTool {
  context: string;
  // "<mcp.prefix>.<verb>"
  name: string;
  tool: ToolDef;
}

function buildServer(tools: Map<string, MountedTool>, deps: HttpDeps, principal: Principal, requestId: string): Server {
  const server = new Server({ name: 'lazytax', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.values()].map(t => ({
      name: t.name,
      description: t.tool.description,
      inputSchema: z.toJSONSchema(t.tool.input, { io: 'input' }) as { type: 'object' },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async req => {
    const started = performance.now();
    const name = req.params.name;
    const t = tools.get(name);
    let status = 200;
    let err: unknown;
    try {
      if (!t) throw notFound('Tool', name);
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const userId = authorize(deps.policies, t.tool, principal, args);
      const parsed = await t.tool.input.safeParseAsync(args);
      if (!parsed.success) throw validationFailed('Invalid tool input', zodErrors(parsed.error.issues));
      await runGuards(t.tool, principal, userId, parsed.data as Record<string, unknown>);
      const out = await t.tool.handler({ principal, input: parsed.data, requestId });
      return { content: [{ type: 'text' as const, text: JSON.stringify(out ?? null) }] };
    } catch (e) {
      err = e;
      const body = toProblemJson(e, requestId, `/mcp#${name}`);
      status = body.status;
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
    } finally {
      logRequest(deps.log, { context: t?.context ?? 'kernel', tool: name, principal, requestId, status, started, err });
    }
  });
  return server;
}

export function mountMcp(app: Hono, tools: MountedTool[], deps: HttpDeps): void {
  const byName = new Map(tools.map(t => [t.name, t]));
  app.post('/mcp', async c => {
    const requestId = requestIdOf(c.req.raw);
    let principal: Principal;
    try {
      principal = await deps.auth.fromHeader(c.req.header('authorization'));
    } catch (e) {
      const res = problemResponse(e, requestId, '/mcp');
      logRequest(deps.log, {
        context: 'kernel',
        route: 'POST /mcp',
        principal: { sub: '', authenticated: false, scopes: [], roles: [], isAdmin: false },
        requestId,
        status: res.status,
        started: performance.now(),
        err: e instanceof Problem ? e : undefined,
      });
      return res;
    }
    const server = buildServer(byName, deps, principal, requestId);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const res = await transport.handleRequest(c.req.raw);
    await server.close();
    return res;
  });
}
