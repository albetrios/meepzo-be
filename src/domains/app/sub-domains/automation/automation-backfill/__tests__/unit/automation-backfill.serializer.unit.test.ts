import { describe, expect, it } from 'vitest';
import { serializeAutomationBackfill } from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.serializer.js';

/** The Automation backfill object (feat-instagram-dm-sending routes-final § 4.C.6). */
describe('serializeAutomationBackfill', () => {
  const row = {
    id: 41,
    public_id: 'abf_q7w2e9r4t1y6u3i8a1b2c',
    organization_id: 7,
    channel_account_id: 9,
    automation_id: 12,
    days: 3,
    status: 'failed',
    posts_read: 4,
    found: 120,
    matched: 31,
    queued_count: 30,
    fail_reason: 'meta_error',
    last_error: 'meta_error_code:2',
    requested_by_user_id: 5,
    created_at: new Date('2026-11-21T09:00:00.000Z'),
    started_at: new Date('2026-11-21T09:00:05.000Z'),
    done_at: null,
    updated_at: new Date('2026-11-21T09:10:00.000Z'),
  };

  it('returns the public ids, the counters and the times, never internal ids or last_error', () => {
    const output = serializeAutomationBackfill({
      backfill: row,
      automation_public_id: 'aut_m4q8x2k7p9r3t1v5a1b2c',
      requested_by_user_public_id: 'usr_a1b2c3d4e5f6g7h8i9j0k',
    });
    expect(output).toEqual({
      id: 'abf_q7w2e9r4t1y6u3i8a1b2c',
      automation_id: 'aut_m4q8x2k7p9r3t1v5a1b2c',
      days: 3,
      status: 'failed',
      posts_read: 4,
      found: 120,
      matched: 31,
      queued_count: 30,
      fail_reason: 'meta_error',
      requested_by_user_id: 'usr_a1b2c3d4e5f6g7h8i9j0k',
      created_at: '2026-11-21T09:00:00.000Z',
      started_at: '2026-11-21T09:00:05.000Z',
      done_at: null,
      updated_at: '2026-11-21T09:10:00.000Z',
    });
    expect(JSON.stringify(output)).not.toContain('meta_error_code');
  });

  it('keeps a deleted person as null', () => {
    const output = serializeAutomationBackfill({
      backfill: { ...row, status: 'queued', fail_reason: null, started_at: null },
      automation_public_id: 'aut_m4q8x2k7p9r3t1v5a1b2c',
      requested_by_user_public_id: null,
    });
    expect(output).toMatchObject({
      requested_by_user_id: null,
      started_at: null,
      fail_reason: null,
    });
  });
});
