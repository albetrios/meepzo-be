import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import {
  mergeContactTags,
  normalizeContactEmail,
  normalizeContactPhone,
  normalizeContactTag,
  validateContactBulkActionBody,
  validateListContactTagsQuery,
  validateListContactsQuery,
  validateUpdateContactBody,
} from '@/domains/app/sub-domains/contact/contact.validator.js';

/**
 * The contact sub-domain's pure rules (routes-final § 3.A.8, CT5, CT7, CT9, CT12): the list query,
 * route 20's and route 21's bodies, route 22's query, and the email, phone and tag rules the worker
 * operations apply before they write.
 */

const ACCOUNT_ID = 'cha_k7x9m2pqr4w8n1v3a1b2c';

/** The `errors[].field` values a refused input names. */
function refusedFieldsOf(validate: () => unknown): string[] {
  try {
    validate();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return ((error as ValidationError).errors ?? []).map((item) => item.field);
  }
  throw new Error('expected the input to be refused');
}

/** The `errors[].field` values a refused list query names (the account always given). */
function refusedFields(query: Record<string, unknown>): string[] {
  return refusedFieldsOf(() =>
    validateListContactsQuery({ channel_account_id: ACCOUNT_ID, ...query }),
  );
}

/** The list query of one account. */
function listQuery(query: Record<string, unknown> = {}) {
  return validateListContactsQuery({ channel_account_id: ACCOUNT_ID, ...query });
}

describe('validateListContactsQuery (route 18)', () => {
  it('reads an account-only query as the defaults: 25 per page, no sort, order or filter', () => {
    expect(listQuery()).toEqual({
      limit: 25,
      after: undefined,
      q: undefined,
      sort: undefined,
      order: undefined,
      channelAccountPublicId: ACCOUNT_ID,
      tags: [],
      hasEmail: undefined,
      hasPhone: undefined,
      isFollowingAccount: undefined,
      firstSeenFrom: undefined,
      firstSeenTo: undefined,
      automationPublicId: undefined,
      isOptedOut: undefined,
      isAutomationsPaused: undefined,
      cameInVia: [],
      firstAutomationPublicId: undefined,
    });
  });

  it('refuses a query without the account, or with a malformed one (CT2, AC-5.1)', () => {
    expect(refusedFieldsOf(() => validateListContactsQuery({}))).toEqual(['channel_account_id']);
    expect(refusedFields({ channel_account_id: 'cha_short' })).toContain('channel_account_id');
    expect(refusedFields({ channel_account_id: 'con_k7x9m2pqr4w8n1v3a1b2c' })).toContain(
      'channel_account_id',
    );
  });

  it('reads every filter, sort and page parameter', () => {
    const query = listQuery({
      q: '  jordan lee ',
      sort: 'username',
      order: 'desc',
      limit: '100',
      after: 'cursor',
      tags: 'vip, giveaway ,vip',
      has_email: 'true',
      has_phone: 'false',
      is_following_account: 'false',
      is_opted_out: 'true',
      is_automations_paused: 'false',
      came_in_via: 'comment, dm_keyword',
      first_automation_id: 'aut_k7x9m2pqr4w8n1v3a1b2c',
      first_seen_from: '2026-11-01T00:00:00+05:30',
      first_seen_to: '2026-11-21T00:00:00Z',
    });
    expect(query).toEqual({
      limit: 100,
      after: 'cursor',
      q: 'jordan lee',
      sort: 'username',
      order: 'desc',
      channelAccountPublicId: ACCOUNT_ID,
      tags: ['vip', 'giveaway'],
      hasEmail: true,
      hasPhone: false,
      isFollowingAccount: false,
      firstSeenFrom: new Date('2026-10-31T18:30:00.000Z'),
      firstSeenTo: new Date('2026-11-21T00:00:00.000Z'),
      automationPublicId: undefined,
      isOptedOut: true,
      isAutomationsPaused: false,
      cameInVia: ['comment', 'dm_keyword'],
      firstAutomationPublicId: 'aut_k7x9m2pqr4w8n1v3a1b2c',
    });
  });

  it.each(['last_message_received_at', 'first_seen_at', 'username'])('accepts sort=%s', (sort) => {
    expect(listQuery({ sort }).sort).toBe(sort);
  });

  it.each([
    [{ sort: 'email' }, 'sort'],
    [{ order: 'up' }, 'order'],
    [{ limit: '0' }, 'limit'],
    [{ limit: '101' }, 'limit'],
    [{ q: '' }, 'q'],
    [{ q: 'jo' }, 'q'],
    [{ q: '  jo  ' }, 'q'],
    [{ q: 'x'.repeat(201) }, 'q'],
    [{ has_email: 'yes' }, 'has_email'],
    [{ has_phone: '1' }, 'has_phone'],
    [{ is_following_account: 'maybe' }, 'is_following_account'],
    [{ is_opted_out: 'maybe' }, 'is_opted_out'],
    [{ is_automations_paused: '1' }, 'is_automations_paused'],
    [{ came_in_via: 'comment,carrier_pigeon' }, 'came_in_via'],
    [{ first_automation_id: 'aut_short' }, 'first_automation_id'],
    [{ first_seen_from: '2026-11-01' }, 'first_seen_from'],
    [{ first_seen_to: '2026-11-01T00:00:00' }, 'first_seen_to'],
    [{ automation_id: 'con_k7x9m2pqr4w8n1v3a1b2c' }, 'automation_id'],
    [{ automation_id: 'aut_short' }, 'automation_id'],
  ])('refuses %j naming %s', (query, field) => {
    expect(refusedFields(query)).toContain(field);
  });

  it('accepts a search of 3 characters (S6, AC-5.2)', () => {
    expect(listQuery({ q: '555' }).q).toBe('555');
  });

  it('reads the automation filter (CT5)', () => {
    expect(listQuery({ automation_id: 'aut_k7x9m2pqr4w8n1v3a1b2c' }).automationPublicId).toBe(
      'aut_k7x9m2pqr4w8n1v3a1b2c',
    );
  });

  it('refuses the unknown parameters search and instagram_account_id (strict)', () => {
    expect(() => listQuery({ search: 'jordan' })).toThrow(ValidationError);
    expect(() => listQuery({ instagram_account_id: ACCOUNT_ID })).toThrow(ValidationError);
  });

  it('refuses more than ten tags, an empty tag and a tag over 50 characters', () => {
    const elevenTags = Array.from({ length: 11 }, (_, index) => `tag${index}`).join(',');
    expect(refusedFields({ tags: elevenTags })).toEqual(['tags']);
    expect(refusedFields({ tags: 'vip,,giveaway' })).toEqual(['tags']);
    expect(refusedFields({ tags: 'x'.repeat(51) })).toEqual(['tags']);
    expect(
      listQuery({ tags: Array.from({ length: 10 }, (_, i) => `t${i}`).join(',') }).tags,
    ).toHaveLength(10);
  });

  it('refuses a first-seen range whose start is not before its end (`to` is exclusive)', () => {
    expect(
      refusedFields({
        first_seen_from: '2026-11-21T00:00:00Z',
        first_seen_to: '2026-11-21T00:00:00Z',
      }),
    ).toEqual(['first_seen_from']);
  });
});

