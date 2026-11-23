// contexts/<name>/context.yaml: the wiring file. Validated at start; a broken one stops the app
// before it listens, with one message naming the context, its folder, the problem and the fix.
//
//   id: ctx_7f3k2q                 # random, never changes
//   name: vacation                 # = the folder name
//   needs: [account.v1, plan.v1]   # contracts it calls (ordering: no cycles)
//   provides: [vacation.v1]        # contracts it implements ("<name>.v<N>")
//   uses: [postgres.main]          # infrastructure; each must be listed in /dependency.yaml
//   http: { prefix: /api/v1/Vacation }
//   mcp: { prefix: vacation }
import { z } from 'zod';

const CONTRACT = /^[a-z][a-z0-9]*\.v[1-9][0-9]*$/;

export const ManifestSchema = z.strictObject({
  id: z.string().regex(/^ctx_[a-z0-9]{6,}$/, 'must look like ctx_7f3k2q (ctx_ + 6 or more lowercase letters/digits)'),
  name: z.string().regex(/^[a-z][a-z0-9]*$/, 'must be lowercase letters and digits, starting with a letter'),
  needs: z.array(z.string().regex(CONTRACT, 'each need must look like plan.v1')).default([]),
  provides: z.array(z.string().regex(CONTRACT, 'each contract must look like vacation.v1')).default([]),
  uses: z.array(z.string().min(1)).default([]),
  http: z
    .strictObject({
      // Usually one controller: /api/v1/Vacation. A context that owns several (account: User and
      // Configuration) uses /api/v1 and starts each route path with its controller. Two routes
      // with the same method and full path anywhere in the app fail the start.
      prefix: z
        .string()
        .regex(/^\/api\/v[0-9]+(\/[A-Za-z][A-Za-z0-9-]*)?$/, 'must look like /api/v1/Vacation or /api/v1'),
    })
    .optional(),
  mcp: z
    .strictObject({ prefix: z.string().regex(/^[a-z][a-z0-9]*$/, 'must be lowercase letters and digits') })
    .optional(),
});

export type Manifest = z.output<typeof ManifestSchema>;

// The one error type for a broken context. The kernel prints `message` and exits non-zero.
export class ContextError extends Error {
  constructor(
    readonly context: string,
    readonly folder: string,
    readonly problem: string,
    readonly fix: string,
  ) {
    super(`context "${context}" (${folder}): ${problem}. Fix: ${fix}`);
    this.name = 'ContextError';
  }
}
