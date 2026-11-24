import { describe, expect, it } from 'vitest';
import { serializeInstagramWebhookEvent } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.serializer.js';

/**
 * The Instagram webhook event object (feat-instagram-dm-sending routes-final § 5.B.6): exact keys,
 * the channel account's `cha_` id, `next_attempt_at`, a masked payload — `null` once done (WH22).
 */

const RECEIVED_AT = new Date('2026-11-21T09:00:01.000Z');

function buildRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    public_id: 'iwe_k3m9p2q7r5t1v8w4x6y0z',
    organization_id: 7,
    channel_account_id: 9,
    channel_account_public_id: 'cha_a1b2c3d4e5f6g7h8i9j0k',
    instagram_user_id: '17841400000000001',
    contact_instagram_user_id: '17841400000000777',
    event_kind: 'message',
    intake_group: 'messages',
    event_key: 'message:mid-1',
    status: 'failed',
    skip_reason: null,
    error_message: 'processing_attempts_exhausted',
    attempt_count: 1,
    last_attempted_at: new Date('2026-11-21T09:00:02.000Z'),
    next_attempt_at: new Date('2026-11-21T10:00:03.000Z'),
    payload: {
      sender: { id: '17841400000000777' },
      recipient: { id: '17841400000000001' },
      timestamp: 1_732_186_000_000,
      message: { mid: 'mid-1', text: 'my email is rimeet@gmail.com, thanks a lot for the help' },
    },
    occurred_at: new Date('2026-11-21T08:59:59.000Z'),
    processed_at: new Date('2026-11-21T09:00:03.000Z'),
    request_id: 'req-123',
    created_at: RECEIVED_AT,
    updated_at: new Date('2026-11-21T09:00:03.000Z'),
    ...overrides,
  };
}

describe('serializeInstagramWebhookEvent', () => {
  it('names exactly the 5.B.6 keys — never the internal ids, the group, the lease or the request id', () => {
    const output = serializeInstagramWebhookEvent(buildRow());
    expect(Object.keys(output).sort()).toEqual(
      [
        'id',
        'channel_account_id',
        'instagram_user_id',
        'contact_instagram_user_id',
        'event_kind',
        'event_key',
        'status',
        'skip_reason',
        'error_message',
        'attempt_count',
        'next_attempt_at',
        'payload',
        'occurred_at',
        'received_at',
        'processed_at',
      ].sort(),
    );
    expect(JSON.stringify(output)).not.toContain('req-123');
    expect(JSON.stringify(output)).not.toContain('messages');
  });

  it('maps the public id, received_at from created_at and ISO timestamps', () => {
    expect(serializeInstagramWebhookEvent(buildRow())).toMatchObject({
      id: 'iwe_k3m9p2q7r5t1v8w4x6y0z',
      channel_account_id: 'cha_a1b2c3d4e5f6g7h8i9j0k',
      instagram_user_id: '17841400000000001',
      contact_instagram_user_id: '17841400000000777',
      event_kind: 'message',
      event_key: 'message:mid-1',
      status: 'failed',
      skip_reason: null,
      error_message: 'processing_attempts_exhausted',
      attempt_count: 1,
      next_attempt_at: '2026-11-21T10:00:03.000Z',
      occurred_at: '2026-11-21T08:59:59.000Z',
      received_at: '2026-11-21T09:00:01.000Z',
      processed_at: '2026-11-21T09:00:03.000Z',
    });
  });

  it('returns the payload masked — the email masked, the text cut to 40 characters', () => {
    const output = serializeInstagramWebhookEvent(buildRow());
    expect(output.payload).toEqual({
      sender: { id: '17841400000000777' },
      recipient: { id: '17841400000000001' },
      timestamp: 1_732_186_000_000,
      message: { mid: 'mid-1', text: 'my email is r***@g***.com, thanks a lot ' },
    });
    expect(JSON.stringify(output)).not.toContain('rimeet@gmail.com');
  });

  it('carries a skipped event’s reason, a null body once done, and a waiting event’s empty times', () => {
    for (const skipReason of ['own_comment', 'flood']) {
      expect(
        serializeInstagramWebhookEvent(
          buildRow({
            status: 'skipped',
            skip_reason: skipReason,
            error_message: null,
            next_attempt_at: null,
            payload: null,
            processed_at: RECEIVED_AT,
          }),
        ),
      ).toMatchObject({ status: 'skipped', skip_reason: skipReason, payload: null });
    }
    expect(
      serializeInstagramWebhookEvent(
        buildRow({
          status: 'processed',
          error_message: null,
          next_attempt_at: null,
          payload: null,
        }),
      ),
    ).toMatchObject({ status: 'processed', payload: null, next_attempt_at: null });
    expect(
      serializeInstagramWebhookEvent(
        buildRow({
          status: 'received',
          error_message: null,
          next_attempt_at: null,
          attempt_count: 0,
          occurred_at: null,
          processed_at: null,
          contact_instagram_user_id: null,
        }),
      ),
    ).toMatchObject({
      status: 'received',
      occurred_at: null,
      processed_at: null,
      contact_instagram_user_id: null,
    });
  });

  it('carries a failed event’s error code', () => {
    expect(
      serializeInstagramWebhookEvent(
        buildRow({
          status: 'failed',
          error_message: 'processing_attempts_exhausted',
          attempt_count: 5,
        }),
      ),
    ).toMatchObject({
      status: 'failed',
      error_message: 'processing_attempts_exhausted',
      attempt_count: 5,
    });
  });
});
