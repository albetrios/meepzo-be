import { describe, expect, it } from 'vitest';
import {
  type AutomationMatchCandidate,
  chooseCommentAutomation,
  chooseDirectMessageAutomation,
  chooseStoryReplyAutomation,
  decideExistingRunConflict,
  matchesAutomationKeywords,
  pickEmailAnswer,
  pickPhoneAnswer,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run-matching.util.js';

/**
 * The run engine's matching rules (routes-final § 3.B — AU16, AU17, D18, D26) as pure functions:
 * which automation answers a comment (post-linked first, the oldest match, every other match
 * returned), which one a DM or a story reply starts, what a trigger meets for an existing run, and
 * where a DM's email or phone answer comes from.
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
    target_scope: 'any',
    target_instagram_media_id: null,
    target_instagram_story_id: null,
    keywords: [],
    is_dm_keyword_trigger_enabled: true,
    ...rest,
  };
}

describe('matchesAutomationKeywords', () => {
  it('matches when the lowercased text contains any keyword', () => {
    expect(
      matchesAutomationKeywords({
        keywords: ['price', 'link'],
        text: 'What is the PRICE?',
        isMatchWithoutKeywords: false,
      }),
    ).toBe(true);
    expect(
      matchesAutomationKeywords({
        keywords: ['price'],
        text: 'nice',
        isMatchWithoutKeywords: true,
      }),
    ).toBe(false);
  });

  it('no keywords matches every comment and story reply, never a DM', () => {
    expect(
      matchesAutomationKeywords({ keywords: [], text: 'hello', isMatchWithoutKeywords: true }),
    ).toBe(true);
    expect(
      matchesAutomationKeywords({ keywords: [], text: 'hello', isMatchWithoutKeywords: false }),
    ).toBe(false);
  });

  it('a missing text matches no keyword', () => {
    expect(
      matchesAutomationKeywords({ keywords: ['price'], text: null, isMatchWithoutKeywords: true }),
    ).toBe(false);
  });
});

describe('chooseCommentAutomation (AU16, D26)', () => {
  it('a post-linked match beats an older "any post" one', () => {
    const olderAnyPost = candidate({ ageInMinutes: 60 });
    const specific = candidate({
      ageInMinutes: 10,
      target_scope: 'specific',
      target_instagram_media_id: POST,
    });

    const { chosen, otherMatches } = chooseCommentAutomation({
      candidates: [olderAnyPost, specific],
      instagramMediaId: POST,
      text: 'link',
    });

    expect(chosen).toBe(specific);
    expect(otherMatches).toEqual([olderAnyPost]);
  });

  it('the oldest of a kind wins — two linked "next post" automations', () => {
    const newerNext = candidate({
      ageInMinutes: 5,
      target_scope: 'next',
      target_instagram_media_id: POST,
    });
    const olderNext = candidate({
      ageInMinutes: 50,
      target_scope: 'next',
      target_instagram_media_id: POST,
    });

    const { chosen, otherMatches } = chooseCommentAutomation({
      candidates: [newerNext, olderNext],
      instagramMediaId: POST,
      text: 'anything',
    });

    expect(chosen).toBe(olderNext);
    expect(otherMatches).toEqual([newerNext]);
  });

  it('only when no post-linked automation matches is an "any post" one chosen, oldest first', () => {
    const specificNoMatch = candidate({
      target_scope: 'specific',
      target_instagram_media_id: POST,
      keywords: ['shoes'],
    });
    const newerAny = candidate({ ageInMinutes: 1 });
    const olderAny = candidate({ ageInMinutes: 2 });

    const { chosen, otherMatches } = chooseCommentAutomation({
      candidates: [specificNoMatch, newerAny, olderAny],
      instagramMediaId: POST,
      text: 'link please',
    });

    expect(chosen).toBe(olderAny);
    expect(otherMatches).toEqual([newerAny]);
  });

  it("leaves another post's automations and a waiting or expired next-post one untouched", () => {
    const otherPost = candidate({
      target_scope: 'specific',
      target_instagram_media_id: OTHER_POST,
    });
    const waitingNext = candidate({ target_scope: 'next', target_instagram_media_id: null });

    const { chosen, otherMatches } = chooseCommentAutomation({
      candidates: [otherPost, waitingNext],
      instagramMediaId: POST,
      text: 'link',
    });

    expect(chosen).toBeNull();
    expect(otherMatches).toEqual([]);
  });

  it('ignores a non-comment automation and one whose keywords do not match', () => {
    const story = candidate({ trigger_type: 'story_reply' });
    const keywordMiss = candidate({ keywords: ['price'] });

    expect(
      chooseCommentAutomation({
        candidates: [story, keywordMiss],
        instagramMediaId: POST,
        text: 'hi',
      }).chosen,
    ).toBeNull();
  });
});

describe('chooseDirectMessageAutomation (AU16)', () => {
  it('the first automation, any trigger, with the DM trigger on and a matching keyword', () => {
    const triggerOff = candidate({
      ageInMinutes: 90,
      keywords: ['catalog'],
      is_dm_keyword_trigger_enabled: false,
    });
    const commentWithDm = candidate({ ageInMinutes: 60, keywords: ['catalog'] });
    const dm = candidate({ ageInMinutes: 30, trigger_type: 'dm', keywords: ['catalog'] });

    expect(
      chooseDirectMessageAutomation({
        candidates: [dm, triggerOff, commentWithDm],
        text: 'Catalog?',
      }),
    ).toBe(commentWithDm);
  });

  it('no keywords never matches a DM', () => {
    expect(
      chooseDirectMessageAutomation({
        candidates: [candidate({ trigger_type: 'dm', keywords: [] })],
        text: 'hello',
      }),
    ).toBeNull();
  });
});

describe('chooseStoryReplyAutomation (AU16, D18)', () => {
  it('any story, or a specific one on this story; the oldest matching first', () => {
    const otherStory = candidate({
      ageInMinutes: 90,
      trigger_type: 'story_reply',
      target_scope: 'specific',
      target_instagram_story_id: '17910000000000009',
    });
    const thisStory = candidate({
      ageInMinutes: 60,
      trigger_type: 'story_reply',
      target_scope: 'specific',
      target_instagram_story_id: STORY,
    });
    const anyStory = candidate({ ageInMinutes: 30, trigger_type: 'story_reply' });

    expect(
      chooseStoryReplyAutomation({
        candidates: [anyStory, otherStory, thisStory],
        instagramStoryId: STORY,
        text: 'wow',
      }),
    ).toBe(thisStory);
  });

  it('no keywords matches every story reply', () => {
    const anyStory = candidate({ trigger_type: 'story_reply' });
    expect(
      chooseStoryReplyAutomation({ candidates: [anyStory], instagramStoryId: STORY, text: null }),
    ).toBe(anyStory);
  });
});

describe('decideExistingRunConflict (AU17)', () => {
  it.each([
    [true, null, 'waiting_for_other_email'],
    [true, 'completed', 'waiting_for_other_email'],
    [false, 'waiting', 'already_waiting'],
    [false, 'running', 'run_in_progress'],
    [false, 'completed', 'previous_run_final'],
    [false, 'failed', 'previous_run_final'],
    [false, 'cancelled', null],
    [false, null, null],
  ] as const)(
    'email wait %s, last run %s → %s',
    (hasEmailWaitingRun, latestRunStatus, expected) => {
      expect(decideExistingRunConflict({ hasEmailWaitingRun, latestRunStatus })).toBe(expected);
    },
  );
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
      pickEmailAnswer({ quickReplyPayload: null, attachmentEmail: null, text: ' c@x.com ' }),
    ).toBe('c@x.com');
    expect(
      pickEmailAnswer({ quickReplyPayload: null, attachmentEmail: null, text: null }),
    ).toBeNull();
  });

  it('the phone: the quick reply, then the typed text', () => {
    expect(pickPhoneAnswer({ quickReplyPayload: '+15550100123', text: 'x' })).toBe('+15550100123');
    expect(pickPhoneAnswer({ quickReplyPayload: null, text: '555 010 0123' })).toBe('555 010 0123');
  });
});
