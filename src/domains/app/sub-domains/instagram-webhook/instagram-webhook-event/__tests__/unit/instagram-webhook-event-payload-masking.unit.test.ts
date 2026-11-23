import { describe, expect, it } from 'vitest';
import {
  INSTAGRAM_WEBHOOK_EVENT_PAYLOAD_LINK_PLACEHOLDER,
  INSTAGRAM_WEBHOOK_EVENT_PAYLOAD_TEXT_MAX_CHARACTERS,
  maskInstagramWebhookEventPayload,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event-payload-masking.util.js';

/**
 * WH17 / WQ2 (routes-final § 4.B): route 18 shows each event's payload with personal data masked —
 * message and comment text cut to 40 characters, emails and phone numbers masked, media and
 * attachment links replaced; ids, kinds and usernames kept. One case per event kind of 4.A.10.
 */

const ACCOUNT_ID = '17841400000000001';
const CONTACT_ID = '17841400000000777';
const LONG_TEXT =
  'Please send me the price list and the catalogue, I would like to order three of them';

function messagingItem(item: Record<string, unknown>) {
  return {
    sender: { id: CONTACT_ID },
    recipient: { id: ACCOUNT_ID },
    timestamp: 1_732_186_000_000,
    ...item,
  };
}

describe('maskInstagramWebhookEventPayload', () => {
  it('comment: cuts the text to 40 characters and keeps the ids, the username and the kind', () => {
    const masked = maskInstagramWebhookEventPayload({
      field: 'comments',
      value: {
        from: { id: CONTACT_ID, username: 'acme_customer' },
        media: { id: '17900000000000001', media_product_type: 'FEED' },
        id: '18000000000000001',
        parent_id: '18000000000000000',
        text: LONG_TEXT,
      },
    });
    expect(masked).toEqual({
      field: 'comments',
      value: {
        from: { id: CONTACT_ID, username: 'acme_customer' },
        media: { id: '17900000000000001', media_product_type: 'FEED' },
        id: '18000000000000001',
        parent_id: '18000000000000000',
        text: LONG_TEXT.slice(0, INSTAGRAM_WEBHOOK_EVENT_PAYLOAD_TEXT_MAX_CHARACTERS),
      },
    });
  });

  it('message: masks an email and a phone number inside the text before cutting it', () => {
    const masked = maskInstagramWebhookEventPayload(
      messagingItem({ message: { mid: 'mid-1', text: 'rimeet@gmail.com +91 98765 43234' } }),
    );
    expect(masked).toEqual(
      messagingItem({ message: { mid: 'mid-1', text: 'r***@g***.com +91********34' } }),
    );
  });

  it('message: masks a quick reply email and an attachment link', () => {
    const masked = maskInstagramWebhookEventPayload(
      messagingItem({
        message: {
          mid: 'mid-2',
          text: 'jane.doe@example.co.uk',
          quick_reply: { payload: 'jane.doe@example.co.uk' },
          attachments: [
            { type: 'image', payload: { url: 'https://lookaside.example.com/image?id=1' } },
          ],
        },
      }),
    );
    expect(masked).toEqual(
      messagingItem({
        message: {
          mid: 'mid-2',
          text: 'j***@e***.uk',
          quick_reply: { payload: 'j***@e***.uk' },
          attachments: [
            { type: 'image', payload: { url: INSTAGRAM_WEBHOOK_EVENT_PAYLOAD_LINK_PLACEHOLDER } },
          ],
        },
      }),
    );
  });

  it('message: replaces a link written inside the text', () => {
    const masked = maskInstagramWebhookEventPayload(
      messagingItem({ message: { mid: 'mid-3', text: 'see https://example.com/a?b=c ok' } }),
    );
    expect(masked).toEqual(messagingItem({ message: { mid: 'mid-3', text: 'see [link] ok' } }));
  });

  it('story reply: replaces the story link and cuts the text', () => {
    const masked = maskInstagramWebhookEventPayload(
      messagingItem({
        message: {
          mid: 'mid-4',
          text: LONG_TEXT,
          reply_to: { story: { id: '17950000000000001', url: 'https://example.com/story' } },
        },
      }),
    );
    expect(masked).toEqual(
      messagingItem({
        message: {
          mid: 'mid-4',
          text: LONG_TEXT.slice(0, 40),
          reply_to: { story: { id: '17950000000000001', url: '[link]' } },
        },
      }),
    );
  });

  it('postback: keeps the run payload and masks a phone number in the title', () => {
    const masked = maskInstagramWebhookEventPayload(
      messagingItem({
        postback: {
          mid: 'mid-5',
          title: 'Call 9876543234',
          payload: 'aut_k3m9p2q7r5t1v8w4x6y0z::run_a1b2c3d4e5f6g7h8i9j0k',
        },
      }),
    );
    expect(masked).toEqual(
      messagingItem({
        postback: {
          mid: 'mid-5',
          title: 'Call 98******34',
          payload: 'aut_k3m9p2q7r5t1v8w4x6y0z::run_a1b2c3d4e5f6g7h8i9j0k',
        },
      }),
    );
  });

  it('echo: masks the echoed text like a message', () => {
    const masked = maskInstagramWebhookEventPayload({
      sender: { id: ACCOUNT_ID },
      recipient: { id: CONTACT_ID },
      timestamp: 1_732_186_000_000,
      message: { mid: 'mid-6', text: 'Write to shop@example.com', is_echo: true },
    });
    expect(masked).toMatchObject({
      sender: { id: ACCOUNT_ID },
      recipient: { id: CONTACT_ID },
      message: { mid: 'mid-6', text: 'Write to s***@e***.com', is_echo: true },
    });
  });

  it('read, reaction and edit: keep ids, actions and emoji; mask the edited text', () => {
    expect(maskInstagramWebhookEventPayload(messagingItem({ read: { mid: 'mid-7' } }))).toEqual(
      messagingItem({ read: { mid: 'mid-7' } }),
    );
    const reaction = messagingItem({
      reaction: { mid: 'mid-8', action: 'react', reaction: 'love', emoji: '❤' },
    });
    expect(maskInstagramWebhookEventPayload(reaction)).toEqual(reaction);
    expect(
      maskInstagramWebhookEventPayload(
        messagingItem({ message_edit: { mid: 'mid-9', text: 'mail me: a@b.io', num_edit: 1 } }),
      ),
    ).toEqual(
      messagingItem({ message_edit: { mid: 'mid-9', text: 'mail me: a***@b***.io', num_edit: 1 } }),
    );
  });

  it('unknown change: masks the strings of any other field and keeps its ids', () => {
    const masked = maskInstagramWebhookEventPayload({
      field: 'mentions',
      value: {
        media_id: '17900000000000001',
        comment_id: '18000000000000009',
        caption: 'call +1 555 123 4567',
        media_url: 'https://cdn.example.com/media.jpg',
      },
    });
    expect(masked).toEqual({
      field: 'mentions',
      value: {
        media_id: '17900000000000001',
        comment_id: '18000000000000009',
        caption: 'call +15*******67',
        media_url: '[link]',
      },
    });
  });

  it('keeps a date and short numbers readable, and a numeric username as it is', () => {
    const masked = maskInstagramWebhookEventPayload({
      value: {
        from: { id: CONTACT_ID, username: '12345678901' },
        text: 'On 2026-11-21 buy 3 for 499',
      },
    });
    expect(masked).toEqual({
      value: {
        from: { id: CONTACT_ID, username: '12345678901' },
        text: 'On 2026-11-21 buy 3 for 499',
      },
    });
  });

  it('cuts text by characters, never splitting an emoji', () => {
    const text = `${'😀'.repeat(39)}abc`;
    const masked = maskInstagramWebhookEventPayload({ text }) as { text: string };
    expect(Array.from(masked.text)).toHaveLength(40);
    expect(masked.text).toBe(`${'😀'.repeat(39)}a`);
  });

  it('masks every email in a string, ending each at its top-level domain', () => {
    const masked = maskInstagramWebhookEventPayload({
      note: 'a@b.io, x.y@mail.example.com. Not: @b.io, a@b, a@.io; a@b@c.com; a@b.com2x',
    });
    expect(masked).toEqual({
      note: 'a***@b***.io, x***@m***.com. Not: @b.io, a@b, a@.io; a@b***@c***.com; a***@b***.com2x',
    });
  });

  it('stays fast on long runs that only look like an email (no backtracking)', () => {
    const localRun = `${'a'.repeat(4000)}!`;
    const domainRun = `a@${'b.'.repeat(2000)}!`;
    const startedAt = performance.now();
    expect(maskInstagramWebhookEventPayload({ note: localRun })).toEqual({ note: localRun });
    expect(maskInstagramWebhookEventPayload({ note: domainRun })).toEqual({ note: domainRun });
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  it('never changes the stored payload it reads', () => {
    const payload = messagingItem({ message: { mid: 'mid-10', text: 'rimeet@gmail.com' } });
    const copy = structuredClone(payload);
    maskInstagramWebhookEventPayload(payload);
    expect(payload).toEqual(copy);
  });

  it('answers {} for a value that is not an object, and stops past 20 levels', () => {
    expect(maskInstagramWebhookEventPayload(null)).toEqual({});
    expect(maskInstagramWebhookEventPayload('text')).toEqual({});
    expect(maskInstagramWebhookEventPayload([1, 2])).toEqual({});

    let deep: Record<string, unknown> = { text: 'bottom' };
    for (let level = 0; level < 25; level += 1) deep = { nested: deep };
    const masked = JSON.stringify(maskInstagramWebhookEventPayload(deep));
    expect(masked).toContain('[truncated]');
    expect(masked).not.toContain('bottom');
  });
});
