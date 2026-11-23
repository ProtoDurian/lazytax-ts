// The log-file test: start the real app process with LOG_FILE set, make requests, then assert on
// the file. One JSON line per request with context, route or tool, sub, request id, status and
// duration; no token, email or request body anywhere; an error request logs at error level with
// its problem type; an MCP tools/call is logged with its tool name.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Stack, startStack } from '../../tools/harness';

const EMAIL = 'secret.person@example.com';
const BODY_MARKER = 'BODY-MARKER-9f3c1';
const SUB = 'logfile-user';

let stack: Stack;
let dir: string;
let logFile: string;
let token: string;
let tokenRaw: string;
const requestIds: Record<string, string> = {};

interface Line {
  time: string;
  level: string;
  msg: string;
  context?: string;
  route?: string;
  tool?: string;
  sub?: string | null;
  requestId?: string;
  status?: number;
  durationMs?: number;
  problem?: string;
  [k: string]: unknown;
}

const lines = (): Line[] =>
  readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Line);

const byRequestId = (id: string) => lines().filter(l => l.requestId === id);

async function call(label: string, path: string, init: RequestInit = {}): Promise<Response> {
  const id = `logfile-${label}-${crypto.randomUUID()}`;
  requestIds[label] = id;
  const res = await fetch(`${stack.baseUrl}${path}`, {
    ...init,
    headers: { 'x-request-id': id, ...(init.headers as Record<string, string>) },
  });
  await res.arrayBuffer();
  return res;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lazytax-logfile-'));
  logFile = join(dir, 'app.log');
  stack = await startStack({ logFile });
  // A token whose claims carry an email: it must never reach the file.
  const res = await fetch(`${stack.logtoUrl}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub: SUB, claims: { email: EMAIL } }),
  });
  token = ((await res.json()) as { access_token: string }).access_token;
  tokenRaw = token.split('.')[1] ?? '';
  const auth = { authorization: `Bearer ${token}` };

  // 1. authenticated, a body that must not be logged (any status: the line is what matters)
  await call('post', `/api/v1/Configuration/${SUB}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ timezone: BODY_MARKER, defaultCharityId: BODY_MARKER }),
  });
  // 2. authenticated read
  await call('get', `/api/v1/User/Me`, { headers: auth });
  // 3. no token: an error
  await call('anon', `/api/v1/User/Me`);
  // 4. a route that does not exist: an error with a problem type
  await call('missing', `/api/v1/DoesNotExist/${SUB}`, { headers: auth });
  // 5. an MCP tools/call: a real tool when the app has one, else a name the kernel logs as not found
  const mcp = (body: unknown, label: string) =>
    call(label, '/mcp', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    });
  const list = (await (await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'mcp-list'))
    .json()
    .catch(() => ({}))) as {
    result?: { tools?: Array<{ name: string }> };
  };
  const toolName = list.result?.tools?.[0]?.name ?? 'logfile.unknown';
  requestIds.toolName = toolName;
  await mcp(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: { note: BODY_MARKER } } },
    'mcp-call',
  );
});

afterAll(async () => {
  await stack?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('LOG_FILE', () => {
  it('should write only JSON lines', () => {
    const raw = readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(l => l.trim() !== '');
    expect(raw.length).toBeGreaterThan(0);
    for (const l of raw) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('should write exactly one line per HTTP request', () => {
    for (const label of ['post', 'get', 'anon', 'missing']) {
      const mine = byRequestId(requestIds[label] ?? 'none');
      expect(mine.length).toBe(1);
    }
  });

  it('should carry context, route, sub, request id, status and duration on a request line', () => {
    const line = byRequestId(requestIds.get ?? 'none')[0];
    expect(line).toBeDefined();
    expect(typeof line?.context).toBe('string');
    expect(line?.route).toContain('/api/v1/User/Me');
    expect(line?.sub).toBe(SUB);
    expect(line?.requestId).toBe(requestIds.get as string);
    expect(typeof line?.status).toBe('number');
    expect(typeof line?.durationMs).toBe('number');
    expect(Number.isNaN(Date.parse(line?.time as string))).toBe(false);
  });

  it('should log an error request at error level with its problem type', () => {
    const anon = byRequestId(requestIds.anon ?? 'none')[0];
    expect(anon?.status).toBe(401);
    expect(anon?.level).toBe('error');
    expect(anon?.problem).toBe('urn:lazytax:problem:unauthenticated');
    expect(anon?.sub ?? null).toBeNull();

    const missing = byRequestId(requestIds.missing ?? 'none')[0];
    expect(missing?.status).toBe(404);
    expect(missing?.level).toBe('error');
    expect(missing?.problem).toStartWith('urn:lazytax:problem:');
  });

  it('should log an MCP tools/call with its tool name', () => {
    const line = byRequestId(requestIds['mcp-call'] ?? 'none').find(l => l.tool !== undefined);
    expect(line).toBeDefined();
    expect(line?.tool).toBe(requestIds.toolName as string);
    expect(line?.sub).toBe(SUB);
    expect(typeof line?.status).toBe('number');
    expect(typeof line?.durationMs).toBe('number');
  });

  it('should not contain a token, an email or a request body anywhere', () => {
    const raw = readFileSync(logFile, 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(tokenRaw);
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]{5,}\./);
    expect(raw.toLowerCase()).not.toContain('bearer ey');
    expect(raw).not.toContain(EMAIL);
    expect(raw).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(raw).not.toContain(BODY_MARKER);
  });
});
