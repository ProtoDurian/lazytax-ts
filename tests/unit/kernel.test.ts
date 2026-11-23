import { describe, expect, it } from 'bun:test';
import { deepMerge, orderContexts } from '../../src/kernel/boot';
import { scrub } from '../../src/kernel/log';
import { ContextError } from '../../src/kernel/manifest';

const ctx = (name: string, needs: string[] = []) => ({
  folder: `contexts/${name}`,
  manifest: { id: `ctx_${name}000`, name, needs, provides: [`${name}.v1`], uses: [] },
});

describe('orderContexts', () => {
  it('should build every context after the contracts it needs', () => {
    // Arrange
    const items = [ctx('vacation', ['account.v1', 'plan.v1']), ctx('plan', ['account.v1']), ctx('account')];

    // Act
    const order = orderContexts(items).map(c => c.manifest.name);

    // Assert
    expect(order).toEqual(['account', 'plan', 'vacation']);
  });

  it('should refuse a cycle and name the contexts in it', () => {
    // Arrange
    const items = [ctx('a', ['b.v1']), ctx('b', ['c.v1']), ctx('c', ['a.v1'])];

    // Act
    const act = () => orderContexts(items);

    // Assert
    expect(act).toThrow(ContextError);
    expect(act).toThrow(/cycle: a -> b -> c -> a/);
  });

  it('should refuse a need nobody provides, naming the context and its folder', () => {
    // Arrange
    const items = [ctx('habit', ['charity.v1'])];

    // Act
    const act = () => orderContexts(items);

    // Assert
    expect(act).toThrow('context "habit" (contexts/habit): needs "charity.v1" but no context provides it');
  });
});

describe('deepMerge', () => {
  it('should override one nested field and keep the rest', () => {
    // Act
    const out = deepMerge({ tiers: { free: { a: 1, b: 2 }, pro: { a: 3 } } }, { tiers: { free: { b: 9 } } });

    // Assert
    expect(out).toEqual({ tiers: { free: { a: 1, b: 9 }, pro: { a: 3 } } });
  });
});

describe('log scrub', () => {
  it('should remove tokens and emails from any logged string', () => {
    // Arrange
    const line = 'Bearer abc.def.ghi for eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl me@example.com';

    // Act
    const out = scrub(line);

    // Assert
    expect(out).not.toContain('me@example.com');
    expect(out).not.toContain('eyJ');
    expect(out).not.toContain('abc.def.ghi');
  });
});
