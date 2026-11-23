import { notFound, Owner, route, z } from '@lazytax/kernel';
import type { FriendService } from '../../domain/friend-service';

const SendFriendRequestReq = z.object({ toUserId: z.string().min(1).max(128) });
const SearchQuery = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().default(20),
});
const SetFriendWatchersReq = z.object({
  friendUserIds: z
    .array(z.string().min(1).max(128))
    .refine(ids => new Set(ids).size <= 20, 'At most 20 friends can be told'),
});

export const friendRoutes = (svc: FriendService) => [
  // Usernames starting with q (case-insensitive); never email or name.
  route.get('/Friend/:userId/search', {
    policy: 'registered',
    subject: 'userId',
    query: SearchQuery,
    handler: async ({ params, query }) =>
      (await svc.search(Owner.user(params.userId), query.q ?? '', query.limit)).map(c => ({
        userId: c.user.userId,
        username: c.user.username,
        relation: c.relation,
      })),
  }),
  route.get('/Friend/:userId', {
    policy: 'registered',
    subject: 'userId',
    handler: ({ params }) => svc.listFriends(Owner.user(params.userId)),
  }),
  route.delete('/Friend/:userId/:friendUserId', {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => {
      if (!(await svc.remove(Owner.user(params.userId), params.friendUserId)))
        throw notFound('Friend', params.friendUserId);
    },
  }),
  route.get('/Friend/:userId/requests', {
    policy: 'registered',
    subject: 'userId',
    handler: ({ params }) => svc.listRequests(Owner.user(params.userId)),
  }),
  // Asking someone who already asked you accepts their request (relation "friend").
  route.post('/Friend/:userId/requests', {
    policy: 'registered',
    subject: 'userId',
    body: SendFriendRequestReq,
    handler: async ({ params, body }) => ({
      relation: await svc.sendRequest(Owner.user(params.userId), body.toUserId),
    }),
  }),
  route.post('/Friend/:userId/requests/:fromUserId/accept', {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => {
      const f = await svc.accept(Owner.user(params.userId), params.fromUserId);
      if (!f) throw notFound('Friend Request', params.fromUserId);
      return f;
    },
  }),
  // Declines an incoming request or cancels an outgoing one.
  route.delete('/Friend/:userId/requests/:otherUserId', {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => {
      if (!(await svc.deleteRequest(Owner.user(params.userId), params.otherUserId)))
        throw notFound('Friend Request', params.otherUserId);
    },
  }),
  // The user's permanent invite: the same code on every call.
  route.post('/Friend/:userId/invites', {
    policy: 'registered',
    subject: 'userId',
    handler: ({ params }) => svc.getOrCreateInvite(Owner.user(params.userId)),
  }),
  route.post('/Friend/:userId/invites/:code/accept', {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => {
      const relation = await svc.acceptInvite(Owner.user(params.userId), params.code);
      if (!relation) throw notFound('Friend Invite', params.code);
      return { relation };
    },
  }),

  // "Tell my friends if I miss": which friends hear when a habit's day ends Missed.
  route.get('/FriendStake/:userId/:habitId', {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => ({
      habitId: params.habitId,
      friends: await svc.getWatchers(Owner.user(params.userId), params.habitId),
    }),
  }),
  // Replaces the habit's watchers; an empty list turns it off.
  route.put('/FriendStake/:userId/:habitId', {
    policy: 'registered',
    subject: 'userId',
    body: SetFriendWatchersReq,
    handler: async ({ params, body }) => ({
      habitId: params.habitId,
      friends: await svc.setWatchers(Owner.user(params.userId), params.habitId, body.friendUserIds),
    }),
  }),
];
