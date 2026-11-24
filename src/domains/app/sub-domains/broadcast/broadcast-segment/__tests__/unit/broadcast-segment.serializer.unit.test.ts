import { describe, expect, it } from 'vitest';
import {
  serializeSegment,
  serializeSegmentAudienceCount,
} from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.serializer.js';

/** The Segment and Audience count objects (routes-final § 7.B.6). */
describe('broadcast-segment serializer', () => {
  it('shapes a segment with public ids only and counts its conditions in every group', () => {
    const output = serializeSegment({
      segment: {
        public_id: 'seg_a1b2c3d4e5f6g7h8i9j0k',
        channel_account_public_id: 'cha_a1b2c3d4e5f6g7h8i9j0k',
        name: 'VIPs',
        conditions: {
          op: 'and',
          items: [
            { field: 'tags', match: 'any', values: ['vip'] },
            {
              op: 'or',
              items: [
                { field: 'details', has: 'email' },
                { field: 'details', has: 'phone' },
              ],
            },
          ],
        },
        created_at: new Date('2026-11-24T10:00:00.000Z'),
        updated_at: new Date('2026-11-24T11:00:00.000Z'),
      },
      created_by_user_public_id: 'usr_a1b2c3d4e5f6g7h8i9j0k',
    });
    expect(output).toEqual({
      id: 'seg_a1b2c3d4e5f6g7h8i9j0k',
      channel_account_id: 'cha_a1b2c3d4e5f6g7h8i9j0k',
      name: 'VIPs',
      conditions: expect.any(Object),
      condition_count: 3,
      created_by_user_id: 'usr_a1b2c3d4e5f6g7h8i9j0k',
      created_at: '2026-11-24T10:00:00.000Z',
      updated_at: '2026-11-24T11:00:00.000Z',
    });
  });

  it('answers the numbers, or the counting answer with null numbers (BC14)', () => {
    expect(
      serializeSegmentAudienceCount({
        matched: 10,
        canReceiveNow: 4,
        countedAt: new Date('2026-11-24T10:00:00.000Z'),
      }),
    ).toEqual({
      matched: 10,
      can_receive_now: 4,
      is_counting: false,
      counted_at: '2026-11-24T10:00:00.000Z',
    });
    expect(serializeSegmentAudienceCount(null)).toEqual({
      matched: null,
      can_receive_now: null,
      is_counting: true,
      counted_at: null,
    });
  });
});
