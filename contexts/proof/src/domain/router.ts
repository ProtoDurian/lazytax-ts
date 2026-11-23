// The one way in for every proof source (LazyTax Domain/Proof/Router.cs): evaluates the event for
// each habit it can prove and reports each verdict to check as evidence.

import type { Clock } from '@lazytax/kernel';
import { notFound, Owner, Problem, type UnitOfWork } from '@lazytax/kernel';
import type { BindingRepository } from '../data/binding-repository';
import type { CheckPort, Outcome, ProofBinding, ProofEvent, ProofWindow } from './model';
import type { ProofPluginRegistry } from './registry';

export class ProofRouter {
  constructor(
    private readonly registry: ProofPluginRegistry,
    private readonly bindings: BindingRepository,
    private readonly check: CheckPort,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  route(e: ProofEvent): Promise<Outcome[]> {
    // One unit of work, so every habit's evidence lands together; joins the caller's when one is open.
    return this.uow.run(() => this.routeInUnit(e));
  }

  private async routeInUnit(e: ProofEvent): Promise<Outcome[]> {
    const now = this.clock.now();
    const plugin = this.registry.get(e.pluginKey);
    if (!plugin) throw notFound('Proof plugin', e.pluginKey);
    // The event's user is trusted (a worker or another context built it); every read is scoped to it.
    const owner = Owner.user(e.userId);

    let targets: { habitId: string; binding: ProofBinding | null }[];
    if (e.habitId) {
      // An always-bound plugin (manual, nfc) proves any habit of the user; check refuses a habit
      // that is not theirs. Any other plugin only proves the habit if it is bound to it.
      if (plugin.manifest.alwaysBound) targets = [{ habitId: e.habitId, binding: null }];
      else {
        const binding = await this.bindings.getForHabit(owner, e.habitId);
        if (!binding || binding.pluginKey !== e.pluginKey) return [];
        targets = [{ habitId: e.habitId, binding }];
      }
    } else {
      const bound = await this.bindings.listForPlugin(owner, e.pluginKey);
      targets = bound.map(b => ({ habitId: b.habitId, binding: b }));
    }

    const outcomes: Outcome[] = [];
    for (const { habitId, binding } of targets) {
      let window: ProofWindow | null;
      try {
        window = await this.check.pendingCheckAt(e.userId, habitId, e.occurredAt, now);
      } catch (err) {
        // One disabled or deleted habit must not stop the others; a targeted event still gets its 404.
        if (!e.habitId && err instanceof Problem && err.kind === 'not_found') window = null;
        else throw err;
      }
      // That moment's day is settled, unscheduled or over: a replay or a late event.
      if (!window) {
        outcomes.push({ habitId, executionId: null });
        continue;
      }
      const verdict = await plugin.evaluate(binding, e, window);
      if (!verdict) {
        outcomes.push({ habitId, executionId: null });
        continue;
      }
      const executionId = await this.check.report(
        e.userId,
        habitId,
        {
          proofKey: e.pluginKey,
          externalId: e.externalId,
          verdict: verdict.verdict,
          occurredAt: e.occurredAt,
          data: verdict.data === undefined ? null : JSON.stringify(verdict.data),
          notes: e.notes ?? null,
        },
        now,
      );
      outcomes.push({ habitId, executionId });
    }
    return outcomes;
  }
}
