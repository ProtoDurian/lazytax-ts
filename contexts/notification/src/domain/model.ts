import type { InboxNotificationDto } from '@lazytax/notification-contract/v1';

export const TITLE_MAX = 256;
export const BODY_MAX = 1024;
export const KIND_MAX = 32;
export const DATA_MAX = 2048;
export const DEDUPE_KEY_MAX = 128;
export const MAX_LIMIT = 50;

export interface InboxRecord {
  kind: string;
  title: string;
  body: string;
  actorUserId: string | null;
  // JSON text.
  data: string | null;
  dedupeKey: string | null;
}

export interface InboxSearch {
  unreadOnly: boolean;
  limit: number;
  skip: number;
}

export type InboxRow = InboxNotificationDto;
