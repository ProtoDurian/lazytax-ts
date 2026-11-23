import { describe, expect, it } from 'bun:test';
import { Owner, Problem } from '@lazytax/kernel';
import type { InboxRepository } from '../../src/data/inbox-repository';
import { InboxService } from '../../src/domain/inbox-service';
import type { InboxRecord, InboxRow, InboxSearch } from '../../src/domain/model';

// A repository fake that keeps rows in memory and honours the owner like the SQL does.
class FakeRepo {
  rows: (InboxRow & { userId: string; dedupeKey: string | null })[] = [];
  lastSearch: InboxSearch | null = null;

  async create(owner: Owner, record: InboxRecord, at: Date): Promise<InboxRow> {
    if (owner.kind !== 'user') throw new Error('user only');
    const dup = record.dedupeKey
      ? this.rows.find(r => r.userId === owner.userId && r.dedupeKey === record.dedupeKey)
      : undefined;
    if (dup) return dup;
    const row = {
      id: crypto.randomUUID(),
      userId: owner.userId,
      kind: record.kind,
      title: record.title,
      body: record.body,
      actorUserId: record.actorUserId,
      data: record.data,
      dedupeKey: record.dedupeKey,
      createdAtUtc: at.toISOString(),
      readAtUtc: null,
    };
    this.rows.push(row);
    return row;
  }

  async search(_owner: Owner, search: InboxSearch): Promise<InboxRow[]> {
    this.lastSearch = search;
    return [];
  }

  async unreadCount(): Promise<number> {
    return 0;
  }

  async markRead(owner: Owner, id: string): Promise<boolean> {
    return this.rows.some(r => r.id === id && owner.kind === 'user' && r.userId === owner.userId);
  }

  async markAllRead(): Promise<number> {
    return 0;
  }
}

const clock = { now: () => new Date('2026-03-01T00:00:00Z') };
const make = () => {
  const repo = new FakeRepo();
  return { repo, svc: new InboxService(repo as unknown as InboxRepository, clock) };
};
const ownerA = Owner.user('user-a');

describe('InboxService.post', () => {
  it('should store data as JSON text and stamp the kernel clock', async () => {
    // Arrange
    const { svc } = make();
    // Act
    const row = await svc.post(ownerA, {
      kind: 'friend_missed',
      title: 'Sam missed a habit',
      body: 'Run',
      data: { habitId: 'h1', date: '2026-01-05' },
    });
    // Assert
    expect(row.data).toBe('{"habitId":"h1","date":"2026-01-05"}');
    expect(row.createdAtUtc).toBe('2026-03-01T00:00:00.000Z');
    expect(row.actorUserId).toBeNull();
  });

  it('should record a repeated dedupe key once', async () => {
    const { repo, svc } = make();
    const first = await svc.post(ownerA, { kind: 'k', title: 't', body: 'b', dedupeKey: 'e1' });
    const second = await svc.post(ownerA, { kind: 'k', title: 't', body: 'b', dedupeKey: 'e1' });
    expect(second.id).toBe(first.id);
    expect(repo.rows).toHaveLength(1);
  });

  it('should reject an empty or oversized title and body with 400 per field', async () => {
    const { svc } = make();
    const err = await svc.post(ownerA, { kind: 'k', title: ' ', body: 'x'.repeat(1025) }).catch(e => e);
    expect(err).toBeInstanceOf(Problem);
    expect(err.status).toBe(400);
    expect(Object.keys(err.data.errors)).toEqual(['title', 'body']);
  });

  it('should reject data over 2048 characters', async () => {
    const { svc } = make();
    const err = await svc
      .post(ownerA, { kind: 'k', title: 't', body: 'b', data: { x: 'y'.repeat(2048) } })
      .catch(e => e);
    expect(err.status).toBe(400);
    expect(Object.keys(err.data.errors)).toEqual(['data']);
  });
});

describe('InboxService.search', () => {
  it('should default to 20 per page from the newest, all notifications', async () => {
    const { repo, svc } = make();
    await svc.search(ownerA, {});
    expect(repo.lastSearch).toEqual({ unreadOnly: false, limit: 20, skip: 0 });
  });

  it.each([0, 51, 1.5])('should reject limit %p with 400', async limit => {
    const { svc } = make();
    const err = await (async () => svc.search(ownerA, { limit }))().catch(e => e);
    expect(err.status).toBe(400);
    expect(err.data.errors.limit).toBeDefined();
  });

  it('should reject a negative skip with 400', async () => {
    const { svc } = make();
    const err = await (async () => svc.search(ownerA, { skip: -1 }))().catch(e => e);
    expect(err.status).toBe(400);
    expect(err.data.errors.skip).toBeDefined();
  });
});

describe('InboxService.markRead', () => {
  it("should 404 when the notification is not the owner's", async () => {
    const { svc } = make();
    const row = await svc.post(ownerA, { kind: 'k', title: 't', body: 'b' });
    const err = await svc.markRead(Owner.user('user-b'), row.id).catch(e => e);
    expect(err.status).toBe(404);
    expect(err.id).toBe('entity_not_found');
  });

  it('should 404 on an id that is not a uuid, without asking the repository', async () => {
    const { svc } = make();
    const err = await svc.markRead(ownerA, 'nope').catch(e => e);
    expect(err.status).toBe(404);
  });

  it("should pass for the owner's own notification", async () => {
    const { svc } = make();
    const row = await svc.post(ownerA, { kind: 'k', title: 't', body: 'b' });
    await svc.markRead(ownerA, row.id);
  });
});
