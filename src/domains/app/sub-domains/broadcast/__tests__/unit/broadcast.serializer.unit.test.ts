import { describe, expect, it } from 'vitest';
import { serializeBroadcast } from '@/domains/app/sub-domains/broadcast/broadcast.serializer.js';

describe('serializeBroadcast (routes-final § 7.A.6)', () => {
  it('answers public ids, ISO instants and the six numbers — never internal ids', () => {
    const created = new Date('2026-11-25T09:00:00.000Z');
    const output = serializeBroadcast({
      broadcast: {
        public_id: 'brc_000000000000000000001',
        name: 'Drop',
        status: 'waiting_for_chats',
        mode: 'when_chat_opens',
        conditions: { op: 'and', items: [{ field: 'details', has: 'email' }] },
        messages: [{ kind: 'text', wait_minutes: 0, text: 'Hi' }],
        scheduled_at: null,
        ends_at: new Date('2026-11-28T09:00:00.000Z'),
        started_at: created,
        finished_at: null,
        cancelled_at: null,
        cancel_reason: null,
        matched: 10,
        sent: 4,
        skipped: 1,
        failed: 0,
        replies: 2,
        taps: 1,
        created_at: created,
        updated_at: created,
        channel_account_public_id: 'cha_000000000000000000001',
        segment_public_id: null,
        start_automation_public_id: 'aut_000000000000000000001',
      },
      created_by_user_public_id: null,
    });
    expect(output).toEqual({
      id: 'brc_000000000000000000001',
      channel_account_id: 'cha_000000000000000000001',
      name: 'Drop',
      status: 'waiting_for_chats',
      mode: 'when_chat_opens',
      segment_id: null,
      conditions: { op: 'and', items: [{ field: 'details', has: 'email' }] },
      messages: [{ kind: 'text', wait_minutes: 0, text: 'Hi' }],
      start_automation_id: 'aut_000000000000000000001',
      scheduled_at: null,
      ends_at: '2026-11-28T09:00:00.000Z',
      started_at: '2026-11-25T09:00:00.000Z',
      finished_at: null,
      cancelled_at: null,
      cancel_reason: null,
      numbers: { matched: 10, sent: 4, skipped: 1, failed: 0, replies: 2, taps: 1 },
      created_by_user_id: null,
      created_at: '2026-11-25T09:00:00.000Z',
      updated_at: '2026-11-25T09:00:00.000Z',
    });
  });
});
