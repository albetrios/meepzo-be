import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type InstagramWebhookAccountIds,
  buildInstagramWebhookEventKey,
  classifyInstagramWebhookItem,
  listInstagramWebhookEntryItems,
  readInstagramWebhookTime,
  readInstagramWebhookUserId,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event-classifier.util.js';

/**
 * The one pure classifier of the Instagram webhook (routes-final § 4.A.10, WH9, WHC8): every row of
 * the table — kind, key, skip reason, contact, time — the three key gaps of the drop, the account's
 * own comment and DM, and the 512-character key rule.
 */

const ACCOUNT_IDS: InstagramWebhookAccountIds = {
  instagramUserId: '17841400000000001',
  instagramAppUserId: '9000000000000001',
};
const CONTACT_ID = '17841400000000777';
const OTHER_ACCOUNT_ID = '17841400000000555';
/** Meta's entry time in seconds (a `changes[]` delivery) and an item time in milliseconds. */
const ENTRY_TIME_SECONDS = 1_763_726_400;
const ITEM_TIME_MILLISECONDS = 1_763_726_401_234;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function classifyChange(item: Record<string, unknown>) {
  return classifyInstagramWebhookItem({
    source: 'changes',
    item,
    accountIds: ACCOUNT_IDS,
    entryTime: ENTRY_TIME_SECONDS,
  });
}

function classifyMessaging(item: Record<string, unknown>) {
  return classifyInstagramWebhookItem({
    source: 'messaging',
    item,
    accountIds: ACCOUNT_IDS,
    entryTime: ENTRY_TIME_SECONDS,
  });
}

/** A `messaging[]` item from the contact to the account at the item time. */
function fromContact(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    sender: { id: CONTACT_ID },
    recipient: { id: ACCOUNT_IDS.instagramUserId },
    timestamp: ITEM_TIME_MILLISECONDS,
    ...fields,
  };
}

describe('classifyInstagramWebhookItem — changes[] (4.A.10)', () => {
  it('a comment by another user is `comment:<value.id>`, received, the commenter as contact', () => {
    const item = {
      field: 'comments',
      value: { id: '18000000000000001', from: { id: CONTACT_ID, username: 'acme_customer' } },
    };

    expect(classifyChange(item)).toEqual({
      eventKind: 'comment',
      eventKey: 'comment:18000000000000001',
      kindSkipReason: null,
      contactInstagramUserId: CONTACT_ID,
      occurredAt: new Date(ENTRY_TIME_SECONDS * 1000),
      payload: item,
    });
  });

  it.each([
    ['webhook user id', ACCOUNT_IDS.instagramUserId],
    ['app-scoped id', ACCOUNT_IDS.instagramAppUserId],
  ])('a comment by the account itself (its %s) is skipped `echo`, naming nobody', (_label, id) => {
    const event = classifyChange({
      field: 'comments',
      value: { id: '18000000000000002', from: { id } },
    });

    expect(event).toMatchObject({
      eventKind: 'comment',
      eventKey: 'comment:18000000000000002',
      kindSkipReason: 'echo',
      contactInstagramUserId: null,
    });
  });

  it('a `messages` change is read as a DM (D18), its payload the whole change item', () => {
    const item = {
      field: 'messages',
      value: fromContact({ message: { mid: 'm_change_1', text: 'hello' } }),
    };

    const event = classifyChange(item);

    expect(event).toMatchObject({
      eventKind: 'message',
      eventKey: 'message:m_change_1',
      kindSkipReason: null,
      contactInstagramUserId: CONTACT_ID,
      occurredAt: new Date(ITEM_TIME_MILLISECONDS),
    });
    expect(event.payload).toBe(item);
  });

  it('a `messages` change and a `messaging[]` item of the same mid share one key (stored once)', () => {
    const viaChange = classifyChange({
      field: 'messages',
      value: fromContact({ message: { mid: 'm_same' } }),
    });
    const viaMessaging = classifyMessaging(fromContact({ message: { mid: 'm_same' } }));

    expect(viaChange.eventKey).toBe(viaMessaging.eventKey);
  });

  it('any other field is `change:<field>:<SHA-256 of value>`, skipped `unsupported`', () => {
    const value = { media_id: '18000000000000009', comment_id: '18000000000000010' };
    const event = classifyChange({ field: 'mentions', value });

    expect(event).toEqual({
      eventKind: 'unknown',
      eventKey: `change:mentions:${sha256(JSON.stringify(value))}`,
      kindSkipReason: 'unsupported',
      contactInstagramUserId: null,
      occurredAt: new Date(ENTRY_TIME_SECONDS * 1000),
      payload: { field: 'mentions', value },
    });
  });

  it('a comment change without a comment id falls to `unsupported`', () => {
    const event = classifyChange({ field: 'comments', value: { from: { id: CONTACT_ID } } });

    expect(event.eventKind).toBe('unknown');
    expect(event.kindSkipReason).toBe('unsupported');
    expect(event.eventKey).toMatch(/^change:comments:[0-9a-f]{64}$/);
  });
});

