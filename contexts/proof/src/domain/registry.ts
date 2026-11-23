import type { PluginManifest } from './model';
import type { ProofPlugin } from './plugin';

// Every plugin the app offers. Adding a plugin is a definePlugin() call plus one entry in register.ts.
export class ProofPluginRegistry {
  private readonly byKey = new Map<string, ProofPlugin>();

  constructor(plugins: ProofPlugin[]) {
    for (const p of plugins) {
      // A duplicate key throws at start rather than routing to an arbitrary plugin.
      if (this.byKey.has(p.manifest.key)) throw new Error(`duplicate proof plugin key '${p.manifest.key}'`);
      this.byKey.set(p.manifest.key, p);
    }
  }

  list(): PluginManifest[] {
    return [...this.byKey.values()].map(p => p.manifest).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  get(key: string): ProofPlugin | undefined {
    return this.byKey.get(key);
  }
}
