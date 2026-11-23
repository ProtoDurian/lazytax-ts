import { describe, expect, it } from 'bun:test';
import { notFound, Problem, type UnitOfWork } from '@lazytax/kernel';
import type { BindingRepository } from '../../src/data/binding-repository';
import type { CheckPort, ProofBinding, ProofWindow } from '../../src/domain/model';
import { ProofPluginRegistry } from '../../src/domain/registry';
import { ProofRouter } from '../../src/domain/router';
import { manualPlugin } from '../../src/plugins/manual';
import { stravaPlugin } from '../../src/plugins/strava';

const window: ProofWindow = {
  localDate: '2026-03-01',
  timezone: 'UTC',
  opensAt: new Date('2026-03-01T00:00:00Z'),
  deadline: new Date('2026-03-01T23:59:00Z'),
};
const bound = (habitId: string): ProofBinding => ({
  id: `b-${habitId}`,
  habitId,
  userId: 'u1',
  pluginKey: 'strava',
  pluginVersion: 1,
  settings: '{"sportTypes":["Run"]}',
});

function setup(opts: { bindings?: ProofBinding[]; open?: Set<string>; missing?: Set<string> } = {}) {
  const reports: { habitId: string; proofKey: string; verdict: string }[] = [];
  const bindings = {
    getForHabit: async (_o: unknown, h: string) => opts.bindings?.find(b => b.habitId === h) ?? null,
    listForPlugin: async () => opts.bindings ?? [],
  } as unknown as BindingRepository;
  const check: CheckPort = {
    pendingCheckAt: async (_u, h) => {
      if (opts.missing?.has(h)) throw notFound('Habit', h);
      return (opts.open ?? new Set([h])).has(h) ? window : null;
    },
    report: async (_u, habitId, e) => {
      reports.push({ habitId, proofKey: e.proofKey, verdict: e.verdict });
      return `x-${habitId}`;
    },
    executionForDate: async () => null,
  };
  const uow = { run: <T>(fn: () => Promise<T>) => fn() } as unknown as UnitOfWork;
  const registry = new ProofPluginRegistry([manualPlugin, stravaPlugin({ isConnected: async () => true })]);
  return {
    reports,
    router: new ProofRouter(registry, bindings, check, uow, { now: () => new Date('2026-03-01T12:00:00Z') }),
  };
}

const run = {
  pluginKey: 'strava',
  userId: 'u1',
  externalId: '9',
  occurredAt: new Date('2026-03-01T10:00:00Z'),
  payload: { sportType: 'Run' },
};

describe('proof router', () => {
  it('should report manual proof on any habit without a binding', async () => {
    const { router, reports } = setup();
    const out = await router.route({ ...run, pluginKey: 'manual', habitId: 'h1' });
    expect(out).toEqual([{ habitId: 'h1', executionId: 'x-h1' }]);
    expect(reports).toEqual([{ habitId: 'h1', proofKey: 'manual', verdict: 'passed' }]);
  });

  it('should route an untargeted strava event to every habit bound to it', async () => {
    const { router, reports } = setup({ bindings: [bound('h1'), bound('h2')] });
    const out = await router.route(run);
    expect(out.map(o => o.habitId)).toEqual(['h1', 'h2']);
    expect(reports).toHaveLength(2);
  });

  it('should not prove a targeted habit that is not bound to the plugin', async () => {
    const { router, reports } = setup();
    expect(await router.route({ ...run, habitId: 'h1' })).toEqual([]);
    expect(reports).toHaveLength(0);
  });

  it('should record no execution when the day is already settled or the plugin has no verdict', async () => {
    const settled = setup({ bindings: [bound('h1')], open: new Set() });
    expect(await settled.router.route(run)).toEqual([{ habitId: 'h1', executionId: null }]);
    const swim = setup({ bindings: [bound('h1')] });
    expect(await swim.router.route({ ...run, payload: { sportType: 'Swim' } })).toEqual([
      { habitId: 'h1', executionId: null },
    ]);
    expect(swim.reports).toHaveLength(0);
  });

  it('should skip a disabled habit on an untargeted event but 404 a targeted one', async () => {
    const both = setup({ bindings: [bound('h1'), bound('h2')], missing: new Set(['h1']) });
    expect(await both.router.route(run)).toEqual([
      { habitId: 'h1', executionId: null },
      { habitId: 'h2', executionId: 'x-h2' },
    ]);
    const one = setup({ missing: new Set(['h1']) });
    await expect(one.router.route({ ...run, pluginKey: 'manual', habitId: 'h1' })).rejects.toBeInstanceOf(Problem);
  });

  it('should 404 an unknown plugin', async () => {
    const { router } = setup();
    await expect(router.route({ ...run, pluginKey: 'zzz' })).rejects.toBeInstanceOf(Problem);
  });
});
