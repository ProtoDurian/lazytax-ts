// One Postgres schema and one SQL folder per context. kernel.migrations records each file's
// checksum; a changed file stops the run (add a new file instead). Runs in `needs` order, under
// a session advisory lock so two replicas never migrate at once.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SQL } from 'bun';
import type { Logger } from '../log';

export interface MigrationSet {
  // The schema, = the context name ("kernel" for the kernel's own).
  schema: string;
  // Absolute folder of *.sql files, or undefined for none.
  dir: string | undefined;
}

class MigrationError extends Error {
  override name = 'MigrationError';
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function listMigrations(dir: string | undefined): { file: string; sql: string; checksum: string }[] {
  if (dir === undefined || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(file => {
      const sql = readFileSync(join(dir, file), 'utf8');
      return { file, sql, checksum: sha(sql) };
    });
}

export async function runMigrations(pool: SQL, sets: MigrationSet[], log: Logger): Promise<number> {
  let applied = 0;
  const reserved = await pool.reserve();
  try {
    await reserved`SELECT pg_advisory_lock(hashtextextended('lazytax.migrate', 0))`;
    await reserved.unsafe(`CREATE SCHEMA IF NOT EXISTS kernel;
      CREATE TABLE IF NOT EXISTS kernel.migrations (
        context text NOT NULL,
        file text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (context, file)
      );`);
    for (const set of sets) {
      if (!/^[a-z][a-z0-9]*$/.test(set.schema)) throw new MigrationError(`bad schema name ${set.schema}`);
      const done = new Map<string, string>();
      for (const r of await reserved`SELECT file, checksum FROM kernel.migrations WHERE context = ${set.schema}`)
        done.set(r.file, r.checksum);
      for (const m of listMigrations(set.dir)) {
        const prev = done.get(m.file);
        if (prev === m.checksum) continue;
        if (prev !== undefined)
          throw new MigrationError(
            `context "${set.schema}": migration ${m.file} changed after it was applied (checksum ${prev.slice(0, 12)} -> ${m.checksum.slice(0, 12)}). Fix: restore the file and add a new migration`,
          );
        await reserved.begin(async tx => {
          await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS "${set.schema}"`);
          await tx.unsafe(m.sql);
          await tx`INSERT INTO kernel.migrations (context, file, checksum) VALUES (${set.schema}, ${m.file}, ${m.checksum})`;
        });
        log.info('migration applied', { context: set.schema, file: m.file });
        applied++;
      }
    }
  } finally {
    await reserved`SELECT pg_advisory_unlock(hashtextextended('lazytax.migrate', 0))`.catch(() => undefined);
    reserved.release();
  }
  return applied;
}
