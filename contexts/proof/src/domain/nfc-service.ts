// NFC tags (LazyTax Domain/NfcTag + App/Modules/NfcTag/NfcTagService.cs).

import type { Clock } from '@lazytax/kernel';
import { conflict, notFound, Owner } from '@lazytax/kernel';
import type { NfcTagRepository } from '../data/nfc-repository';
import { NFC_KEY } from '../plugins/nfc';
import type { AccountPort, CheckPort, HabitPort, HabitVersionView, NfcTag, Outcome } from './model';
import type { ProofRouter } from './router';

export interface NfcResolution {
  tag: NfcTag;
  habitVersion: HabitVersionView['version'];
  today: string;
  todayExecution: unknown | null;
}

const userOf = (owner: Owner): string => {
  if (owner.kind !== 'user') throw new Error('NFC tags need Owner.user');
  return owner.userId;
};

export class NfcTagService {
  constructor(
    private readonly repo: NfcTagRepository,
    private readonly habit: HabitPort,
    private readonly account: AccountPort,
    private readonly check: CheckPort,
    private readonly router: ProofRouter,
    private readonly clock: Clock,
  ) {}

  // Create-or-replace the tag -> habit mapping. Creates it when the tag is unclaimed, updates it
  // when the caller already owns it, and 409 when another user owns it (first come, first served).
  async link(owner: Owner, tagId: string, habitId: string): Promise<NfcTag> {
    if (!(await this.habit.current(userOf(owner), habitId))) throw notFound('Habit', habitId);
    const tag = await this.repo.link(owner, tagId, habitId);
    if (!tag) throw conflict('entity_conflict', 'NFC tag is already linked by another user');
    return tag;
  }

  // The tag's habit (current version) and today's execution. null (404) when the tag is unclaimed
  // or owned by another user: ownership is never leaked.
  async resolve(owner: Owner, tagId: string): Promise<NfcResolution | null> {
    const userId = userOf(owner);
    const tag = await this.repo.get(owner, tagId);
    if (!tag) return null;
    const hv = await this.habit.current(userId, tag.habitId);
    if (!hv) return null;
    // "Today" is the user's day (their timezone follows the phone), not the habit's.
    const today = await this.account.today(userId);
    return {
      tag,
      habitVersion: hv.version,
      today,
      todayExecution: await this.check.executionForDate(userId, tag.habitId, today),
    };
  }

  async unlink(owner: Owner, tagId: string): Promise<boolean> {
    return this.repo.unlink(owner, tagId);
  }

  // A tap on a linked tag: proof of the tag's habit through the router. 404 for a tag that is not Owner's.
  async tap(owner: Owner, tagId: string): Promise<Outcome[]> {
    const userId = userOf(owner);
    const tag = await this.repo.get(owner, tagId);
    if (!tag) throw notFound('NFC Tag', tagId);
    const at = this.clock.now();
    return this.router.route({
      pluginKey: NFC_KEY,
      userId,
      externalId: `${tag.id}:${at.toISOString()}`,
      occurredAt: at,
      habitId: tag.habitId,
      payload: { tagId: tag.id },
    });
  }

  async releaseHabits(userId: string, habitIds: string[]): Promise<void> {
    await this.repo.deleteForHabits(Owner.user(userId), habitIds);
  }

  // For the nfc plugin: the tag is the user's and linked to this habit.
  async isLinked(userId: string, tagId: string, habitId: string): Promise<boolean> {
    const tag = await this.repo.get(Owner.user(userId), tagId);
    return tag?.habitId === habitId;
  }
}
