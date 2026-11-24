import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import { publicIdPlaceholderFor } from '@/shared/utils/identity/public-id.util.js';
import {
  validateCreateSegmentBody,
  validateListSegmentsQuery,
  validateSegmentAudienceCountBody,
  validateUpdateSegmentBody,
} from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.validator.js';

const ACCOUNT_ID = publicIdPlaceholderFor('channelAccount');
const AUTOMATION_ID = publicIdPlaceholderFor('automation');

/** One valid condition of each of the eight fields (BC12). */
const EVERY_FIELD = [
  { field: 'tags', match: 'any', values: ['vip'] },
  { field: 'automation', automation_id: AUTOMATION_ID, state: 'finished' },
  { field: 'automation', automation_id: AUTOMATION_ID, state: 'got_message', message_number: 2 },
  { field: 'came_in', via: 'first_automation', value: AUTOMATION_ID },
  { field: 'came_in', via: 'ref', value: 'spring' },
  { field: 'came_in', via: 'ad' },
  { field: 'commented', post: '18030000000000001', days: 7, keyword: 'price', at_least: 2 },
  { field: 'commented', post: 'any' },
  { field: 'active', last_message_within_hours: 24 },
  { field: 'details', has: 'neither' },
  { field: 'story_activity', days: 30 },
  { field: 'no_broadcast', days: 7 },
] as const;

/** The create body with these conditions. */
function createBody(conditions: unknown): unknown {
  return { channel_account_id: ACCOUNT_ID, name: '  VIPs  ', conditions };
}

/** The `errors[].field` values a refused parse names. */
function refusedFields(parse: () => unknown): string[] {
  try {
    parse();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return ((error as ValidationError).errors ?? []).map((item) => item.field);
  }
  throw new Error('expected a ValidationError');
}

/** The segment validators (routes-final § 7.B.8, 7.B.9; BC12): every field and the tree's limits. */
describe('broadcast-segment validator', () => {
  it('accepts every field of the eight, trims the name (AC-9.2)', () => {
    const parsed = validateCreateSegmentBody(createBody({ op: 'and', items: EVERY_FIELD }));
    expect(parsed.name).toBe('VIPs');
    expect(parsed.conditions.items).toHaveLength(EVERY_FIELD.length);
  });

  it('accepts a second level and refuses a third (AC-9.2)', () => {
    const inner = { op: 'or', items: [{ field: 'details', has: 'email' }] };
    expect(() =>
      validateCreateSegmentBody(createBody({ op: 'and', items: [inner] })),
    ).not.toThrow();
    const third = { op: 'or', items: [{ op: 'and', items: [{ field: 'details', has: 'email' }] }] };
    expect(
      refusedFields(() => validateCreateSegmentBody(createBody({ op: 'and', items: [third] }))),
    ).toEqual(['conditions']);
  });

  it('accepts 20 conditions and refuses 21, counted over every group (AC-9.2)', () => {
    const condition = { field: 'details', has: 'email' };
    const twenty = {
      op: 'and',
      items: [{ op: 'or', items: Array(10).fill(condition) }, ...Array(10).fill(condition)],
    };
    expect(() => validateCreateSegmentBody(createBody(twenty))).not.toThrow();
    const twentyOne = { ...twenty, items: [...twenty.items, condition] };
    expect(refusedFields(() => validateCreateSegmentBody(createBody(twentyOne)))).toEqual([
      'conditions',
    ]);
  });

  it.each([
    ['an unknown field', { field: 'birthday', days: 1 }],
    ['an unknown key', { field: 'details', has: 'email', extra: true }],
    [
      'got_message without its number',
      { field: 'automation', automation_id: AUTOMATION_ID, state: 'got_message' },
    ],
    [
      'a number without got_message',
      { field: 'automation', automation_id: AUTOMATION_ID, state: 'started', message_number: 1 },
    ],
    [
      'a malformed automation id',
      { field: 'automation', automation_id: 'aut_1', state: 'started' },
    ],
    [
      'first_automation without an automation id',
      { field: 'came_in', via: 'first_automation', value: 'spring' },
    ],
    ['a value on an ad', { field: 'came_in', via: 'ad', value: 'x' }],
    ['a post that is not a media id', { field: 'commented', post: 'abc' }],
    [
      'active with two windows',
      { field: 'active', last_message_within_hours: 2, last_message_within_days: 2 },
    ],
    ['active with none', { field: 'active' }],
    ['more than 365 days', { field: 'no_broadcast', days: 366 }],
  ])('refuses %s on conditions', (_label, condition) => {
    expect(
      refusedFields(() => validateCreateSegmentBody(createBody({ op: 'and', items: [condition] }))),
    ).toEqual(['conditions']);
  });

  it('refuses an empty group, a missing account and an empty name', () => {
    expect(
      refusedFields(() => validateCreateSegmentBody(createBody({ op: 'and', items: [] }))),
    ).toEqual(['conditions']);
    expect(
      refusedFields(() =>
        validateCreateSegmentBody({ name: 'x', conditions: { op: 'and', items: EVERY_FIELD } }),
      ),
    ).toEqual(['channel_account_id']);
    expect(
      refusedFields(() =>
        validateCreateSegmentBody({
          channel_account_id: ACCOUNT_ID,
          name: '   ',
          conditions: { op: 'and', items: EVERY_FIELD },
        }),
      ),
    ).toEqual(['name']);
  });

  it('PATCH needs a name or conditions', () => {
    expect(() => validateUpdateSegmentBody({})).toThrow(ValidationError);
    expect(validateUpdateSegmentBody({ name: 'New' }).name).toBe('New');
  });

  it('the audience count takes exactly one of segment_id and conditions', () => {
    const conditions = { op: 'and', items: [{ field: 'details', has: 'email' }] };
    const segmentId = publicIdPlaceholderFor('segment');
    expect(
      validateSegmentAudienceCountBody({ channel_account_id: ACCOUNT_ID, segment_id: segmentId })
        .segmentPublicId,
    ).toBe(segmentId);
    expect(
      validateSegmentAudienceCountBody({ channel_account_id: ACCOUNT_ID, conditions }).conditions,
    ).toEqual(conditions);
    expect(
      refusedFields(() => validateSegmentAudienceCountBody({ channel_account_id: ACCOUNT_ID })),
    ).toEqual(['segment_id']);
    expect(
      refusedFields(() =>
        validateSegmentAudienceCountBody({
          channel_account_id: ACCOUNT_ID,
          segment_id: segmentId,
          conditions,
        }),
      ),
    ).toEqual(['segment_id']);
  });

  it('the list needs its account; sort is name or created_at', () => {
    expect(validateListSegmentsQuery({ channel_account_id: ACCOUNT_ID }).limit).toBe(25);
    expect(refusedFields(() => validateListSegmentsQuery({}))).toEqual(['channel_account_id']);
    expect(
      refusedFields(() => validateListSegmentsQuery({ channel_account_id: ACCOUNT_ID, sort: 'x' })),
    ).toEqual(['sort']);
  });
});
