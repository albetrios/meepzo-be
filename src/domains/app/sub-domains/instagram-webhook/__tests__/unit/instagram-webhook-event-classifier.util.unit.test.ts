import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type ClassifiedInstagramWebhookEvent,
  type InstagramWebhookAccountIds,
  buildInstagramWebhookEventKey,
  classifyInstagramWebhookItem,
  listInstagramWebhookEntryItems,
  readInstagramWebhookTime,
  readInstagramWebhookUserId,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event-classifier.util.js';

/**
 * The one pure classifier of the Instagram webhook (feat-instagram-dm-sending routes-final § 5.A.10,
 * WH8, WHC5): every row of the table — kind, key, skip reason, contact, time — the launch's three
 * key gaps, the account's own comment and DM, the dropped read receipt, and the 512-character key
 * rule.
 */

const ACCOUNT_IDS: InstagramWebhookAccountIds = {
  instagramUserId: '17841400000000001',
};
const CONTACT_ID = '17841400000000777';
const OTHER_ACCOUNT_ID = '17841400000000555';
/** Meta's entry time in seconds (a `changes[]` delivery) and an item time in milliseconds. */
const ENTRY_TIME_SECONDS = 1_763_726_400;
const ITEM_TIME_MILLISECONDS = 1_763_726_401_234;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The classified event — failing the test when the classifier dropped the item. */
function saved(event: ClassifiedInstagramWebhookEvent | null): ClassifiedInstagramWebhookEvent {
  if (event === null) throw new Error('the classifier dropped an item it should save');
  return event;
}

function classifyChange(item: Record<string, unknown>): ClassifiedInstagramWebhookEvent {
  return saved(
    classifyInstagramWebhookItem({
      source: 'changes',
      item,
      accountIds: ACCOUNT_IDS,
      entryTime: ENTRY_TIME_SECONDS,
    }),
  );
}

