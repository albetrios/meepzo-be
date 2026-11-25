import { describe, expect, it } from 'vitest';
import {
  INSTAGRAM_INBOUND_EVENT_KIND_OF,
  readInstagramWebhookEventDispatch,
  toInboundEventKind,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event-dispatch.util.js';
import { INSTAGRAM_WEBHOOK_EVENT_KINDS } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.constants.js';
import { InstagramWebhookEventPermanentError } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';

/**
 * The inbound seam's map and what each saved event hands contacts and the run engine
 * (feat-instagram-dm-sending § 5 WH27, WHC17; 5.A.10): one row per kind of the map, one fixture per
 * kind as the receiver saves it, and the payloads no retry can handle, failed at once (WH12).
 */

const SENDER = '17841400000000777';
const AUTOMATION = 'aut_acmeshop0000000000001';
const RUN = 'run_acmeshop0000000000001';

function commentPayload(value: Record<string, unknown>) {
  return { field: 'comments', value };
}

function messaging(item: Record<string, unknown>) {
  return { sender: { id: SENDER }, timestamp: 1_764_000_000_000, ...item };
}

describe('the kind → normalized-kind map (WH27)', () => {
  it.each([
    ['comment', 'comment'],
    ['live_comment', 'live_comment'],
    ['message', 'message'],
    ['postback', 'postback'],
    ['ice_breaker', 'starter_question'],
    ['story_reply', 'story_reply'],
    ['story_mention', 'story_mention'],
    ['shared_post', 'shared_post'],
    ['referral', 'referral'],
    ['reaction', 'reaction'],
    ['echo', 'owner_message'],
    ['edit', null],
    ['unknown', null],
  ])('%s → %s', (eventKind, inboundKind) => {
    expect(toInboundEventKind(eventKind)).toBe(inboundKind);
  });

  it('covers every saved kind, and nothing else crosses', () => {
    expect(Object.keys(INSTAGRAM_INBOUND_EVENT_KIND_OF).sort()).toEqual(
      [...INSTAGRAM_WEBHOOK_EVENT_KINDS].sort(),
    );
    expect(toInboundEventKind('read')).toBeNull();
    expect(toInboundEventKind('toString')).toBeNull();
  });
});

describe('readInstagramWebhookEventDispatch', () => {
  it('a comment: its id, post, parent, text and the commenter username', () => {
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'comment',
        contactInstagramUserId: SENDER,
        payload: commentPayload({
          id: '18000000000000001',
          parent_id: '18000000000000000',
          text: 'Price please?',
          from: { id: SENDER, username: 'acme_customer' },
          media: { id: '17900000000000001', media_product_type: 'FEED' },
        }),
      }),
    ).toEqual({
      inboundKind: 'comment',
      contactInstagramUserId: SENDER,
      username: 'acme_customer',
      instagramCommentId: '18000000000000001',
      instagramMediaId: '17900000000000001',
      parentCommentId: '18000000000000000',
      adId: null,
      text: 'Price please?',
    });
  });

  it('an ad’s comment carries its ad id; a Live comment its own kind', () => {
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'comment',
        contactInstagramUserId: SENDER,
        payload: commentPayload({
          id: '18000000000000002',
          media: { id: '17900000000000002', ad_id: '23850000000000001' },
        }),
      }),
    ).toMatchObject({ inboundKind: 'comment', adId: '23850000000000001' });
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'live_comment',
        contactInstagramUserId: SENDER,
        payload: {
          field: 'live_comments',
          value: { id: '18000000000000003', media: { id: '17900000000000003' }, text: 'hi' },
        },
      }),
    ).toMatchObject({ inboundKind: 'live_comment', instagramCommentId: '18000000000000003' });
  });

  it('a DM — as a messaging item or a `messages` change (D18) — its text, quick reply and email', () => {
    const message = {
      mid: 'm_1',
      text: 'hello',
      quick_reply: { payload: 'person@example.com' },
      attachments: [{ type: 'file', payload: { email: 'other@example.com' } }],
    };
    const expected = {
      inboundKind: 'message',
      contactInstagramUserId: SENDER,
      text: 'hello',
      quickReplyPayload: 'person@example.com',
      attachmentEmail: 'other@example.com',
      storyId: null,
      sharedMediaId: null,
    };
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'message',
        contactInstagramUserId: SENDER,
        payload: messaging({ message }),
      }),
    ).toEqual(expected);
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'message',
        contactInstagramUserId: SENDER,
        payload: { field: 'messages', value: messaging({ message }) },
      }),
    ).toEqual(expected);
  });

  it('a story reply, a story mention and a shared post name their story or post', () => {
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'story_reply',
        contactInstagramUserId: SENDER,
        payload: messaging({
          message: { mid: 'm_2', text: 'wow', reply_to: { story: { id: '17910000000000001' } } },
        }),
      }),
    ).toMatchObject({ inboundKind: 'story_reply', storyId: '17910000000000001' });
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'story_mention',
        contactInstagramUserId: SENDER,
        payload: messaging({
          message: {
            mid: 'm_3',
            attachments: [{ type: 'story_mention', payload: { id: '17910000000000002' } }],
          },
        }),
      }),
    ).toMatchObject({ inboundKind: 'story_mention', storyId: '17910000000000002' });
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'shared_post',
        contactInstagramUserId: SENDER,
        payload: messaging({
          message: {
            mid: 'm_4',
            attachments: [{ type: 'ig_post', payload: { ig_post_media_id: '17900000000000009' } }],
          },
        }),
      }),
    ).toMatchObject({ inboundKind: 'shared_post', sharedMediaId: '17900000000000009' });
  });

  it('a postback splits our payload — with or without the message part — and names no run when not ours', () => {
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'postback',
        contactInstagramUserId: SENDER,
        payload: messaging({ postback: { mid: 'm_5', payload: `${AUTOMATION}::${RUN}` } }),
      }),
    ).toEqual({
      inboundKind: 'postback',
      contactInstagramUserId: SENDER,
      button: { automationPublicId: AUTOMATION, runPublicId: RUN },
      messagePublicId: null,
      broadcastPublicId: null,
    });
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'postback',
        contactInstagramUserId: SENDER,
        payload: messaging({
          postback: { mid: 'm_6', payload: `${AUTOMATION}::${RUN}::igm_acmeshop0000000000001` },
        }),
      }),
    ).toMatchObject({ messagePublicId: 'igm_acmeshop0000000000001' });
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'postback',
        contactInstagramUserId: SENDER,
        payload: messaging({ postback: { mid: 'm_7', payload: 'SOMETHING_ELSE' } }),
      }),
    ).toMatchObject({ button: null, messagePublicId: null, broadcastPublicId: null });
    // A broadcast message's button (§ 7.A.10, R45): its broadcast and message, no run.
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'postback',
        contactInstagramUserId: SENDER,
        payload: messaging({
          postback: {
            mid: 'm_8',
            payload: 'brc_acmeshop0000000000001::igm_acmeshop0000000000001',
          },
        }),
      }),
    ).toEqual({
      inboundKind: 'postback',
      contactInstagramUserId: SENDER,
      button: null,
      messagePublicId: 'igm_acmeshop0000000000001',
      broadcastPublicId: 'brc_acmeshop0000000000001',
    });
  });

  it('a starter-question tap carries its question: the title, else the payload after `starter:`', () => {
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'ice_breaker',
        contactInstagramUserId: SENDER,
        payload: messaging({ postback: { title: 'Prices?', payload: 'starter:prices' } }),
      }),
    ).toEqual({
      inboundKind: 'starter_question',
      contactInstagramUserId: SENDER,
      starterQuestion: 'Prices?',
    });
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'ice_breaker',
        contactInstagramUserId: SENDER,
        payload: messaging({ postback: { payload: 'starter:Prices?' } }),
      }),
    ).toMatchObject({ starterQuestion: 'Prices?' });
  });

  it('a referral carries its ref code, or the ad id for an ad (then no ref)', () => {
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'referral',
        contactInstagramUserId: SENDER,
        payload: messaging({ referral: { ref: 'SPRING', source: 'SHORTLINK' } }),
      }),
    ).toEqual({
      inboundKind: 'referral',
      contactInstagramUserId: SENDER,
      refCode: 'SPRING',
      adId: null,
    });
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'referral',
        contactInstagramUserId: SENDER,
        payload: messaging({
          message: { mid: 'm_8', referral: { ad_id: '23850000000000002', source: 'ADS' } },
        }),
      }),
    ).toMatchObject({ refCode: null, adId: '23850000000000002' });
  });

  it('a reaction names only her; an echo the owner typed carries its mid', () => {
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'reaction',
        contactInstagramUserId: SENDER,
        payload: messaging({ reaction: { mid: 'm_9', action: 'react' } }),
      }),
    ).toEqual({ inboundKind: 'reaction', contactInstagramUserId: SENDER });
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'echo',
        contactInstagramUserId: SENDER,
        payload: { message: { mid: 'm_10', is_echo: true, text: 'typed by hand' } },
      }),
    ).toEqual({
      inboundKind: 'owner_message',
      contactInstagramUserId: SENDER,
      instagramMessageId: 'm_10',
    });
  });

  it.each([
    { name: 'no person', eventKind: 'message', contact: null, payload: messaging({ message: {} }) },
    {
      name: 'a comment without its post',
      eventKind: 'comment',
      contact: SENDER,
      payload: commentPayload({ id: '18000000000000001' }),
    },
    {
      name: 'a message without `message`',
      eventKind: 'message',
      contact: SENDER,
      payload: messaging({}),
    },
    {
      name: 'a story reply without its story',
      eventKind: 'story_reply',
      contact: SENDER,
      payload: messaging({ message: { mid: 'm' } }),
    },
    {
      name: 'a postback without `postback`',
      eventKind: 'postback',
      contact: SENDER,
      payload: messaging({}),
    },
    {
      name: 'a referral without `referral`',
      eventKind: 'referral',
      contact: SENDER,
      payload: messaging({}),
    },
    { name: 'an echo without `mid`', eventKind: 'echo', contact: SENDER, payload: { message: {} } },
    { name: 'an edit (never crosses)', eventKind: 'edit', contact: SENDER, payload: messaging({}) },
  ])('fails at once on $name', ({ eventKind, contact, payload }) => {
    expect(() =>
      readInstagramWebhookEventDispatch({ eventKind, contactInstagramUserId: contact, payload }),
    ).toThrow(InstagramWebhookEventPermanentError);
  });
});
