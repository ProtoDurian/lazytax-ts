// Plants one breach per rule in a throwaway repo tree and proves tools/boundaries.ts catches each,
// while a clean context passes.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { checkBoundaries } from '../../tools/boundaries';

const root = resolve(import.meta.dir, `../../.tmp-boundaries-${process.pid}`);

const put = (path: string, text: string) => {
  const p = join(root, path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

const yaml = (name: string, needs: string[] = [], uses = ['postgres.main']) =>
  `id: ctx_${name}0000\nname: ${name}\nneeds: [${needs.join(', ')}]\nprovides: [${name}.v1]\nuses: [${uses.join(', ')}]\n`;
const pkg = (name: string, deps: string[] = []) =>
  JSON.stringify({
    name: `@lazytax/${name}`,
    dependencies: Object.fromEntries(['@lazytax/kernel', ...deps].map(d => [d, 'workspace:*'])),
  });

beforeAll(() => {
  put('dependency.yaml', 'postgres.main:\n  kind: postgres\n');
  // clean: a good context.
  put('contexts/clean/context.yaml', yaml('clean', ['other.v1']));
  put('contexts/clean/package.json', pkg('clean', ['@lazytax/other-contract']));
  put('contexts/clean/contract/v1/index.ts', 'export interface CleanV1 { ping(): Promise<void> }\n');
  put(
    'contexts/clean/src/register.ts',
    "import '@lazytax/other-contract/v1';\nimport { defineContext } from '@lazytax/kernel';\nexport default defineContext({ build: () => ({ users: { purgeUser: async () => {} } }) });\n",
  );
  put(
    'contexts/clean/src/data/migrations/0001.sql',
    'CREATE TABLE clean.rows (id uuid, user_id text NOT NULL);\n-- fed from other.v1 events, from other.things\n',
  );
  put(
    'contexts/clean/src/data/repo.ts',
    "import { type Owner } from '@lazytax/kernel';\nexport class Repo {\n  async get(owner: Owner, id: string) { return [owner, id, 'user_id']; }\n  async purgeUser(userId: string) { return userId; }\n}\n",
  );
  put(
    'contexts/clean/tests/integration/x.test.ts',
    "import { startTestApp } from '@lazytax/kernel/testing';\nvoid startTestApp;\n",
  );
  // other: holds every breach.
  put('contexts/other/context.yaml', yaml('other', [], ['redis.cache']));
  put('contexts/other/package.json', pkg('other'));
  put('contexts/other/contract/v1/index.ts', 'export const LIMIT = 3;\nexport interface OtherV1 {}\n');
  put(
    'contexts/other/src/register.ts',
    "import { x } from '../../clean/src/data/repo';\nimport '@lazytax/clean';\nimport { y } from 'left-pad';\nimport { startTestApp } from '@lazytax/kernel/testing';\nimport { uow } from '@lazytax/kernel/db/uow';\n",
  );
  put(
    'contexts/other/src/data/migrations/0001.sql',
    'CREATE TABLE other.rows (user_id text);\nSELECT * FROM clean.rows;\n',
  );
  put(
    'contexts/other/src/data/repo.ts',
    'export class Repo {\n  async getById(id: string) { return [id, "user_id"]; }\n}\n',
  );
  put('src/kernel/boot.ts', "import ctx from '../../contexts/clean/src/register';\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('boundaries', () => {
  it('should pass a clean context', () => {
    // Act
    const breaches = checkBoundaries(root).filter(b => b.file.startsWith('contexts/clean'));

    // Assert
    expect(breaches).toEqual([]);
  });

  it('should catch every planted breach', () => {
    // Act
    const breaches = checkBoundaries(root);
    const has = (rule: string, text: string) => breaches.some(b => b.rule === rule && b.message.includes(text));

    // Assert
    expect(has('imports', 'outside contexts/other')).toBe(true);
    expect(has('imports', "another context's internals")).toBe(true);
    expect(has('imports', 'npm package "left-pad"')).toBe(true);
    expect(has('imports', 'outside tests/')).toBe(true);
    expect(has('imports', 'a kernel internal')).toBe(true);
    expect(has('contract', 'exports a const')).toBe(true);
    expect(has('owner', 'getById(id: string)')).toBe(true);
    expect(has('purge', 'registers no users.purgeUser')).toBe(true);
    expect(has('sql', 'schema "clean"')).toBe(true);
    expect(has('uses', '"redis.cache"')).toBe(true);
    expect(has('kernel', 'must never import a context')).toBe(true);
  });
});
