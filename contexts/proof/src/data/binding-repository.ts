import { type Owner, ownerFilter, type UnitOfWork } from '@lazytax/kernel';
import type { BindingRecord, ProofBinding } from '../domain/model';

interface Row {
  id: string;
  user_id: string;
  habit_id: string;
  plugin_key: string;
  plugin_version: number;
  settings: string;
}

const toBinding = (r: Row): ProofBinding => ({
  id: r.id,
  userId: r.user_id,
  habitId: r.habit_id,
  pluginKey: r.plugin_key,
  pluginVersion: r.plugin_version,
  settings: r.settings,
});

export class BindingRepository {
  constructor(private readonly uow: UnitOfWork) {}

  // The binding of a habit, or null when it only has the always-bound proofs.
  async getForHabit(owner: Owner, habitId: string): Promise<ProofBinding | null> {
    const db = this.uow.db();
    const rows = await db<Row[]>`
      SELECT id, user_id, habit_id, plugin_key, plugin_version, settings
      FROM proof.proof_bindings b
      WHERE b.habit_id = ${habitId} ${ownerFilter(db, owner, 'b.user_id')}`;
    return rows[0] ? toBinding(rows[0]) : null;
  }

  // The user's habits bound to the plugin.
  async listForPlugin(owner: Owner, pluginKey: string): Promise<ProofBinding[]> {
    const db = this.uow.db();
    const rows = await db<Row[]>`
      SELECT id, user_id, habit_id, plugin_key, plugin_version, settings
      FROM proof.proof_bindings b
      WHERE b.plugin_key = ${pluginKey} ${ownerFilter(db, owner, 'b.user_id')}
      ORDER BY b.created_at, b.id`;
    return rows.map(toBinding);
  }

  // habitId -> bound plugin key.
  async listPluginKeys(owner: Owner): Promise<Record<string, string>> {
    const db = this.uow.db();
    const rows = await db<{ habit_id: string; plugin_key: string }[]>`
      SELECT habit_id, plugin_key FROM proof.proof_bindings b
      WHERE true ${ownerFilter(db, owner, 'b.user_id')}`;
    return Object.fromEntries(rows.map(r => [r.habit_id, r.plugin_key]));
  }

  // Binds the habit, replacing its existing binding (one per habit). The row keeps the first
  // binder's id; a habit that belongs to another user cannot be re-pointed.
  async upsert(owner: Owner, habitId: string, record: BindingRecord): Promise<ProofBinding> {
    const userId = ownerUserId(owner);
    const db = this.uow.db();
    const rows = await db<Row[]>`
      INSERT INTO proof.proof_bindings (user_id, habit_id, plugin_key, plugin_version, settings)
      VALUES (${userId}, ${habitId}, ${record.pluginKey}, ${record.pluginVersion}, ${record.settings})
      ON CONFLICT (habit_id) DO UPDATE SET
        plugin_key = EXCLUDED.plugin_key, plugin_version = EXCLUDED.plugin_version,
        settings = EXCLUDED.settings, updated_at = now()
      WHERE proof.proof_bindings.user_id = ${userId}
      RETURNING id, user_id, habit_id, plugin_key, plugin_version, settings`;
    if (!rows[0]) throw new Error('habit is bound by another user');
    return toBinding(rows[0]);
  }

  // false when the habit had no binding.
  async delete(owner: Owner, habitId: string): Promise<boolean> {
    const db = this.uow.db();
    const rows = await db<{ id: string }[]>`
      DELETE FROM proof.proof_bindings b
      WHERE b.habit_id = ${habitId} ${ownerFilter(db, owner, 'b.user_id')}
      RETURNING id`;
    return rows.length > 0;
  }

  // Deletes the plugin's bindings for one user (Strava disconnect). Returns the habit ids.
  async deleteForPlugin(owner: Owner, pluginKey: string): Promise<string[]> {
    const db = this.uow.db();
    const rows = await db<{ habit_id: string }[]>`
      DELETE FROM proof.proof_bindings b
      WHERE b.plugin_key = ${pluginKey} ${ownerFilter(db, owner, 'b.user_id')}
      RETURNING habit_id`;
    return rows.map(r => r.habit_id);
  }

  // The purge hook is the one method that takes a bare userId.
  async purgeUser(userId: string): Promise<void> {
    await this.uow.db()`DELETE FROM proof.proof_bindings WHERE user_id = ${userId}`;
  }
}

export function ownerUserId(owner: Owner): string {
  if (owner.kind !== 'user') throw new Error('this write needs Owner.user');
  return owner.userId;
}