describe('classifyInstagramWebhookItem — messaging[] (4.A.10)', () => {
  it('a text message is `message:<mid>`, received, the sender as contact, at the item time', () => {
    const item = fromContact({ message: { mid: 'm_text', text: 'price?' } });

    expect(classifyMessaging(item)).toEqual({
      eventKind: 'message',
      eventKey: 'message:m_text',
      kindSkipReason: null,
      contactInstagramUserId: CONTACT_ID,
      occurredAt: new Date(ITEM_TIME_MILLISECONDS),
      payload: item,
    });
  });

  it.each([
    ['a quick reply', { quick_reply: { payload: 'EMAIL' } }],
    ['attachments', { attachments: [{ type: 'image', payload: { url: 'https://x.test/a.png' } }] }],
  ])('a message with %s is still a `message`', (_label, fields) => {
    const event = classifyMessaging(fromContact({ message: { mid: 'm_rich', ...fields } }));

    expect(event).toMatchObject({ eventKind: 'message', eventKey: 'message:m_rich' });
  });

  it('a story reply (`reply_to.story.id`) is `story_reply`, keyed `message:<mid>`', () => {
    const event = classifyMessaging(
      fromContact({
        message: { mid: 'm_story', reply_to: { story: { id: '17900000000000001' } } },
      }),
    );

    expect(event).toMatchObject({
      eventKind: 'story_reply',
      eventKey: 'message:m_story',
      kindSkipReason: null,
      contactInstagramUserId: CONTACT_ID,
    });
  });

  it('an echo (`is_echo`) is `echo:<mid>`, skipped `echo`, the recipient as contact (WQ4)', () => {
    const event = classifyMessaging({
      sender: { id: ACCOUNT_IDS.instagramUserId },
      recipient: { id: CONTACT_ID },
      timestamp: ITEM_TIME_MILLISECONDS,
      message: { mid: 'm_echo', is_echo: true, text: 'sent by hand' },
    });

    expect(event).toMatchObject({
      eventKind: 'echo',
      eventKey: 'echo:m_echo',
      kindSkipReason: 'echo',
      contactInstagramUserId: CONTACT_ID,
    });
  });

  it('a message sent by the account itself (its app-scoped id) is an echo even without `is_echo`', () => {
    const event = classifyMessaging({
      sender: { id: ACCOUNT_IDS.instagramAppUserId },
      recipient: { id: CONTACT_ID },
      message: { mid: 'm_own' },
    });

    expect(event).toMatchObject({
      eventKind: 'echo',
      eventKey: 'echo:m_own',
      kindSkipReason: 'echo',
      contactInstagramUserId: CONTACT_ID,
    });
  });

  it('two connected accounts messaging each other: an echo on one, a message on the other (gap 3)', () => {
    const delivered = {
      sender: { id: ACCOUNT_IDS.instagramUserId },
      recipient: { id: OTHER_ACCOUNT_ID },
      message: { mid: 'm_between_accounts' },
    };
    const otherAccountIds: InstagramWebhookAccountIds = {
      instagramUserId: OTHER_ACCOUNT_ID,
      instagramAppUserId: '9000000000000555',
    };

    const onSender = classifyMessaging(delivered);
    const onRecipient = classifyInstagramWebhookItem({
      source: 'messaging',
      item: delivered,
      accountIds: otherAccountIds,
      entryTime: ENTRY_TIME_SECONDS,
    });

    expect(onSender).toMatchObject({ eventKind: 'echo', eventKey: 'echo:m_between_accounts' });
    expect(onRecipient).toMatchObject({
      eventKind: 'message',
      eventKey: 'message:m_between_accounts',
      contactInstagramUserId: ACCOUNT_IDS.instagramUserId,
    });
  });

  it('a deleted message is `deleted:<mid>`, kind `unknown`, skipped `unsupported`', () => {
    const event = classifyMessaging(fromContact({ message: { mid: 'm_gone', is_deleted: true } }));

    expect(event).toMatchObject({
      eventKind: 'unknown',
      eventKey: 'deleted:m_gone',
      kindSkipReason: 'unsupported',
    });
  });

  it('a button click is `postback:<mid>`, received', () => {
    const event = classifyMessaging(
      fromContact({ postback: { mid: 'm_click', title: 'Send it', payload: 'aut_x::run_y' } }),
    );

    expect(event).toMatchObject({
      eventKind: 'postback',
      eventKey: 'postback:m_click',
      kindSkipReason: null,
      contactInstagramUserId: CONTACT_ID,
    });
  });

  it('a button click without `mid` keys on sender, time and its payload hash (gap 1)', () => {
    const event = classifyMessaging(
      fromContact({ postback: { title: 'Send it', payload: 'aut_x::run_y' } }),
    );

    expect(event).toMatchObject({
      eventKind: 'postback',
      eventKey: `postback:${CONTACT_ID}:${ITEM_TIME_MILLISECONDS}:${sha256('aut_x::run_y')}`,
      kindSkipReason: null,
    });
  });

  it('two clicks without `mid` on different buttons get different keys', () => {
    const first = classifyMessaging(fromContact({ postback: { payload: 'aut_x::run_a' } }));
    const second = classifyMessaging(fromContact({ postback: { payload: 'aut_x::run_b' } }));

    expect(first.eventKey).not.toBe(second.eventKey);
  });

  it('a read receipt is `read:<read.mid>`, never the key of the message it read (gap 2)', () => {
    const read = classifyMessaging(fromContact({ read: { mid: 'm_text' } }));
    const message = classifyMessaging(fromContact({ message: { mid: 'm_text' } }));

    expect(read).toMatchObject({
      eventKind: 'read',
      eventKey: 'read:m_text',
      kindSkipReason: 'read_receipt',
    });
    expect(read.eventKey).not.toBe(message.eventKey);
  });

  it('a reaction is `reaction:<mid>:<action>:<timestamp>`, skipped `reaction`', () => {
    const event = classifyMessaging(
      fromContact({ reaction: { mid: 'm_text', action: 'react', reaction: 'love' } }),
    );

    expect(event).toMatchObject({
      eventKind: 'reaction',
      eventKey: `reaction:m_text:react:${ITEM_TIME_MILLISECONDS}`,
      kindSkipReason: 'reaction',
    });
  });

  it('a react and its unreact are two events', () => {
    const react = classifyMessaging(fromContact({ reaction: { mid: 'm_text', action: 'react' } }));
    const unreact = classifyMessaging(
      fromContact({ reaction: { mid: 'm_text', action: 'unreact' } }),
    );

    expect(react.eventKey).not.toBe(unreact.eventKey);
  });

  it('an edit is `edit:<mid>:<num_edit>`, skipped `edit`', () => {
    const event = classifyMessaging(
      fromContact({ message_edit: { mid: 'm_text', text: 'new text', num_edit: 2 } }),
    );

    expect(event).toMatchObject({
      eventKind: 'edit',
      eventKey: 'edit:m_text:2',
      kindSkipReason: 'edit',
    });
  });

  it('any other item is `messaging:<SHA-256 of item>`, skipped `unsupported`', () => {
    const item = fromContact({ referral: { ref: 'ad_1', source: 'ADS' } });

    expect(classifyMessaging(item)).toMatchObject({
      eventKind: 'unknown',
      eventKey: `messaging:${sha256(JSON.stringify(item))}`,
      kindSkipReason: 'unsupported',
      contactInstagramUserId: CONTACT_ID,
    });
  });

  it('a message without `mid` falls to `unsupported` — it has nothing to key on', () => {
    const event = classifyMessaging(fromContact({ message: { text: 'no id' } }));

    expect(event.eventKind).toBe('unknown');
    expect(event.eventKey).toMatch(/^messaging:[0-9a-f]{64}$/);
  });

  it('a sender id that is not digits is no contact', () => {
    const event = classifyMessaging({
      sender: { id: 'not-an-id' },
      message: { mid: 'm_odd' },
    });

    expect(event.contactInstagramUserId).toBeNull();
  });

  it('falls back to the entry time when the item has none, and to null when neither reads', () => {
    expect(
      classifyMessaging({ sender: { id: CONTACT_ID }, message: { mid: 'm1' } }).occurredAt,
    ).toEqual(new Date(ENTRY_TIME_SECONDS * 1000));
    expect(
      classifyInstagramWebhookItem({
        source: 'messaging',
        item: { sender: { id: CONTACT_ID }, message: { mid: 'm2' } },
        accountIds: ACCOUNT_IDS,
        entryTime: undefined,
      }).occurredAt,
    ).toBeNull();
  });
});

