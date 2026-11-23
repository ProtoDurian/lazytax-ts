import { type Owner, ownerFilter, type UnitOfWork } from '@lazytax/kernel';
import type { NfcTag } from '../domain/model';
import { ownerUserId } from './binding-repository';

interface Row {
  id: string;
  user_id: string;
  habit_id: string;
  claimed_at: Date;
}

const toTag = (r: Row): NfcTag => ({ id: r.id, userId: r.user_id, habitId: r.habit_id, claimedAt: r.claimed_at });

export class NfcTagRepository {
  constructor(private readonly uow: UnitOfWork) {}

  // Unclaimed and foreign-owned look identical to the caller: null.
  async get(owner: Owner, tagId: string): Promise<NfcTag | null> {
    const db = this.uow.db();
    const rows = await db<Row[]>`
      SELECT id, user_id, habit_id, claimed_at FROM proof.nfc_tags t
      WHERE t.id = ${tagId} ${ownerFilter(db, owner, 't.user_id')}`;
    return rows[0] ? toTag(rows[0]) : null;
  }

  // Creates the mapping when the tag is unclaimed, re-points it when the caller owns it, and
  // returns null when another user owns it (first come, first served). One statement, so two users
  // racing for an unclaimed tag cannot both win.
  async link(owner: Owner, tagId: string, habitId: string): Promise<NfcTag | null> {
    const userId = ownerUserId(owner);
    const rows = await this.uow.db()<Row[]>`
      INSERT INTO proof.nfc_tags (id, user_id, habit_id) VALUES (${tagId}, ${userId}, ${habitId})
      ON CONFLICT (id) DO UPDATE SET habit_id = EXCLUDED.habit_id
      WHERE proof.nfc_tags.user_id = ${userId}
      RETURNING id, user_id, habit_id, claimed_at`;
    return rows[0] ? toTag(rows[0]) : null;
  }

  // false when the owner has no such tag.
  async unlink(owner: Owner, tagId: string): Promise<boolean> {
    const db = this.uow.db();
    const rows = await db<{ id: string }[]>`
      DELETE FROM proof.nfc_tags t WHERE t.id = ${tagId} ${ownerFilter(db, owner, 't.user_id')} RETURNING id`;
    return rows.length > 0;
  }

  // Habits of the owner that have at least one tag linked.
  async listTaggedHabits(owner: Owner): Promise<string[]> {
    const db = this.uow.db();
    const rows = await db<{ habit_id: string }[]>`
      SELECT DISTINCT habit_id FROM proof.nfc_tags t WHERE true ${ownerFilter(db, owner, 't.user_id')}
      ORDER BY habit_id`;
    return rows.map(r => r.habit_id);
  }

  // A deleted habit releases its tags, so they can be claimed again.
  async deleteForHabits(owner: Owner, habitIds: string[]): Promise<number> {
    if (habitIds.length === 0) return 0;
    const db = this.uow.db();
    const rows = await db<{ id: string }[]>`
      DELETE FROM proof.nfc_tags t
      WHERE t.habit_id IN ${db(habitIds)} ${ownerFilter(db, owner, 't.user_id')} RETURNING id`;
    return rows.length;
  }

  async purgeUser(userId: string): Promise<void> {
    await this.uow.db()`DELETE FROM proof.nfc_tags WHERE user_id = ${userId}`;
  }
}
