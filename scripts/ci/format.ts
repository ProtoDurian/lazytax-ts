// Format check for CI without Nix: prettier (the repo .prettierrc) over yaml and json, plus our own docs.
// Pinned exactly; the same files treefmt formats locally, minus nix and shell files.
const PRETTIER = 'prettier@3.6.2';
const p = Bun.spawn(
  [
    'bunx',
    PRETTIER,
    '--check',
    '**/*.{yaml,yml,json}',
    'docs/sit.md',
    '!**/node_modules/**',
    '!**/bun.lock',
    '!coverage/**',
    '!reports/**',
    '!dist/**',
    '!Changelog.md',
    '!tests/sit*/**/*.bru',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
);
process.exit(await p.exited);