describe('validateUpdateContactBody (route 20)', () => {
  it('reads the note, the tags (normalised, once each), the pause and expected_updated_at', () => {
    expect(
      validateUpdateContactBody({
        note: '  Asked about sizes ',
        add_tags: ['vip', ' vip ', 'spring,sale'],
        remove_tags: ['lead'],
        is_automations_paused: true,
        expected_updated_at: '2026-11-21T09:00:00Z',
      }),
    ).toEqual({
      note: 'Asked about sizes',
      addTags: ['vip', 'spring sale'],
      removeTags: ['lead'],
      isAutomationsPaused: true,
      expectedUpdatedAt: new Date('2026-11-21T09:00:00Z'),
    });
    expect(validateUpdateContactBody({ note: null }).note).toBeNull();
  });

  it.each([
    [{ note: '' }, 'note'],
    [{ note: 'x'.repeat(2001) }, 'note'],
    [{ add_tags: [] }, 'add_tags'],
    [{ add_tags: Array.from({ length: 21 }, (_, index) => `t${index}`) }, 'add_tags'],
    [{ add_tags: ['x'.repeat(51)] }, 'add_tags'],
    [{ add_tags: ['vip'], remove_tags: ['vip'] }, 'remove_tags'],
  ])('refuses %j (AC-5.4)', (body, field) => {
    expect(refusedFieldsOf(() => validateUpdateContactBody(body))).toContain(field);
  });

  it('refuses an empty body and any opt-out field — the owner cannot change it (AC-5.10)', () => {
    expect(() => validateUpdateContactBody({})).toThrow(ValidationError);
    expect(() => validateUpdateContactBody({ note: 'hi', opted_out: false })).toThrow(
      ValidationError,
    );
    expect(() => validateUpdateContactBody({ is_opted_out: false })).toThrow(ValidationError);
  });

  it('accepts a note of exactly 2,000 characters', () => {
    expect(validateUpdateContactBody({ note: 'x'.repeat(2000) }).note).toHaveLength(2000);
  });
});

