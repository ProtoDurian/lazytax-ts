import { notFound, Owner, route, validationFailed, z } from '@lazytax/kernel';
import type { NfcTagDto } from '@lazytax/proof-contract/v1';
import type { NfcTag } from '../../domain/model';
import type { NfcResolution, NfcTagService } from '../../domain/nfc-service';
import { habitIdOf } from './proof-routes';

const LinkNfcTagReq = z.object({ habitId: z.string().min(1) });

// Tag ids are client-generated (UUID-ish) strings embedded in the tag URL.
export const validTagId = (tagId: string): string => {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(tagId))
    throw validationFailed('Invalid NFC tag id', {
      TagId: ['Tag id must be 8-64 characters of letters, digits or hyphens'],
    });
  return tagId;
};

export const tagDto = (t: NfcTag): NfcTagDto => ({
  id: t.id,
  userId: t.userId,
  habitId: t.habitId,
  claimedAt: t.claimedAt.toISOString(),
});

export const resolutionDto = (r: NfcResolution) => ({
  tag: tagDto(r.tag),
  habitVersion: r.habitVersion, // current version: complete against this
  today: r.today,
  todayExecution: r.todayExecution, // null = not yet acted on today
});

export const nfcRoutes = (svc: NfcTagService) => [
  route.put('/NfcTag/:userId/:tagId', {
    policy: 'registered',
    subject: 'userId',
    body: LinkNfcTagReq,
    handler: async ({ params, body }) => {
      const tagId = validTagId(params.tagId);
      return tagDto(await svc.link(Owner.user(params.userId), tagId, habitIdOf(body.habitId)));
    },
  }),
  route.get('/NfcTag/:userId/:tagId', {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => {
      const tagId = validTagId(params.tagId);
      const r = await svc.resolve(Owner.user(params.userId), tagId);
      if (!r) throw notFound('NFC Tag', tagId);
      return resolutionDto(r);
    },
  }),
  route.delete('/NfcTag/:userId/:tagId', {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => {
      const tagId = validTagId(params.tagId);
      if (!(await svc.unlink(Owner.user(params.userId), tagId))) throw notFound('NFC Tag', tagId);
    },
  }),
  // New: a tap is proof of the tag's habit, through the proof router (plugin "nfc").
  route.post('/NfcTag/:userId/:tagId/tap', {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => svc.tap(Owner.user(params.userId), validTagId(params.tagId)),
  }),
];
