import { describe, expect, it } from 'vitest';
import {
  readInstagramWebhookEventDispatch,
  toContactInteractionKind,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event-dispatch.util.js';
import { InstagramWebhookEventPermanentError } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';

/**
 * What each stored event hands the run engine (routes-final § 4.A.10 "What each event does",
 * WH13): one fixture per trigger as the receiver stores it — a comment, a DM (a `messaging[]` item
 * and a `messages` change, D18), a story reply and a button click — and the payloads no retry can
 * handle, failed at once (WH14).
 */

const SENDER = '17841400000000777';
const AUTOMATION = 'aut_acmeshop0000000000001';
const RUN = 'run_acmeshop0000000000001';

function commentPayload(value: Record<string, unknown>) {
  return { field: 'comments', value };
}

describe('readInstagramWebhookEventDispatch', () => {
  it('reads a comment: its id, post, text and the commenter username', () => {
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'comment',
        contactInstagramUserId: SENDER,
        payload: commentPayload({
          id: '18000000000000001',
          text: 'Price please?',
          from: { id: SENDER, username: 'acme_customer' },
          media: { id: '17900000000000001', media_product_type: 'FEED' },
        }),
      }),
    ).toEqual({
      kind: 'comment',
      contactInstagramUserId: SENDER,
      username: 'acme_customer',
      instagramCommentId: '18000000000000001',
      instagramMediaId: '17900000000000001',
      text: 'Price please?',
    });
  });

  it('reads a DM from a messaging item: text, quick reply payload and attachment email', () => {
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'message',
        contactInstagramUserId: SENDER,
        payload: {
          sender: { id: SENDER },
          recipient: { id: '9000000000000001' },
          timestamp: 1_763_726_401_234,
          message: {
            mid: 'm_1',
            text: 'jordan@example.com',
            quick_reply: { payload: 'jordan@example.com' },
            attachments: [{ type: 'image', payload: {} }, { payload: { email: 'j@example.com' } }],
          },
        },
      }),
    ).toEqual({
      kind: 'direct_message',
      contactInstagramUserId: SENDER,
      text: 'jordan@example.com',
      quickReplyPayload: 'jordan@example.com',
      attachmentEmail: 'j@example.com',
    });
  });

  it('reads a `messages` change as a DM (D18) — the value is the messaging item', () => {
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'message',
        contactInstagramUserId: SENDER,
        payload: {
          field: 'messages',
          value: { sender: { id: SENDER }, message: { mid: 'm_2', text: 'LINK' } },
        },
      }),
    ).toEqual({
      kind: 'direct_message',
      contactInstagramUserId: SENDER,
      text: 'LINK',
      quickReplyPayload: null,
      attachmentEmail: null,
    });
  });

  it('reads a story reply with the replied story id', () => {
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'story_reply',
        contactInstagramUserId: SENDER,
        payload: {
          sender: { id: SENDER },
          message: {
            mid: 'm_3',
            text: 'love it',
            reply_to: { story: { id: '17950000000000001' } },
          },
        },
      }),
    ).toEqual({
      kind: 'story_reply',
      contactInstagramUserId: SENDER,
      instagramStoryId: '17950000000000001',
      text: 'love it',
    });
  });

  it('reads a button click as the two public ids of the payload', () => {
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'postback',
        contactInstagramUserId: SENDER,
        payload: {
          sender: { id: SENDER },
          postback: { mid: 'm_4', title: 'Send me the link', payload: `${AUTOMATION}::${RUN}` },
        },
      }),
    ).toEqual({
      kind: 'button_click',
      contactInstagramUserId: SENDER,
      button: { automationPublicId: AUTOMATION, runPublicId: RUN },
    });
  });

  it('keeps a click whose payload this engine never sent, with no button (nothing runs)', () => {
    expect(
      readInstagramWebhookEventDispatch({
        eventKind: 'postback',
        contactInstagramUserId: SENDER,
        payload: { sender: { id: SENDER }, postback: { mid: 'm_5', payload: 'GET_STARTED' } },
      }),
    ).toEqual({ kind: 'button_click', contactInstagramUserId: SENDER, button: null });
  });

  it.each([
    {
      name: 'no sender',
      input: { eventKind: 'message', contactInstagramUserId: null, payload: { message: {} } },
      reason: 'event_payload_invalid:contact_missing',
    },
    {
      name: 'a comment without its post',
      input: {
        eventKind: 'comment',
        contactInstagramUserId: SENDER,
        payload: commentPayload({ id: '18000000000000002', text: 'hi' }),
      },
      reason: 'event_payload_invalid:comment_media_missing',
    },
    {
      name: 'a comment id that is not digits',
      input: {
        eventKind: 'comment',
        contactInstagramUserId: SENDER,
        payload: commentPayload({ id: 'abc', media: { id: '17900000000000001' } }),
      },
      reason: 'event_payload_invalid:comment_id_missing',
    },
    {
      name: 'a story reply without its story',
      input: {
        eventKind: 'story_reply',
        contactInstagramUserId: SENDER,
        payload: { message: { mid: 'm_6', reply_to: {} } },
      },
      reason: 'event_payload_invalid:story_id_missing',
    },
    {
      name: 'a message without `message`',
      input: { eventKind: 'message', contactInstagramUserId: SENDER, payload: { read: {} } },
      reason: 'event_payload_invalid:message_missing',
    },
    {
      name: 'a kind the receiver never stores `received`',
      input: { eventKind: 'reaction', contactInstagramUserId: SENDER, payload: {} },
      reason: 'event_payload_invalid:unhandled_kind:reaction',
    },
  ])('fails $name at once, with a code and no payload text (WH14)', ({ input, reason }) => {
    const read = () => readInstagramWebhookEventDispatch(input);
    expect(read).toThrow(InstagramWebhookEventPermanentError);
    expect(read).toThrow(reason);
  });
});

describe('toContactInteractionKind', () => {
  it('records a comment as a comment and every other trigger as a direct interaction (CT10)', () => {
    expect(toContactInteractionKind('comment')).toBe('comment');
    expect(toContactInteractionKind('direct_message')).toBe('direct_message');
    expect(toContactInteractionKind('story_reply')).toBe('story_reply');
    expect(toContactInteractionKind('button_click')).toBe('button_click');
  });
});
