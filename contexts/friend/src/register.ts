import '@lazytax/friend-contract/v1';
import '@lazytax/account-contract/v1';
import '@lazytax/check-contract/v1';
import { defineContext, subscribe } from '@lazytax/kernel';
import { friendRoutes } from './api/v1/friend-routes';
import { FriendRepository } from './data/friend-repository';
import { FriendService } from './domain/friend-service';
import { friendTools } from './mcp/friend-tools';

export default defineContext({
  migrations: 'src/data/migrations',
  build: ({ deps, uow, outbox }) => {
    const repo = new FriendRepository(uow);
    const service = new FriendService(repo, deps.get('account.v1'), deps.get('habit.v1'), deps.get('notification.v1'), uow, outbox);
    return {
      provides: { 'friend.v1': service },
      http: friendRoutes(service),
      mcp: friendTools(service),
      users: { purgeUser: userId => repo.purgeUser(userId) },
      subscribers: [
        subscribe('friend.requested', e => service.onRequested(e.payload)),
        subscribe('friend.accepted', e => service.onAccepted(e.payload, e.id)),
        subscribe('check.settled', e => service.onSettled(e.payload)),
      ],
      workers: [],
    };
  },
});
