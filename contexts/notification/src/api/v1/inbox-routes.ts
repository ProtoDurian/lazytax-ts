import { Owner, route, z } from '@lazytax/kernel';
import type { InboxService } from '../../domain/inbox-service';

// Defaults: all notifications, 20 per page, from the newest. The service checks the ranges.
const SearchInboxQuery = z.object({
  unreadOnly: z.stringbool().optional(),
  limit: z.coerce.number().optional(),
  skip: z.coerce.number().optional(),
});

export const inboxRoutes = (svc: InboxService) => [
  route.get('/:userId', {
    policy: 'registered',
    subject: 'userId',
    query: SearchInboxQuery,
    handler: ({ params, query }) => svc.search(Owner.user(params.userId), query),
  }),
  route.get('/:userId/unread-count', {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => ({ count: await svc.unreadCount(Owner.user(params.userId)) }),
  }),
  // 204 (also when already read), 404 when it is not this user's notification.
  route.post('/:userId/:id/read', {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => {
      await svc.markRead(Owner.user(params.userId), params.id);
    },
  }),
  // count = how many were unread and are now read.
  route.post('/:userId/read-all', {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => ({ count: await svc.markAllRead(Owner.user(params.userId)) }),
  }),
];
