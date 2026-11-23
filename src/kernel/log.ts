// JSON-lines logging to stdout, and to LOG_FILE when it is set.
//
// One line per HTTP request / MCP call is written by the kernel with:
//   time, level, msg, context, route | tool, sub, requestId, status, durationMs (+ problem on errors)
// Never log tokens, emails or bodies. Every string field is scrubbed of JWTs, bearer tokens and
// email addresses before it is written, as a second line of defence.
import { appendFileSync } from 'node:fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  // A logger that adds these fields to every line (the kernel gives each context one with `context`).
  child(fields: LogFields): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const BEARER = /bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function scrub(value: string): string {
  return value.replace(JWT, '[token]').replace(BEARER, 'Bearer [token]').replace(EMAIL, '[email]');
}

export interface LoggerOptions {
  level?: LogLevel;
  file?: string;
  // For tests: collect lines instead of printing them.
  sink?: (line: string) => void;
}

export function createLogger(opts: LoggerOptions = {}, base: LogFields = {}): Logger {
  const min = ORDER[opts.level ?? 'info'];
  const write = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[level] < min) return;
    const rec: Record<string, unknown> = { time: new Date().toISOString(), level, msg: scrub(msg) };
    for (const [k, v] of Object.entries({ ...base, ...fields })) {
      if (v === undefined) continue;
      rec[k] = typeof v === 'string' ? scrub(v) : v;
    }
    const line = JSON.stringify(rec);
    if (opts.sink) opts.sink(line);
    else process.stdout.write(`${line}\n`);
    if (opts.file) appendFileSync(opts.file, `${line}\n`);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: fields => createLogger(opts, { ...base, ...fields }),
  };
}
