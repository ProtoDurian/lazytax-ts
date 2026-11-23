import { Owner, tool, z } from '@lazytax/kernel';
import type { InboxService } from '../domain/inbox-service';

export const inboxTools = (svc: InboxService) => [
  tool('list', {
    description: "List a user's inbox notifications, newest first (limit 1..50, default 20)",
    policy: 'registered',
    subject: 'userId',
    input: z.object({
      userId: z.string(),
      unreadOnly: z.boolean().optional(),
      limit: z.number().optional(),
      skip: z.number().optional(),
    }),
    handler: ({ input }) =>
      svc.search(Owner.user(input.userId), { unreadOnly: input.unreadOnly, limit: input.limit, skip: input.skip }),
  }),
  tool('unreadCount', {
    description: "Count a user's unread inbox notifications",
    policy: 'registered',
    subject: 'userId',
    input: z.object({ userId: z.string() }),
    handler: async ({ input }) => ({ count: await svc.unreadCount(Owner.user(input.userId)) }),
  }),
  tool('markRead', {
    description: "Mark one inbox notification read (404 when it is not the user's)",
    policy: 'registered',
    subject: 'userId',
    input: z.object({ userId: z.string(), id: z.string() }),
    handler: async ({ input }) => {
      await svc.markRead(Owner.user(input.userId), input.id);
      return { ok: true };
    },
  }),
  tool('markAllRead', {
    description: "Mark all of a user's inbox notifications read; returns how many were unread",
    policy: 'registered',
    subject: 'userId',
    input: z.object({ userId: z.string() }),
    handler: async ({ input }) => ({ count: await svc.markAllRead(Owner.user(input.userId)) }),
  }),
];
