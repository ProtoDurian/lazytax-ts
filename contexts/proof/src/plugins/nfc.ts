import { z } from '@lazytax/kernel';
import { definePlugin } from '../domain/plugin';

export const NFC_KEY = 'nfc';

// What the plugin needs to know about tags; the NFC repository answers it.
export interface TagLookup {
  // True when the tag is the user's and linked to this habit.
  isLinked(userId: string, tagId: string, habitId: string): Promise<boolean>;
}

// A tap on a linked tag proves the habit. Always available on every habit that has a tag linked
// (LazyTax let the app resolve the tag and then press Complete; now the tap is a proof of its own).
// The event carries the tag id and targets one habit.
export const nfcPlugin = (tags: TagLookup) =>
  definePlugin({
    manifest: { key: NFC_KEY, name: 'NFC tap', version: 1, platforms: ['ios', 'android'], alwaysBound: true },
    payload: z.object({ tagId: z.string().default('') }),
    evaluate: async (_settings, payload, e) => {
      if (!e.habitId || payload.tagId === '') return null;
      return (await tags.isLinked(e.userId, payload.tagId, e.habitId)) ? { verdict: 'passed' } : null;
    },
  });
