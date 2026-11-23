// Layer 4: who a repository read or write is scoped to.
//
// A repository method that reads or changes user data takes an `Owner` as its FIRST argument
// and puts `ownerFilter(owner, column)` in its WHERE clause. There is no "null means everyone":
// to read across users, an admin route passes `Owner.anyone(principal)` explicitly, and that
// throws unless the principal really is an admin. (nitroso's `userId == null` is the bug this
// avoids.) `tools/boundaries.ts` checks every repository method has an `owner: Owner` first.
import type { SQL } from 'bun';
import type { Principal } from './auth/principal';
import { unauthorized } from './errors';

export type Owner =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'anyone'; readonly by: 'admin' | 'system' };

export const Owner = {
  // The usual case: the row must belong to this user.
  user(userId: string): Owner {
    if (userId === '') throw new Error('Owner.user needs a non-empty user id');
    return Object.freeze({ kind: 'user', userId });
  },
  // Every user's rows. Only an admin principal may ask for this.
  anyone(principal: Principal): Owner {
    if (!principal.isAdmin) throw unauthorized();
    return Object.freeze({ kind: 'anyone', by: 'admin' });
  },
  // Every user's rows, for a kernel worker or an outbox subscriber (no HTTP caller).
  system(): Owner {
    return Object.freeze({ kind: 'anyone', by: 'system' });
  },
};

// `AND <column> = <userId>` for a user, nothing for anyone. Use it inside a Bun.sql query:
//   db`SELECT * FROM vacation.vacation_periods v WHERE v.id = ${id} ${ownerFilter(db, owner, 'v.user_id')}`
// The column is an identifier you write in code, never user input.
export function ownerFilter(db: SQL, owner: Owner, column: string) {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(column)) throw new Error(`ownerFilter: bad column ${column}`);
  if (owner.kind === 'anyone') return db``;
  return db`AND ${db.unsafe(column)} = ${owner.userId}`;
}