describe('buildInstagramWebhookEventKey — at most 512 characters', () => {
  it('keeps a key of 512 characters as it is', () => {
    const key = buildInstagramWebhookEventKey({ prefix: 'message', parts: ['m'.repeat(504)] });
    expect(key).toHaveLength(512);
    expect(key).toBe(`message:${'m'.repeat(504)}`);
  });

  it('stores a longer one as `<prefix>:sha256:<64 hex>` of its parts', () => {
    const parts = ['m'.repeat(505)];
    const key = buildInstagramWebhookEventKey({ prefix: 'message', parts });
    expect(key).toBe(`message:sha256:${sha256(parts.join(':'))}`);
    expect(key.length).toBeLessThanOrEqual(512);
  });

  it('a long mid from Meta still gives a stable key', () => {
    const item = fromContact({ message: { mid: 'x'.repeat(600) } });
    expect(classifyMessaging(item).eventKey).toBe(classifyMessaging(item).eventKey);
    expect(classifyMessaging(item).eventKey).toMatch(/^message:sha256:[0-9a-f]{64}$/);
  });
});

describe('listInstagramWebhookEntryItems — one event per item (WH9)', () => {
  it('lists the changes[] items, then the messaging[] items, each with its source', () => {
    const comment = { field: 'comments', value: { id: '1' } };
    const message = fromContact({ message: { mid: 'm' } });

    expect(listInstagramWebhookEntryItems({ changes: [comment], messaging: [message] })).toEqual({
      items: [
        { source: 'changes', item: comment },
        { source: 'messaging', item: message },
      ],
      droppedItemCount: 0,
    });
  });

  it('counts the items that are not JSON objects instead of listing them', () => {
    const result = listInstagramWebhookEntryItems({ changes: ['text', null, []], messaging: [7] });
    expect(result).toEqual({ items: [], droppedItemCount: 4 });
  });

  it('an entry with neither list has no items', () => {
    expect(listInstagramWebhookEntryItems({})).toEqual({ items: [], droppedItemCount: 0 });
  });
});