function classifyMessaging(item: Record<string, unknown>): ClassifiedInstagramWebhookEvent {
  return saved(
    classifyInstagramWebhookItem({
      source: 'messaging',
      item,
      accountIds: ACCOUNT_IDS,
      entryTime: ENTRY_TIME_SECONDS,
    }),
  );
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

describe('classifyInstagramWebhookItem — changes[] (5.A.10)', () => {
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

  it.each([['Instagram user id', ACCOUNT_IDS.instagramUserId]])(
    'a comment by the account itself (its %s) is skipped `own_comment` (P24), naming nobody',
    (_label, id) => {
      const event = classifyChange({
        field: 'comments',
        value: { id: '18000000000000002', from: { id } },
      });

      expect(event).toMatchObject({
        eventKind: 'comment',
        eventKey: 'comment:18000000000000002',
        kindSkipReason: 'own_comment',
        contactInstagramUserId: null,
      });
    },
  );

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

  it('a Live comment is `live_comment:<value.id>`, received, the commenter as contact (WH8)', () => {
    const item = {
      field: 'live_comments',
      value: { id: '18000000000000077', from: { id: CONTACT_ID }, media: { id: '1790000000001' } },
    };

    expect(classifyChange(item)).toEqual({
      eventKind: 'live_comment',
      eventKey: 'live_comment:18000000000000077',
      kindSkipReason: null,
      contactInstagramUserId: CONTACT_ID,
      occurredAt: new Date(ENTRY_TIME_SECONDS * 1000),
      payload: item,
    });
  });

  it('the account’s own Live comment is skipped `own_comment` like its own comment (P24)', () => {
    const event = classifyChange({
      field: 'live_comments',
      value: { id: '18000000000000078', from: { id: ACCOUNT_IDS.instagramUserId } },
    });

    expect(event).toMatchObject({
      eventKind: 'live_comment',
      kindSkipReason: 'own_comment',
      contactInstagramUserId: null,
    });
  });

  it('a Unified Login comment keyed `comment_id` (Meta docs example) is `comment:<comment_id>`, received', () => {
    for (const field of ['comments', 'live_comments']) {
      const kind = field === 'comments' ? 'comment' : 'live_comment';
      expect(
        classifyChange({
          field,
          value: {
            from: { id: CONTACT_ID, username: 'acme_customer' },
            comment_id: '18000000000000042',
            text: 'price?',
            media: { id: '17900000000000001' },
          },
        }),
      ).toMatchObject({
        eventKind: kind,
        eventKey: `${kind}:18000000000000042`,
        kindSkipReason: null,
        contactInstagramUserId: CONTACT_ID,
      });
    }
  });

  it('a comment change without a comment id falls to `unsupported`', () => {
    const event = classifyChange({ field: 'comments', value: { from: { id: CONTACT_ID } } });

    expect(event.eventKind).toBe('unknown');
    expect(event.kindSkipReason).toBe('unsupported');
    expect(event.eventKey).toMatch(/^change:comments:[0-9a-f]{64}$/);
  });
});

describe('classifyInstagramWebhookItem — messaging[] (5.A.10)', () => {
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

  it('a story mention (a `story_mention` attachment) is `story_mention`, keyed `message:<mid>`', () => {
    const event = classifyMessaging(
      fromContact({
        message: {
          mid: 'm_mention',
          attachments: [{ type: 'story_mention', payload: { url: 'https://x.test/s' } }],
        },
      }),
    );

    expect(event).toMatchObject({
      eventKind: 'story_mention',
      eventKey: 'message:m_mention',
      kindSkipReason: null,
      contactInstagramUserId: CONTACT_ID,
    });
  });

  it.each([['share'], ['ig_post']])(
    'a message sharing a post (`%s` attachment) is `shared_post`, keyed `message:<mid>`',
    (type) => {
      const event = classifyMessaging(
        fromContact({ message: { mid: 'm_share', attachments: [{ type, payload: {} }] } }),
      );

      expect(event).toMatchObject({
        eventKind: 'shared_post',
        eventKey: 'message:m_share',
        kindSkipReason: null,
      });
    },
  );

  it('an echo (`is_echo`) is `echo:<mid>`, received for the quiet time, the recipient as contact, its mid kept (WH10)', () => {
    const event = classifyMessaging({
      sender: { id: ACCOUNT_IDS.instagramUserId },
      recipient: { id: CONTACT_ID },
      timestamp: ITEM_TIME_MILLISECONDS,
      message: { mid: 'm_echo', is_echo: true, text: 'sent by hand' },
    });

    expect(event).toMatchObject({
      eventKind: 'echo',
      eventKey: 'echo:m_echo',
      kindSkipReason: null,
      contactInstagramUserId: CONTACT_ID,
      echoMessageId: 'm_echo',
    });
  });

  it('a message marked `is_self` is an echo too', () => {
    const event = classifyMessaging({
      sender: { id: CONTACT_ID },
      recipient: { id: CONTACT_ID },
      message: { mid: 'm_self', is_self: true },
    });

    expect(event).toMatchObject({
      eventKind: 'echo',
      eventKey: 'echo:m_self',
      kindSkipReason: null,
    });
  });

  it('only an echo carries `echoMessageId`', () => {
    expect(classifyMessaging(fromContact({ message: { mid: 'm_plain' } }))).not.toHaveProperty(
      'echoMessageId',
    );
  });

  it('a message sent by the account itself (its Instagram user id) is an echo even without `is_echo`', () => {
    const event = classifyMessaging({
      sender: { id: ACCOUNT_IDS.instagramUserId },
      recipient: { id: CONTACT_ID },
      message: { mid: 'm_own' },
    });

    expect(event).toMatchObject({
      eventKind: 'echo',
      eventKey: 'echo:m_own',
      kindSkipReason: null,
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

  it('a tap whose payload starts `starter:` is a starter question (`ice_breaker`), keyed as a postback', () => {
    const withMid = classifyMessaging(
      fromContact({ postback: { mid: 'm_starter', title: 'Prices?', payload: 'starter:prices' } }),
    );
    const withoutMid = classifyMessaging(fromContact({ postback: { payload: 'starter:prices' } }));

    expect(withMid).toMatchObject({
      eventKind: 'ice_breaker',
      eventKey: 'postback:m_starter',
      kindSkipReason: null,
      contactInstagramUserId: CONTACT_ID,
    });
    expect(withoutMid).toMatchObject({
      eventKind: 'ice_breaker',
      eventKey: `postback:${CONTACT_ID}:${ITEM_TIME_MILLISECONDS}:${sha256('starter:prices')}`,
    });
  });

  it('a `messaging_referral` is `referral:<sender>:<time>:<SHA-256 of ref and source>`, received', () => {
    const item = fromContact({
      referral: { ref: 'summer', source: 'SHORTLINK', type: 'OPEN_THREAD' },
    });

    expect(classifyMessaging(item)).toEqual({
      eventKind: 'referral',
      eventKey: `referral:${CONTACT_ID}:${ITEM_TIME_MILLISECONDS}:${sha256(
        JSON.stringify({ ref: 'summer', source: 'SHORTLINK' }),
      )}`,
      kindSkipReason: null,
      contactInstagramUserId: CONTACT_ID,
      occurredAt: new Date(ITEM_TIME_MILLISECONDS),
      payload: item,
    });
  });

  it('a message carrying an ad `referral` is a `referral`, not a `message`', () => {
    const event = classifyMessaging(
      fromContact({
        message: { mid: 'm_ad', text: 'hi', referral: { ad_id: '120000000', source: 'ADS' } },
      }),
    );

    expect(event).toMatchObject({ eventKind: 'referral', kindSkipReason: null });
    expect(event.eventKey).toMatch(
      new RegExp(`^referral:${CONTACT_ID}:${ITEM_TIME_MILLISECONDS}:`),
    );
  });

  it('a click-to-DM ad message (Meta docs example, with `ads_context_data`) stays a `referral` and keeps her text in its payload', () => {
    const item = fromContact({
      message: {
        mid: 'm_ad_2',
        text: 'Is this still in stock?',
        referral: {
          ref: 'spring-sale',
          ad_id: '23850000000000002',
          source: 'ADS',
          type: 'OPEN_THREAD',
          ads_context_data: { ad_title: 'Spring sale', video_url: 'https://cdn.example/v.mp4' },
        },
      },
    });

    const event = classifyMessaging(item);
    expect(event).toMatchObject({ eventKind: 'referral', kindSkipReason: null, payload: item });
  });

  it('a message with unsupported media (`is_unsupported`) is `unsupported:<mid>`, skipped — never a message an automation answers', () => {
    expect(
      classifyMessaging(fromContact({ message: { mid: 'm_odd', is_unsupported: true } })),
    ).toMatchObject({
      eventKind: 'unknown',
      eventKey: 'unsupported:m_odd',
      kindSkipReason: 'unsupported',
    });
  });

  it('a Meta Business Agent handoff notice (`admin_text`, `handoff_reason`) is `handoff:<mid>`, skipped — neither her message nor an owner echo', () => {
    for (const message of [
      {
        mid: 'm_handoff',
        admin_text: 'Conversation handed off',
        handoff_reason: 'human_requested',
      },
      { mid: 'm_handoff', is_echo: true, admin_text: 'Conversation handed off' },
    ]) {
      expect(classifyMessaging(fromContact({ message }))).toMatchObject({
        eventKind: 'unknown',
        eventKey: 'handoff:m_handoff',
        kindSkipReason: 'unsupported',
      });
    }
  });

  it('a shared reel (`ig_reel`, `reel`) is a `shared_post`, keyed `message:<mid>`', () => {
    for (const type of ['ig_reel', 'reel']) {
      expect(
        classifyMessaging(
          fromContact({ message: { mid: `m_${type}`, attachments: [{ type, payload: {} }] } }),
        ),
      ).toMatchObject({ eventKind: 'shared_post', eventKey: `message:m_${type}` });
    }
  });

  it('two clicks without `mid` on different buttons get different keys', () => {
    const first = classifyMessaging(fromContact({ postback: { payload: 'aut_x::run_a' } }));
    const second = classifyMessaging(fromContact({ postback: { payload: 'aut_x::run_b' } }));

    expect(first.eventKey).not.toBe(second.eventKey);
  });

  it('a read receipt is dropped — never saved (WH8)', () => {
    for (const item of [
      fromContact({ read: { mid: 'm_text' } }),
      { field: 'messages', value: fromContact({ read: { watermark: 1 } }) },
    ]) {
      expect(
        classifyInstagramWebhookItem({
          source: 'field' in item ? 'changes' : 'messaging',
          item,
          accountIds: ACCOUNT_IDS,
          entryTime: ENTRY_TIME_SECONDS,
        }),
      ).toBeNull();
    }
  });

  it('a reaction is `reaction:<mid>:<action>:<timestamp>`, received — it refreshes her window only', () => {
    const event = classifyMessaging(
      fromContact({ reaction: { mid: 'm_text', action: 'react', reaction: 'love' } }),
    );

    expect(event).toMatchObject({
      eventKind: 'reaction',
      eventKey: `reaction:m_text:react:${ITEM_TIME_MILLISECONDS}`,
      kindSkipReason: null,
      contactInstagramUserId: CONTACT_ID,
    });
  });

  it('a react and its unreact are two events', () => {
    const react = classifyMessaging(fromContact({ reaction: { mid: 'm_text', action: 'react' } }));
    const unreact = classifyMessaging(
      fromContact({ reaction: { mid: 'm_text', action: 'unreact' } }),
    );

    expect(react.eventKey).not.toBe(unreact.eventKey);
  });

  it('an unreact is skipped `unsupported` — taking a reaction back never refreshes her window', () => {
    expect(
      classifyMessaging(fromContact({ reaction: { mid: 'm_text', action: 'unreact' } })),
    ).toMatchObject({ eventKind: 'reaction', kindSkipReason: 'unsupported' });
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

  it('any other item (an opt-in, a story repost) is `messaging:<SHA-256 of item>`, skipped `unsupported`', () => {
    const item = fromContact({ optin: { ref: 'newsletter' } });

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
      saved(
        classifyInstagramWebhookItem({
          source: 'messaging',
          item: { sender: { id: CONTACT_ID }, message: { mid: 'm2' } },
          accountIds: ACCOUNT_IDS,
          entryTime: undefined,
        }),
      ).occurredAt,
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
