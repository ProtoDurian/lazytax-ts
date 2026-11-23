import { type Clock, notFound, type Owner, validationFailed } from '@lazytax/kernel';
import type { InboxRepository } from '../data/inbox-repository';
import {
  BODY_MAX,
  DATA_MAX,
  DEDUPE_KEY_MAX,
  type InboxRecord,
  type InboxRow,
  type InboxSearch,
  KIND_MAX,
  MAX_LIMIT,
  TITLE_MAX,
} from './model';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const checkText = (errors: Record<string, string[]>, field: string, value: string | null | undefined, max: number) => {
  if (value === null || value === undefined || value.trim() === '') errors[field] = [`${field} must not be empty`];
  else if (value.length > max) errors[field] = [`${field} must be at most ${max} characters`];
};

export interface PostInput {
  kind: string;
  title: string;
  body: string;
  actorUserId?: string | null;
  data?: Record<string, unknown> | null;
  dedupeKey?: string | null;
}

export class InboxService {
  constructor(
    private readonly repo: InboxRepository,
    private readonly clock: Clock,
  ) {}

  async post(owner: Owner, input: PostInput): Promise<InboxRow> {
    const data = input.data === undefined || input.data === null ? null : JSON.stringify(input.data);
    const errors: Record<string, string[]> = {};
    checkText(errors, 'kind', input.kind, KIND_MAX);
    checkText(errors, 'title', input.title, TITLE_MAX);
    checkText(errors, 'body', input.body, BODY_MAX);
    if (data !== null && data.length > DATA_MAX) errors.data = [`data must be at most ${DATA_MAX} characters`];
    if (input.dedupeKey && input.dedupeKey.length > DEDUPE_KEY_MAX)
      errors.dedupeKey = [`dedupeKey must be at most ${DEDUPE_KEY_MAX} characters`];
    if (Object.keys(errors).length > 0) throw validationFailed('Invalid inbox notification', errors);
    const record: InboxRecord = {
      kind: input.kind,
      title: input.title,
      body: input.body,
      actorUserId: input.actorUserId ?? null,
      data,
      dedupeKey: input.dedupeKey ?? null,
    };
    return this.repo.create(owner, record, this.clock.now());
  }

  search(owner: Owner, search: Partial<InboxSearch>): Promise<InboxRow[]> {
    const full: InboxSearch = {
      unreadOnly: search.unreadOnly ?? false,
      limit: search.limit ?? 20,
      skip: search.skip ?? 0,
    };
    const errors: Record<string, string[]> = {};
    if (!Number.isInteger(full.limit) || full.limit < 1 || full.limit > MAX_LIMIT)
      errors.limit = [`Limit must be between 1 and ${MAX_LIMIT}`];
    if (!Number.isInteger(full.skip) || full.skip < 0) errors.skip = ['Skip must not be negative'];
    if (Object.keys(errors).length > 0) throw validationFailed('Invalid inbox search', errors);
    return this.repo.search(owner, full);
  }

  unreadCount(owner: Owner): Promise<number> {
    return this.repo.unreadCount(owner);
  }

  // 404 when the notification is not the owner's (or not a uuid at all).
  async markRead(owner: Owner, id: string): Promise<void> {
    const found = UUID.test(id) && (await this.repo.markRead(owner, id, this.clock.now()));
    if (!found) throw notFound('Inbox Notification', id);
  }

  markAllRead(owner: Owner): Promise<number> {
    return this.repo.markAllRead(owner, this.clock.now());
  }
}
