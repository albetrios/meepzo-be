import { describe, expect, it } from 'vitest';
import { validateListInstagramWebhookEventsQuery } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.validator.js';
import { ValidationError } from '@/shared/errors/index.js';

/** Route 18's query (routes-final § 4.B.8, 4.B.9): every filter, the page and the refusals. */

function fieldsOf(call: () => unknown): string[] {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).errors?.map((item) => item.field) ?? [];
  }
  throw new Error('a ValidationError was expected');
}

describe('validateListInstagramWebhookEventsQuery', () => {
  it('defaults to the first page of 25, no filter and no count', () => {
    expect(validateListInstagramWebhookEventsQuery({})).toEqual({
      status: undefined,
      eventKind: undefined,
      receivedFrom: undefined,
      receivedTo: undefined,
      limit: 25,
      after: undefined,
      includeTotal: false,
    });
  });

  it('reads every filter, the page and the count opt-in', () => {
    expect(
      validateListInstagramWebhookEventsQuery({
        status: 'failed',
        event_kind: 'story_reply',
        received_from: '2026-11-20T00:00:00Z',
        received_to: '2026-11-21T05:30:00+05:30',
        limit: '100',
        after: 'opaque-cursor',
        include_total: 'true',
      }),
    ).toEqual({
      status: 'failed',
      eventKind: 'story_reply',
      receivedFrom: '2026-11-20T00:00:00Z',
      receivedTo: '2026-11-21T05:30:00+05:30',
      limit: 100,
      after: 'opaque-cursor',
      includeTotal: true,
    });
  });

  it.each([
    ['status', { status: 'done' }],
    ['status', { status: 'unknown_account' }],
    ['event_kind', { event_kind: 'mention' }],
    ['received_from', { received_from: '2026-11-20' }],
    ['received_from', { received_from: '2026-11-20T00:00:00' }],
    ['received_to', { received_to: 'yesterday' }],
    ['limit', { limit: '0' }],
    ['limit', { limit: '101' }],
    ['include_total', { include_total: 'yes' }],
  ])('refuses a bad %s', (field, query) => {
    expect(fieldsOf(() => validateListInstagramWebhookEventsQuery(query))).toContain(field);
  });

  it.each([
    ['equal', '2026-11-21T00:00:00Z', '2026-11-21T00:00:00Z'],
    ['after', '2026-11-22T00:00:00Z', '2026-11-21T00:00:00Z'],
    // The same instant written with two offsets: not before.
    ['the same instant', '2026-11-21T05:30:00+05:30', '2026-11-21T00:00:00Z'],
  ])('refuses a received_from %s received_to, on received_to', (_case, from, to) => {
    expect(
      fieldsOf(() =>
        validateListInstagramWebhookEventsQuery({ received_from: from, received_to: to }),
      ),
    ).toEqual(['received_to']);
  });

  it('refuses an unknown parameter', () => {
    expect(() => validateListInstagramWebhookEventsQuery({ payload: 'x' })).toThrow(
      ValidationError,
    );
  });
});
