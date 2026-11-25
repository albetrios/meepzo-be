import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import { publicIdPlaceholderFor } from '@/shared/utils/identity/public-id.util.js';
import {
  validateCreateBroadcastBody,
  validateEmptyBroadcastAction,
  validateListBroadcastsQuery,
  validateSendBroadcastBody,
  validateUpdateBroadcastBody,
} from '@/domains/app/sub-domains/broadcast/broadcast.validator.js';

const ACCOUNT_ID = publicIdPlaceholderFor('channelAccount');
const SEGMENT_ID = publicIdPlaceholderFor('segment');
const AUTOMATION_ID = publicIdPlaceholderFor('automation');
const EMAIL_CONDITIONS = { op: 'and', items: [{ field: 'details', has: 'email' }] };
const TEXT_MESSAGE = { kind: 'text', wait_minutes: 0, text: 'Hi' };
const DAY_MS = 24 * 60 * 60 * 1000;

/** The `errors[].field` values a call throws (`(body)` when none is named), or `[]` when it passes. */
function fieldsOf(call: () => unknown): string[] {
  try {
    call();
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    const fields = ((error as ValidationError).errors ?? []).map((item) => item.field);
    return fields.length === 0 ? ['(body)'] : fields;
  }
}

describe('broadcast validator (routes-final § 7.A.8, BC8, BC10)', () => {
  it('parses a draft with an audience, 0–3 messages and a button automation', () => {
    expect(
      validateCreateBroadcastBody({
        channel_account_id: ACCOUNT_ID,
        name: '  Drop  ',
        conditions: EMAIL_CONDITIONS,
        messages: [TEXT_MESSAGE, TEXT_MESSAGE, TEXT_MESSAGE],
        start_automation_id: AUTOMATION_ID,
      }),
    ).toMatchObject({
      channelAccountPublicId: ACCOUNT_ID,
      name: 'Drop',
      conditions: EMAIL_CONDITIONS,
      startAutomationPublicId: AUTOMATION_ID,
    });
    expect(
      validateCreateBroadcastBody({ channel_account_id: ACCOUNT_ID, name: 'x', messages: [] })
        .messages,
    ).toEqual([]);
  });

  it('refuses 4 messages, both audiences, a malformed id, an unknown field and over 64 KB (AC-9.4)', () => {
    const base = { channel_account_id: ACCOUNT_ID, name: 'x' };
    expect(
      fieldsOf(() =>
        validateCreateBroadcastBody({ ...base, messages: Array(4).fill(TEXT_MESSAGE) }),
      ),
    ).toEqual(['messages']);
    expect(
      fieldsOf(() =>
        validateCreateBroadcastBody({
          ...base,
          segment_id: SEGMENT_ID,
          conditions: EMAIL_CONDITIONS,
        }),
      ),
    ).toEqual(['conditions']);
    expect(fieldsOf(() => validateCreateBroadcastBody({ ...base, segment_id: 'seg_x' }))).toEqual([
      'segment_id',
    ]);
    expect(fieldsOf(() => validateCreateBroadcastBody({ ...base, status: 'done' }))).not.toEqual(
      [],
    );
    const large = { ...TEXT_MESSAGE, text: 'x'.repeat(70_000) };
    expect(fieldsOf(() => validateCreateBroadcastBody({ ...base, messages: [large] }))).toEqual([
      'messages',
    ]);
  });

  it("runs each message's own automation checks with its body path", () => {
    expect(
      fieldsOf(() =>
        validateCreateBroadcastBody({
          channel_account_id: ACCOUNT_ID,
          name: 'x',
          messages: [
            TEXT_MESSAGE,
            {
              kind: 'text',
              wait_minutes: 0,
              text: 'Go',
              buttons: [{ title: 'Shop', url: 'http://a' }],
            },
          ],
        }),
      ),
    ).toEqual(['body.messages.1.buttons.0.url']);
  });

  it('needs one field on an edit; null clears an audience or the button', () => {
    expect(fieldsOf(() => validateUpdateBroadcastBody({}))).not.toEqual([]);
    expect(
      validateUpdateBroadcastBody({ segment_id: null, start_automation_id: null }),
    ).toMatchObject({ segmentPublicId: null, startAutomationPublicId: null });
  });

  it('parses each send mode and refuses a field of another mode, a past or far time and 8 days', () => {
    const at = new Date(Date.now() + DAY_MS).toISOString();
    expect(validateSendBroadcastBody({ mode: 'now' })).toEqual({ mode: 'now' });
    expect(validateSendBroadcastBody({ mode: 'scheduled', scheduled_at: at })).toEqual({
      mode: 'scheduled',
      scheduledAt: new Date(at),
    });
    expect(validateSendBroadcastBody({ mode: 'when_chat_opens', open_wait_days: 7 })).toEqual({
      mode: 'when_chat_opens',
      openWaitDays: 7,
    });
    expect(fieldsOf(() => validateSendBroadcastBody({ mode: 'now', scheduled_at: at }))).toEqual([
      'scheduled_at',
    ]);
    expect(fieldsOf(() => validateSendBroadcastBody({ mode: 'when_chat_opens' }))).toEqual([
      'open_wait_days',
    ]);
    expect(
      fieldsOf(() =>
        validateSendBroadcastBody({
          mode: 'scheduled',
          scheduled_at: new Date(Date.now() - 1000).toISOString(),
        }),
      ),
    ).toEqual(['scheduled_at']);
    expect(
      fieldsOf(() =>
        validateSendBroadcastBody({
          mode: 'scheduled',
          scheduled_at: new Date(Date.now() + 31 * DAY_MS).toISOString(),
        }),
      ),
    ).toEqual(['scheduled_at']);
    expect(
      fieldsOf(() => validateSendBroadcastBody({ mode: 'when_chat_opens', open_wait_days: 8 })),
    ).toEqual(['open_wait_days']);
  });

  it('parses the list query with several statuses and refuses a repeated one', () => {
    expect(
      validateListBroadcastsQuery({
        channel_account_id: ACCOUNT_ID,
        status: 'draft,sending',
        mode: 'now',
        limit: '10',
      }),
    ).toMatchObject({ statuses: ['draft', 'sending'], mode: 'now', limit: 10 });
    expect(
      fieldsOf(() =>
        validateListBroadcastsQuery({ channel_account_id: ACCOUNT_ID, status: 'draft,draft' }),
      ),
    ).toEqual(['status']);
    expect(fieldsOf(() => validateListBroadcastsQuery({}))).toEqual(['channel_account_id']);
  });

  it('takes a strictly empty cancel body', () => {
    expect(() => validateEmptyBroadcastAction(undefined)).not.toThrow();
    expect(() => validateEmptyBroadcastAction({})).not.toThrow();
    expect(fieldsOf(() => validateEmptyBroadcastAction({ reason: 'x' }))).not.toEqual([]);
  });
});
