import { describe, expect, it } from 'vitest';
import {
  type AutomationMatchCandidate,
  chooseCommentAutomation,
  chooseExactSourceAutomation,
  chooseMessageAutomation,
  chooseTagAutomation,
  matchAutomationKeyword,
  matchesAutomationKeywords,
  pickEmailAnswer,
  pickPhoneAnswer,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run-matching.util.js';

/**
 * The run engine's matching rules (feat-instagram-dm-sending routes-final § 4.B, plan §4.3–§4.4, D37)
 * as pure functions: which automation answers a comment (post-linked first, the oldest, every other
 * match returned), which one a message, a tap or a tag starts, and where a DM's answer comes from.
 */

const POST = '17900000000000001';
const OTHER_POST = '17900000000000002';
const STORY = '17910000000000001';

let nextId = 1;

/** A candidate created `ageInMinutes` ago (older = created first). */
function candidate(
  overrides: Partial<AutomationMatchCandidate> & { ageInMinutes?: number } = {},
): AutomationMatchCandidate {
  const { ageInMinutes = 0, ...rest } = overrides;
  nextId += 1;
  return {
    id: nextId,
    created_at: new Date(Date.UTC(2026, 10, 21, 12, 0) - ageInMinutes * 60_000),
    trigger_type: 'comment',
    also_start_from: [],
    target_scope: 'any',
    target_instagram_media_id: null,
    target_instagram_story_id: null,
    target_starts_at: null,
    target_ends_at: null,
    keywords: [],
    ad_id: null,
    ref_code: null,
    starter_questions: [],
    trigger_tag: null,
    ...rest,
  };
}

/** A message event's match input. */
function message(overrides: Partial<Parameters<typeof chooseMessageAutomation>[0]['input']> = {}) {
  return {
    kind: 'message' as const,
    text: 'price please',
    storyId: null,
    sharedMediaId: null,
    isFirstMessage: false,
    isOwnerChatting: false,
    ...overrides,
  };
}

describe('matchAutomationKeyword / matchesAutomationKeywords (D39, D60)', () => {
  it('matches a keyword the text contains, and a close spelling of a long word', () => {
    expect(matchAutomationKeyword({ keywords: ['guide'], text: 'Send the GUIDE' })).toEqual({
      keyword: 'guide',
      kind: 'exact',
    });
    expect(matchAutomationKeyword({ keywords: ['guide'], text: 'the guida please' })).toEqual({
      keyword: 'guide',
      kind: 'close',
    });
  });

  it('no keywords matches every comment and story reply, never a DM', () => {
    expect(
      matchesAutomationKeywords({ keywords: [], text: 'x', isMatchWithoutKeywords: true }),
    ).toBe(true);
    expect(
      matchesAutomationKeywords({ keywords: [], text: 'x', isMatchWithoutKeywords: false }),
    ).toBe(false);
  });
});

describe('chooseCommentAutomation (plan §4.4)', () => {
  it('a post-linked match beats an older "any post" one; every other match is returned', () => {
    const anyPost = candidate({ ageInMinutes: 30 });
    const linked = candidate({ target_scope: 'specific', target_instagram_media_id: POST });
    const otherPost = candidate({
      target_scope: 'specific',
      target_instagram_media_id: OTHER_POST,
    });
    const { chosen, otherMatches } = chooseCommentAutomation({
      candidates: [anyPost, linked, otherPost],
      kind: 'comment',
      mediaId: POST,
      adId: null,
      mediaPublishedAt: null,
      text: 'hi',
    });
    expect(chosen?.automation).toBe(linked);
    expect(chosen?.triggerType).toBe('comment');
    expect(otherMatches).toEqual([anyPost]);
  });

  it('"posts between" holds a post published inside its dates; an ad comment matches its ad', () => {
    const between = candidate({
      target_scope: 'between',
      target_starts_at: new Date('2026-11-01T00:00:00Z'),
      target_ends_at: new Date('2026-11-30T00:00:00Z'),
    });
    const ad = candidate({ trigger_type: 'ad_comment', ad_id: '777', ageInMinutes: 10 });
    expect(
      chooseCommentAutomation({
        candidates: [between],
        kind: 'comment',
        mediaId: POST,
        adId: null,
        mediaPublishedAt: new Date('2026-11-10T00:00:00Z'),
        text: null,
      }).chosen?.automation,
    ).toBe(between);
    expect(
      chooseCommentAutomation({
        candidates: [between, ad],
        kind: 'ad_comment',
        mediaId: POST,
        adId: '777',
        mediaPublishedAt: new Date('2026-12-10T00:00:00Z'),
        text: null,
      }).chosen?.automation,
    ).toBe(ad);
  });

  it('a Live comment matches only Live comment automations', () => {
    const live = candidate({ trigger_type: 'live_comment', ageInMinutes: 1 });
    const comment = candidate({ ageInMinutes: 5 });
    const { chosen, otherMatches } = chooseCommentAutomation({
      candidates: [comment, live],
      kind: 'live_comment',
      mediaId: POST,
      adId: null,
      mediaPublishedAt: null,
      text: 'x',
    });
    expect(chosen?.automation).toBe(live);
    expect(otherMatches).toEqual([]);
  });
});

describe('chooseMessageAutomation (plan §4.3 levels 3–5)', () => {
  it('a keyword DM: its own way before "also start from", oldest first', () => {
    const also = candidate({ also_start_from: ['dm'], keywords: ['price'], ageInMinutes: 60 });
    const own = candidate({ trigger_type: 'dm_keyword', keywords: ['price'] });
    const match = chooseMessageAutomation({ candidates: [also, own], input: message() });
    expect(match?.automation).toBe(own);
    expect(match?.triggerType).toBe('dm_keyword');
    const viaAlso = chooseMessageAutomation({ candidates: [also], input: message() });
    expect(viaAlso).toEqual({ automation: also, triggerType: 'dm_keyword' });
  });

  it('a story reply: one story before "any story"; a story mention; a shared post', () => {
    const anyStory = candidate({ trigger_type: 'story_reply', ageInMinutes: 60 });
    const thisStory = candidate({
      trigger_type: 'story_reply',
      target_scope: 'specific',
      target_instagram_story_id: STORY,
    });
    expect(
      chooseMessageAutomation({
        candidates: [anyStory, thisStory],
        input: message({ kind: 'story_reply', storyId: STORY }),
      })?.automation,
    ).toBe(thisStory);
    const mention = candidate({ trigger_type: 'story_mention' });
    expect(
      chooseMessageAutomation({
        candidates: [mention],
        input: message({ kind: 'story_mention', text: null, storyId: STORY }),
      })?.triggerType,
    ).toBe('story_mention');
    const shared = candidate({ trigger_type: 'shared_post' });
    expect(
      chooseMessageAutomation({
        candidates: [shared],
        input: message({ kind: 'shared_post', text: null, sharedMediaId: POST }),
      })?.automation,
    ).toBe(shared);
  });

  it('her first DM, then "no other automation answered" — not while the owner chats by hand', () => {
    const first = candidate({ trigger_type: 'first_message' });
    const fallback = candidate({ trigger_type: 'default_reply' });
    expect(
      chooseMessageAutomation({
        candidates: [first, fallback],
        input: message({ text: 'hi', isFirstMessage: true }),
      })?.automation,
    ).toBe(first);
    expect(
      chooseMessageAutomation({ candidates: [first, fallback], input: message({ text: 'hi' }) })
        ?.automation,
    ).toBe(fallback);
    expect(
      chooseMessageAutomation({
        candidates: [fallback],
        input: message({ text: 'hi', isOwnerChatting: true }),
      }),
    ).toBeNull();
  });

  it('a message without words reaches only levels 4 and 5', () => {
    const keyword = candidate({ trigger_type: 'dm_keyword', keywords: ['price'] });
    expect(
      chooseMessageAutomation({ candidates: [keyword], input: message({ text: null }) }),
    ).toBeNull();
  });
});

describe('chooseExactSourceAutomation and chooseTagAutomation', () => {
  it('a starter question, a ref and an ad name their automation', () => {
    const starter = candidate({ trigger_type: 'starter_question', starter_questions: ['Prices?'] });
    const ref = candidate({ trigger_type: 'ref_link', ref_code: 'spring' });
    const ad = candidate({ trigger_type: 'ad_message', ad_id: '55' });
    const candidates = [starter, ref, ad];
    expect(
      chooseExactSourceAutomation({ candidates, kind: 'starter_question', value: 'Prices?' })
        ?.automation,
    ).toBe(starter);
    expect(
      chooseExactSourceAutomation({ candidates, kind: 'ref_link', value: 'spring' })?.automation,
    ).toBe(ref);
    expect(
      chooseExactSourceAutomation({ candidates, kind: 'ad_message', value: '55' })?.automation,
    ).toBe(ad);
    expect(
      chooseExactSourceAutomation({ candidates, kind: 'ref_link', value: 'other' }),
    ).toBeNull();
  });

  it('a tag starts the oldest automation of that change and tag, never its own source', () => {
    const older = candidate({ trigger_type: 'tag_added', trigger_tag: 'vip', ageInMinutes: 9 });
    const newer = candidate({ trigger_type: 'tag_added', trigger_tag: 'vip' });
    expect(
      chooseTagAutomation({
        candidates: [newer, older],
        change: 'added',
        tag: 'vip',
        sourceAutomationId: null,
      })?.automation,
    ).toBe(older);
    expect(
      chooseTagAutomation({
        candidates: [older, newer],
        change: 'added',
        tag: 'vip',
        sourceAutomationId: older.id,
      })?.automation,
    ).toBe(newer);
    expect(
      chooseTagAutomation({
        candidates: [older],
        change: 'removed',
        tag: 'vip',
        sourceAutomationId: null,
      }),
    ).toBeNull();
  });
});

describe('the answer a DM carries (D18)', () => {
  it('the email: the quick reply, then an attachment, then the typed text', () => {
    expect(
      pickEmailAnswer({ quickReplyPayload: 'a@x.com', attachmentEmail: 'b@x.com', text: 'c' }),
    ).toBe('a@x.com');
    expect(pickEmailAnswer({ quickReplyPayload: ' ', attachmentEmail: 'b@x.com', text: 'c' })).toBe(
      'b@x.com',
    );
    expect(
      pickEmailAnswer({ quickReplyPayload: null, attachmentEmail: null, text: null }),
    ).toBeNull();
  });

  it('the phone: the quick reply, then the typed text', () => {
    expect(pickPhoneAnswer({ quickReplyPayload: '+15550100123', text: 'x' })).toBe('+15550100123');
    expect(pickPhoneAnswer({ quickReplyPayload: null, text: '555 010 0123' })).toBe('555 010 0123');
  });
});