describe('validateContactBulkActionBody (route 21)', () => {
  const ids = (count: number) =>
    Array.from({ length: count }, (_, index) => `con_${String(index).padStart(21, '0')}`);

  it('reads a tag action on ids and a pause action on a filter', () => {
    expect(
      validateContactBulkActionBody({
        channel_account_id: ACCOUNT_ID,
        action: 'add_tag',
        tag: ' vip ',
        contact_ids: ids(2),
      }),
    ).toEqual({
      channelAccountPublicId: ACCOUNT_ID,
      action: 'add_tag',
      tag: 'vip',
      contactPublicIds: ids(2),
      filter: null,
    });
    const paused = validateContactBulkActionBody({
      channel_account_id: ACCOUNT_ID,
      action: 'pause_automations',
      filter: { tags: 'vip', is_opted_out: 'false' },
    });
    expect(paused.tag).toBeNull();
    expect(paused.filter).toMatchObject({ tags: ['vip'], isOptedOut: false });
  });

  it.each([
    [{ action: 'add_tag', tag: 'vip', contact_ids: ids(501) }, 'contact_ids'],
    [{ action: 'add_tag', tag: 'vip' }, 'contact_ids'],
    [{ action: 'add_tag', tag: 'vip', contact_ids: ids(1), filter: {} }, 'contact_ids'],
    [{ action: 'add_tag', tag: 'vip', contact_ids: [...ids(1), ...ids(1)] }, 'contact_ids'],
    [{ action: 'add_tag', contact_ids: ids(1) }, 'tag'],
    [{ action: 'pause_automations', tag: 'vip', contact_ids: ids(1) }, 'tag'],
    [{ action: 'add_tag', tag: 'vip', filter: { sort: 'username' } }, 'filter'],
    [{ action: 'shout', contact_ids: ids(1) }, 'action'],
  ])('refuses %j (AC-5.6)', (body, field) => {
    expect(
      refusedFieldsOf(() =>
        validateContactBulkActionBody({ channel_account_id: ACCOUNT_ID, ...body }),
      ),
    ).toContain(field);
  });

  it('accepts exactly 500 ids', () => {
    expect(
      validateContactBulkActionBody({
        channel_account_id: ACCOUNT_ID,
        action: 'remove_tag',
        tag: 'vip',
        contact_ids: ids(500),
      }).contactPublicIds,
    ).toHaveLength(500);
  });
});

describe('validateListContactTagsQuery (route 22)', () => {
  it('needs the account and defaults the page to 1,000', () => {
    expect(validateListContactTagsQuery({ channel_account_id: ACCOUNT_ID })).toEqual({
      channelAccountPublicId: ACCOUNT_ID,
      limit: 1000,
    });
    expect(refusedFieldsOf(() => validateListContactTagsQuery({}))).toEqual(['channel_account_id']);
    expect(
      refusedFieldsOf(() =>
        validateListContactTagsQuery({ channel_account_id: ACCOUNT_ID, limit: '1001' }),
      ),
    ).toEqual(['limit']);
  });
});

describe('normalizeContactEmail (CT9 — the strict shape, plus addresses accepted, P19)', () => {
  it('trims and lower-cases a valid email', () => {
    expect(normalizeContactEmail('  Jordan.Lee@Example.COM ')).toBe('jordan.lee@example.com');
  });

  it('accepts a plus address', () => {
    expect(normalizeContactEmail('Jordan+Shop@Gmail.com')).toBe('jordan+shop@gmail.com');
  });

  it.each([
    'jordan',
    'jordan@',
    '@example.com',
    'jordan lee@example.com',
    'jordan<x>@example.com',
    'jordan@example.c',
    `${'x'.repeat(250)}@example.com`,
  ])('answers null for %j', (email) => {
    expect(normalizeContactEmail(email)).toBeNull();
  });
});

describe('normalizeContactPhone (CT9)', () => {
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

describe('normalizeContactTag (CT9)', () => {
  it('turns a comma into a space and trims', () => {
    expect(normalizeContactTag('  Spring sale, DM ')).toBe('Spring sale  DM');
  });

  it('cuts a tag to 50 characters and drops an empty one', () => {
    expect(normalizeContactTag('x'.repeat(300))).toHaveLength(50);
    expect(normalizeContactTag(' , ')).toBeNull();
    expect(normalizeContactTag('')).toBeNull();
  });
});

describe('mergeContactTags (addContactTags, CT9)', () => {
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
