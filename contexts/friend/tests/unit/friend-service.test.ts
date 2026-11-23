import { describe, expect, it } from 'bun:test';
import { Owner, Problem } from '@lazytax/kernel';
import type { FriendRepository } from '../../src/data/friend-repository';
import { FriendService, shortDate } from '../../src/domain/friend-service';
import type { FriendRelation, UserDirectory } from '../../src/domain/model';

// An in-memory repository with the same behaviour as the SQL one, for the domain rules.
class FakeRepo {
  requests = new Set<string>(); // "from>to"
  friendships = new Set<string>(); // "a>b" both directions
  watchers = new Map<string, string[]>(); // habitId -> friend ids
  rel(a: string, b: string): FriendRelation {
    return this.friendships.has(`${a}>${b}`)
      ? 'friend'
      : this.requests.has(`${b}>${a}`)
        ? 'incoming'
        : this.requests.has(`${a}>${b}`)
          ? 'outgoing'
          : 'none';
  }
  async relations(o: Owner, ids: string[]) {
    return new Map(ids.map(i => [i, this.rel((o as { userId: string }).userId, i)] as const));
  }
  async relation(o: Owner, other: string) {
    return this.rel((o as { userId: string }).userId, other);
  }
  async createRequest(o: Owner, to: string) {
    this.requests.add(`${(o as { userId: string }).userId}>${to}`);
  }
  async createFriendship(o: Owner, f: string) {
    const u = (o as { userId: string }).userId;
    const created = !this.friendships.has(`${u}>${f}`);
    this.friendships.add(`${u}>${f}`).add(`${f}>${u}`);
    this.requests.delete(`${u}>${f}`);
    this.requests.delete(`${f}>${u}`);
    return { since: new Date('2026-01-01T00:00:00Z'), created };
  }
  async getInvite() {
    return null;
  }
}

const names: Record<string, string> = { a: 'Alice', b: 'bob', c: 'Carol' };
const directory: UserDirectory = {
  usernames: async ids => Object.fromEntries(ids.filter(i => names[i]).map(i => [i, names[i] as string])),
  searchUsers: async () => [],
};

const build = () => {
  const repo = new FakeRepo();
  const events: { type: string; payload: unknown; userId?: string }[] = [];
  const posts: unknown[][] = [];
  const uow = { run: <T>(fn: () => Promise<T>) => fn(), lockUser: async () => {}, db: () => null } as never;
  const svc = new FriendService(
    repo as unknown as FriendRepository,
    directory,
    { getCurrent: async () => null, getVersionsByIds: async () => [{ task: 'Run' }] as never },
    {
      post: async (...args: unknown[]) => {
        posts.push(args);
        return {} as never;
      },
    },
    uow,
    { add: async e => void events.push(e as never) },
  );
  return { repo, svc, events, posts };
};
const A = Owner.user('a');
const B = Owner.user('b');

describe('sendRequest', () => {
  it('should refuse friending yourself with 400', async () => {
    const { svc } = build();
    const err = await svc.sendRequest(A, 'a').catch(e => e);
    expect(err).toBeInstanceOf(Problem);
    expect((err as Problem).status).toBe(400);
  });

  it('should 404 an unknown user', async () => {
    const { svc } = build();
    expect(((await svc.sendRequest(A, 'zed').catch(e => e)) as Problem).status).toBe(404);
  });

  it('should create an outgoing request and emit friend.requested once', async () => {
    const { svc, events } = build();
    expect(await svc.sendRequest(A, 'b')).toBe('outgoing');
    expect(await svc.sendRequest(A, 'b')).toBe('outgoing');
    expect(events.map(e => e.type)).toEqual(['friend.requested']);
  });

  it('should accept when they already asked the caller', async () => {
    const { svc, events } = build();
    await svc.sendRequest(B, 'a');
    expect(await svc.sendRequest(A, 'b')).toBe('friend');
    expect(events.map(e => e.type)).toEqual(['friend.requested', 'friend.accepted']);
  });
});

describe('accept', () => {
  it('should return null when there is no incoming request', async () => {
    const { svc } = build();
    expect(await svc.accept(A, 'b')).toBeNull();
  });

  it('should make both friends and tell the requester', async () => {
    const { svc, repo, events } = build();
    await svc.sendRequest(B, 'a');
    const f = await svc.accept(A, 'b');
    expect(f?.username).toBe('bob');
    expect(repo.friendships.has('a>b') && repo.friendships.has('b>a')).toBe(true);
    expect(events.at(-1)).toEqual({
      type: 'friend.accepted',
      payload: { accepterUserId: 'a', requesterUserId: 'b' },
      userId: 'a',
    });
  });
});

describe('search', () => {
  it('should refuse a query under 2 characters and a limit over 20', async () => {
    const { svc } = build();
    expect(((await svc.search(A, ' x ', 5).catch(e => e)) as Problem).status).toBe(400);
    expect(((await svc.search(A, 'xy', 21).catch(e => e)) as Problem).status).toBe(400);
  });
});

describe('onSettled', () => {
  const settled = {
    userId: 'a',
    habitId: '11111111-1111-1111-1111-111111111111',
    habitVersionId: 'v1',
    checkId: 'x1',
    date: '2026-01-05',
  };

  it('should post friend_missed to each watcher with a dedupe key', async () => {
    const { svc, repo, posts } = build();
    repo.friendships.add('a>b').add('b>a');
    (repo as unknown as { watchers: FriendRepository['watchers'] }).watchers = async () => ['b'];
    await svc.onSettled({ ...settled, status: 'missed' });
    expect(posts).toEqual([
      [
        'b',
        'friend_missed',
        'Alice missed a habit',
        'Alice missed "Run" on Mon 5 Jan',
        'a',
        { habitId: settled.habitId, userId: 'a', localDate: '2026-01-05' },
        'friend_missed:x1',
      ],
    ]);
  });

  it('should ignore a check that was not missed', async () => {
    const { svc, posts } = build();
    await svc.onSettled({ ...settled, status: 'done' });
    expect(posts).toEqual([]);
  });
});

it('should format dates like ddd d MMM', () => {
  expect(shortDate('2026-03-01')).toBe('Sun 1 Mar');
});