describe('readInstagramWebhookUserId and readInstagramWebhookTime', () => {
  it.each([
    ['17841400000000001', '17841400000000001'],
    [17841400, '17841400'],
    ['', null],
    ['12a', null],
    ['1'.repeat(65), null],
    [-1, null],
    [1.5, null],
    [undefined, null],
  ])('reads %j as %j', (value, expected) => {
    expect(readInstagramWebhookUserId(value)).toBe(expected);
  });

  it('reads Unix seconds and milliseconds, numbers and digit strings', () => {
    expect(readInstagramWebhookTime(ENTRY_TIME_SECONDS)).toEqual(
      new Date(ENTRY_TIME_SECONDS * 1000),
    );
    expect(readInstagramWebhookTime(ITEM_TIME_MILLISECONDS)).toEqual(
      new Date(ITEM_TIME_MILLISECONDS),
    );
    expect(readInstagramWebhookTime(String(ITEM_TIME_MILLISECONDS))).toEqual(
      new Date(ITEM_TIME_MILLISECONDS),
    );
  });

  it.each([0, -5, 'soon', Number.NaN, undefined, null, '9'.repeat(17)])(
    'reads %j as no time',
    (value) => {
      expect(readInstagramWebhookTime(value)).toBeNull();
    },
  );
});
