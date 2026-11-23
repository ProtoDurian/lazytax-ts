import { describe, expect, it } from 'bun:test';
import { Problem } from '@lazytax/kernel';
import { mergeOrder } from '../../src/domain/habit-order';

describe('mergeOrder', () => {
  it('should put the requested ids first, then the rest in their current order', () => {
    expect(mergeOrder(['a', 'b', 'c', 'd'], ['c', 'a'])).toEqual(['c', 'a', 'b', 'd']);
  });
  it('should keep the order when nothing is requested', () => {
    expect(mergeOrder(['a', 'b'], [])).toEqual(['a', 'b']);
  });
  it('should refuse an id listed twice', () => {
    expect(() => mergeOrder(['a', 'b'], ['a', 'a'])).toThrow(Problem);
  });
  it("should refuse an id that is not one of the user's habits", () => {
    try {
      mergeOrder(['a'], ['zzz']);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(Problem);
      expect((e as Problem).status).toBe(400);
    }
  });
});
