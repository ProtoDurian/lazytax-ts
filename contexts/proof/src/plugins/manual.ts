import { definePlugin } from '../domain/plugin';

// The Complete button. Always available on every habit, even one bound to another proof, and
// always passes (LazyTax Domain/Proof/ManualProofPlugin.cs).
export const MANUAL_KEY = 'manual';

export const manualPlugin = definePlugin({
  manifest: { key: MANUAL_KEY, name: 'Check in', version: 1, platforms: ['ios', 'android'], alwaysBound: true },
  evaluate: () => ({ verdict: 'passed' }),
});
