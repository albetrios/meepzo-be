import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import {
  mergeContactTags,
  normalizeContactEmail,
  normalizeContactPhone,
  normalizeContactTag,
  validateListContactsQuery,
} from '@/domains/app/sub-domains/contact/contact.validator.js';

/**
 * The contact sub-domain's pure rules (routes-final § 2.8, CT10): the list query, and the email,
 * phone and tag rules the worker operations apply before they write.
 */

const ACCOUNT_ID = 'iga_k7x9m2pqr4w8n1v3a1b2c';

/** The `errors[].field` values a refused query names. */
function refusedFields(query: Record<string, unknown>): string[] {
  try {
    validateListContactsQuery(query);
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return ((error as ValidationError).errors ?? []).map((item) => item.field);
  }
  throw new Error('expected the query to be refused');
}

describe('validateListContactsQuery (route 9)', () => {
  it('reads an empty query as the defaults: 25 per page, no sort, order or filter', () => {
    expect(validateListContactsQuery({})).toEqual({
      limit: 25,
      after: undefined,
      q: undefined,
      sort: undefined,
      order: undefined,
      tags: [],
      hasEmail: undefined,
      hasPhone: undefined,
      isFollowingAccount: undefined,
      firstSeenFrom: undefined,
      firstSeenTo: undefined,
      instagramAccountPublicId: undefined,
    });
  });

  it('reads every filter, sort and page parameter', () => {
    const query = validateListContactsQuery({
      q: '  jordan lee ',
      sort: 'username',
      order: 'desc',
      limit: '100',
      after: 'cursor',
      tags: 'vip, giveaway ,vip',
      has_email: 'true',
      has_phone: 'false',
      is_following_account: 'false',
      first_seen_from: '2026-11-01T00:00:00+05:30',
      first_seen_to: '2026-11-21T00:00:00Z',
      instagram_account_id: ACCOUNT_ID,
    });
    expect(query).toEqual({
      limit: 100,
      after: 'cursor',
      q: 'jordan lee',
      sort: 'username',
      order: 'desc',
      tags: ['vip', 'giveaway'],
      hasEmail: true,
      hasPhone: false,
      isFollowingAccount: false,
      firstSeenFrom: new Date('2026-10-31T18:30:00.000Z'),
      firstSeenTo: new Date('2026-11-21T00:00:00.000Z'),
      instagramAccountPublicId: ACCOUNT_ID,
    });
  });

  it.each(['last_message_received_at', 'first_seen_at', 'username'])('accepts sort=%s', (sort) => {
    expect(validateListContactsQuery({ sort }).sort).toBe(sort);
  });

  it.each([
    [{ sort: 'email' }, 'sort'],
    [{ order: 'up' }, 'order'],
    [{ limit: '0' }, 'limit'],
    [{ limit: '101' }, 'limit'],
    [{ q: '' }, 'q'],
    [{ q: 'x'.repeat(201) }, 'q'],
    [{ has_email: 'yes' }, 'has_email'],
    [{ has_phone: '1' }, 'has_phone'],
    [{ is_following_account: 'maybe' }, 'is_following_account'],
    [{ first_seen_from: '2026-11-01' }, 'first_seen_from'],
    [{ first_seen_to: '2026-11-01T00:00:00' }, 'first_seen_to'],
    [{ instagram_account_id: 'con_k7x9m2pqr4w8n1v3a1b2c' }, 'instagram_account_id'],
    [{ instagram_account_id: 'iga_short' }, 'instagram_account_id'],
    [{ automation_id: 'con_k7x9m2pqr4w8n1v3a1b2c' }, 'automation_id'],
    [{ automation_id: 'aut_short' }, 'automation_id'],
  ])('refuses %j naming %s', (query, field) => {
    expect(refusedFields(query)).toContain(field);
  });

  it('reads the automation filter (CT5, landed with sub-domain 3)', () => {
    expect(
      validateListContactsQuery({ automation_id: 'aut_k7x9m2pqr4w8n1v3a1b2c' }).automationPublicId,
    ).toBe('aut_k7x9m2pqr4w8n1v3a1b2c');
  });

  // The drop's `search` is `q` (CT4).
  it('refuses the unknown parameter search (strict)', () => {
    expect(() => validateListContactsQuery({ search: 'jordan' })).toThrow(ValidationError);
  });

  it('refuses more than ten tags, an empty tag and a tag over 255 characters', () => {
    const elevenTags = Array.from({ length: 11 }, (_, index) => `tag${index}`).join(',');
    expect(refusedFields({ tags: elevenTags })).toEqual(['tags']);
    expect(refusedFields({ tags: 'vip,,giveaway' })).toEqual(['tags']);
    expect(refusedFields({ tags: 'x'.repeat(256) })).toEqual(['tags']);
    expect(
      validateListContactsQuery({ tags: Array.from({ length: 10 }, (_, i) => `t${i}`).join(',') })
        .tags,
    ).toHaveLength(10);
  });

  it('refuses a first-seen range whose start is not before its end (`to` is exclusive)', () => {
    expect(
      refusedFields({
        first_seen_from: '2026-11-21T00:00:00Z',
        first_seen_to: '2026-11-21T00:00:00Z',
      }),
    ).toEqual(['first_seen_from']);
    expect(
      refusedFields({
        first_seen_from: '2026-11-22T00:00:00Z',
        first_seen_to: '2026-11-21T00:00:00Z',
      }),
    ).toEqual(['first_seen_from']);
  });
});

