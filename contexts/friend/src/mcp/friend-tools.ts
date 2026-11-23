import { Owner, tool, z } from '@lazytax/kernel';
import type { FriendService } from '../domain/friend-service';

export const friendTools = (svc: FriendService) => [
  tool('search', {
    description: 'Find users by username prefix (at least 2 characters) and how they relate to you',
    policy: 'registered',
    subject: 'userId',
    input: z.object({ userId: z.string(), q: z.string(), limit: z.number().int().default(20) }),
    handler: async ({ input }) =>
      (await svc.search(Owner.user(input.userId), input.q, input.limit)).map(c => ({
        userId: c.user.userId,
        username: c.user.username,
        relation: c.relation,
      })),
  }),
  tool('list', {
    description: "List the user's friends",
    policy: 'registered',
    subject: 'userId',
    input: z.object({ userId: z.string() }),
    handler: ({ input }) => svc.listFriends(Owner.user(input.userId)),
  }),
  tool('request', {
    description: 'Ask a user to be friends (accepts their request when they already asked you)',
    policy: 'registered',
    subject: 'userId',
    input: z.object({ userId: z.string(), toUserId: z.string().min(1).max(128) }),
    handler: async ({ input }) => ({ relation: await svc.sendRequest(Owner.user(input.userId), input.toUserId) }),
  }),
  tool('setWatchers', {
    description: 'Choose which friends are told when a habit ends missed (empty list turns it off)',
    policy: 'registered',
    subject: 'userId',
    input: z.object({ userId: z.string(), habitId: z.string(), friendUserIds: z.array(z.string().min(1).max(128)) }),
    handler: async ({ input }) => ({
      habitId: input.habitId,
      friends: await svc.setWatchers(Owner.user(input.userId), input.habitId, input.friendUserIds),
    }),
  }),
];
