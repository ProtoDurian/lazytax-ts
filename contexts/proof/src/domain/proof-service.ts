// Binding a habit to a proof plugin (LazyTax Domain/Proof/Service.cs).
import { notFound, Owner, type UnitOfWork } from '@lazytax/kernel';
import type { BindingRepository } from '../data/binding-repository';
import type { HabitPort, PlanPort, PluginManifest, ProofBinding } from './model';
import { invalidBinding } from './plugin';
import type { ProofPluginRegistry } from './registry';

function userOf(owner: Owner): string {
  if (owner.kind !== 'user') throw new Error('binding a proof needs Owner.user');
  return owner.userId;
}

export class ProofService {
  constructor(
    private readonly registry: ProofPluginRegistry,
    private readonly repo: BindingRepository,
    private readonly habit: HabitPort,
    private readonly plan: PlanPort,
    private readonly uow: UnitOfWork,
  ) {}

  listPlugins(): PluginManifest[] {
    return this.registry.list();
  }

  // The habit's binding; null when it only has the always-bound proofs. 404 for a habit that is not Owner's.
  async getBinding(owner: Owner, habitId: string): Promise<ProofBinding | null> {
    await this.ensureOwned(owner, habitId);
    return this.repo.getForHabit(owner, habitId);
  }

  // Validates the settings, checks the user's tier, then binds, replacing the habit's binding.
  async bind(owner: Owner, habitId: string, pluginKey: string, settings: string): Promise<ProofBinding> {
    const userId = userOf(owner);
    await this.ensureOwned(owner, habitId);

    const plugin = this.registry.get(pluginKey);
    if (!plugin) throw notFound('Proof plugin', pluginKey);
    if (plugin.manifest.alwaysBound)
      throw invalidBinding({ pluginKey: [`'${pluginKey}' is always available and can't be bound`] });

    const normalized = plugin.validateSettings(settings);
    if (plugin.manifest.minTier) await this.plan.ensureTier(userId, plugin.manifest.minTier);

    return this.uow.run(async () => {
      await this.uow.lockUser(userId);
      // Rebinding (another plugin or new settings) unbinds the old one first.
      const existing = await this.repo.getForHabit(owner, habitId);
      if (existing) await this.unbindPlugin(existing);
      await plugin.onBind({
        id: existing?.id ?? '',
        habitId,
        userId,
        pluginKey,
        pluginVersion: plugin.manifest.version,
        settings: normalized,
      });
      return this.repo.upsert(owner, habitId, {
        pluginKey,
        pluginVersion: plugin.manifest.version,
        settings: normalized,
      });
    });
  }

  // false when the habit has no binding.
  async unbind(owner: Owner, habitId: string): Promise<boolean> {
    await this.ensureOwned(owner, habitId);
    return this.uow.run(async () => {
      const existing = await this.repo.getForHabit(owner, habitId);
      if (!existing) return false;
      await this.unbindPlugin(existing);
      return this.repo.delete(owner, habitId);
    });
  }

  // Habits that were deleted have nothing left to prove: drop their bindings.
  async releaseHabits(userId: string, habitIds: string[]): Promise<void> {
    const owner = Owner.user(userId);
    for (const habitId of habitIds) {
      const existing = await this.repo.getForHabit(owner, habitId);
      if (!existing) continue;
      await this.unbindPlugin(existing);
      await this.repo.delete(owner, habitId);
    }
  }

  // A binding whose plugin was removed from the app has nothing to clean up.
  private async unbindPlugin(binding: ProofBinding): Promise<void> {
    await this.registry.get(binding.pluginKey)?.onUnbind(binding);
  }

  private async ensureOwned(owner: Owner, habitId: string): Promise<void> {
    const habit = await this.habit.current(userOf(owner), habitId);
    if (!habit) throw notFound('Habit', habitId);
  }
}