describe('normalizeContactEmail (CT10 — trimmedEmail as is)', () => {
  it('trims and lower-cases a valid email', () => {
    expect(normalizeContactEmail('  Jordan.Lee@Example.COM ')).toBe('jordan.lee@example.com');
  });

  it.each(['jordan', 'jordan@', '@example.com', 'jordan lee@example.com', 'jordan+shop@gmail.com'])(
    'answers null for %j',
    (email) => {
      expect(normalizeContactEmail(email)).toBeNull();
    },
  );
});

describe('normalizeContactPhone (CT10)', () => {
  it.each([
    ['+1 (555) 010-0123', '+15550100123'],
    ['+91 98250 12345', '+919825012345'],
    ['98250.12345', '9825012345'],
    ['  +44 20 7946 0958 ', '+442079460958'],
    ['[0049] 30 1234 5678', '00493012345678'],
  ])('normalises %j to %j', (typed, stored) => {
    expect(normalizeContactPhone(typed)).toBe(stored);
  });

  it.each([
    '12345',
    '+1 555 0100',
    '1234567890123456',
    '+1-555-CALL-NOW',
    '++15550100123',
    '15550100123+',
    '',
  ])('answers null for %j', (typed) => {
    expect(normalizeContactPhone(typed)).toBeNull();
  });
});

describe('normalizeContactTag (CT10)', () => {
  it('turns a comma into a space and trims', () => {
    expect(normalizeContactTag('  Spring sale, DM ')).toBe('Spring sale  DM');
  });

  it('cuts a tag to 255 characters and drops an empty one', () => {
    expect(normalizeContactTag('x'.repeat(300))).toHaveLength(255);
    expect(normalizeContactTag(' , ')).toBeNull();
    expect(normalizeContactTag('')).toBeNull();
  });
});

describe('mergeContactTags (addContactTags, CT10)', () => {
  it('appends the tags not held yet, in order, once each', () => {
    expect(
      mergeContactTags({ heldTags: ['vip'], newTags: ['giveaway', 'vip', 'catalog', 'giveaway'] }),
    ).toEqual({
      tags: ['vip', 'giveaway', 'catalog'],
      addedTags: ['giveaway', 'catalog'],
      droppedTags: [],
    });
  });

  it('normalises each new tag and skips an empty one', () => {
    expect(mergeContactTags({ heldTags: [], newTags: [' a,b ', '  '] })).toEqual({
      tags: ['a b'],
      addedTags: ['a b'],
      droppedTags: [],
    });
  });

  it('stops at 50 tags — the rest are dropped, never an error', () => {
    const heldTags = Array.from({ length: 49 }, (_, index) => `held${index}`);
    const merged = mergeContactTags({ heldTags, newTags: ['fiftieth', 'over', 'held0', 'also'] });
    expect(merged.tags).toHaveLength(50);
    expect(merged.tags.at(-1)).toBe('fiftieth');
    expect(merged.addedTags).toEqual(['fiftieth']);
    expect(merged.droppedTags).toEqual(['over', 'also']);
  });

  it('adds nothing to a contact that already holds 50', () => {
    const heldTags = Array.from({ length: 50 }, (_, index) => `held${index}`);
    expect(mergeContactTags({ heldTags, newTags: ['new'] })).toEqual({
      tags: heldTags,
      addedTags: [],
      droppedTags: ['new'],
    });
  });
});
