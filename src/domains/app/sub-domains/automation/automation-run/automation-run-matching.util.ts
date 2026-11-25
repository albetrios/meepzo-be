import type { AutomationTriggerType } from '@/domains/app/sub-domains/automation/automation.constants.js';

/**
 * The automation fields the matching rules read (plan §4.3, §4.4) — a row of `app.automations` fits.
 */
export interface AutomationMatchCandidate {
  id: number;
  created_at: Date;
  trigger_type: string;
  also_start_from: readonly string[];
  target_scope: string;
  target_instagram_media_id: string | null;
  target_instagram_story_id: string | null;
  target_starts_at: Date | null;
  target_ends_at: Date | null;
  keywords: readonly string[];
  ad_id: string | null;
  ref_code: string | null;
  starter_questions: readonly string[];
  trigger_tag: string | null;
}

/** A chosen automation and the way to start the run takes from it (the "also start from" one's). */
export interface AutomationMatch<T extends AutomationMatchCandidate> {
  automation: T;
  /** How the run starts — the automation's own way, or the event's kind through "also start from". */
  triggerType: AutomationTriggerType;
}

/** The shortest word that may match with one wrong letter (D39, D60 — AU17). */
export const AUTOMATION_KEYWORD_CLOSE_MATCH_MIN_LETTERS = 5;

/** A keyword match: which keyword, and whether as written (`exact`) or with one wrong letter (`close`). */
export interface AutomationKeywordMatch {
  keyword: string;
  kind: 'exact' | 'close';
}

/** The words of a text, lowercased: runs of letters, marks and digits (any script). */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

/** Whether two words differ by at most one letter — one changed, added or missing (edit distance ≤ 1). */
function isOneLetterApart({ left, right }: { left: string; right: string }): boolean {
  const leftLetters = [...left];
  const rightLetters = [...right];
  if (Math.abs(leftLetters.length - rightLetters.length) > 1) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let differences = 0;
  while (leftIndex < leftLetters.length && rightIndex < rightLetters.length) {
    if (leftLetters[leftIndex] === rightLetters[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    differences += 1;
    if (differences > 1) return false;
    if (leftLetters.length > rightLetters.length) leftIndex += 1;
    else if (rightLetters.length > leftLetters.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return differences + (leftLetters.length - leftIndex) + (rightLetters.length - rightIndex) <= 1;
}

/**
 * Whether a keyword's words stand together and in order among the text's words, each a word of 5+
 * letters allowed one wrong letter, a shorter one only as written (AU17, D60).
 */
function isCloseKeywordMatch({
  keywordWords,
  textWords,
}: {
  keywordWords: readonly string[];
  textWords: readonly string[];
}): boolean {
  if (keywordWords.length === 0) return false;
  for (let start = 0; start + keywordWords.length <= textWords.length; start += 1) {
    const isMatch = keywordWords.every((keywordWord, offset) => {
      const textWord = textWords[start + offset] ?? '';
      if (textWord === keywordWord) return true;
      return (
        [...keywordWord].length >= AUTOMATION_KEYWORD_CLOSE_MATCH_MIN_LETTERS &&
        isOneLetterApart({ left: keywordWord, right: textWord })
      );
    });
    if (isMatch) return true;
  }
  return false;
}

/**
 * The first of an automation's keywords a text matches (schema-routes § 6.5, AU17 — the one function
 * intake and route 35 share): `exact` when the lowercased text contains the keyword; `close` when its
 * words stand together and in order with at most one wrong letter in each word of 5 or more letters
 * ("guide" matches "guida"). `null` when none matches.
 *
 * @remarks
 * Pure. The keywords are tried in their order; an exact match of any keyword wins over a close one.
 */
export function matchAutomationKeyword({
  keywords,
  text,
}: {
  keywords: readonly string[];
  text: string | null;
}): AutomationKeywordMatch | null {
  const lowered = (text ?? '').toLowerCase();
  const exact = keywords.find(
    (keyword) => keyword.length > 0 && lowered.includes(keyword.toLowerCase()),
  );
  if (exact !== undefined) return { keyword: exact, kind: 'exact' };
  const textWords = wordsOf(lowered);
  const close = keywords.find((keyword) =>
    isCloseKeywordMatch({ keywordWords: wordsOf(keyword), textWords }),
  );
  return close === undefined ? null : { keyword: close, kind: 'close' };
}

/**
 * Whether a text matches an automation's keywords ({@link matchAutomationKeyword}). No keywords
 * matches every comment, story reply and shared post (`isMatchWithoutKeywords`) but never a DM.
 */
export function matchesAutomationKeywords({
  keywords,
  text,
  isMatchWithoutKeywords,
}: {
  keywords: readonly string[];
  text: string | null;
  isMatchWithoutKeywords: boolean;
}): boolean {
  if (keywords.length === 0) return isMatchWithoutKeywords;
  return matchAutomationKeyword({ keywords, text }) !== null;
}

/** Oldest first: `created_at`, then `id`. */
function byAge<T extends AutomationMatchCandidate>({ left, right }: { left: T; right: T }): number {
  const timeDifference = left.created_at.getTime() - right.created_at.getTime();
  return timeDifference === 0 ? left.id - right.id : timeDifference;
}

/** Whether a comment's post is the one an automation targets (one post, a linked next post, between). */
function isPostLinked<T extends AutomationMatchCandidate>({
  candidate,
  mediaId,
  mediaPublishedAt,
}: {
  candidate: T;
  mediaId: string;
  mediaPublishedAt: Date | null;
}): boolean {
  if (candidate.target_scope === 'specific' || candidate.target_scope === 'next') {
    return candidate.target_instagram_media_id === mediaId;
  }
  if (candidate.target_scope === 'between') {
    if (mediaPublishedAt === null) return false;
    const time = mediaPublishedAt.getTime();
    return (
      (candidate.target_starts_at === null || candidate.target_starts_at.getTime() <= time) &&
      (candidate.target_ends_at === null || time <= candidate.target_ends_at.getTime())
    );
  }
  return false;
}

/**
 * Which group of {@link chooseCommentAutomation} a keyword-matching candidate joins: `linked` (a
 * post-linked comment automation, or the ad-comment automation of the comment's ad), `any_post`
 * (an "any post" comment automation, or a Live automation for a Live comment), or `null` (none).
 */
function commentCandidateGroup<T extends AutomationMatchCandidate>({
  candidate,
  kind,
  mediaId,
  adId,
  mediaPublishedAt,
}: {
  candidate: T;
  kind: 'comment' | 'live_comment' | 'ad_comment';
  mediaId: string;
  adId: string | null;
  mediaPublishedAt: Date | null;
}): 'linked' | 'any_post' | null {
  if (kind === 'live_comment') {
    return candidate.trigger_type === 'live_comment' ? 'any_post' : null;
  }
  if (candidate.trigger_type === 'ad_comment') {
    return adId !== null && candidate.ad_id === adId ? 'linked' : null;
  }
  if (candidate.trigger_type !== 'comment') return null;
  if (candidate.target_scope === 'any') return 'any_post';
  return isPostLinked({ candidate, mediaId, mediaPublishedAt }) ? 'linked' : null;
}

/**
 * One automation answers a comment (plan §4.4, D37): among the account's live comment automations
 * whose keywords the comment matches (none = every comment), the post-linked ones — one post, a
 * linked "next post", "posts between" holding the post, an ad-comment automation of the comment's
 * ad — come first and the oldest wins; else the oldest "any post" one. A Live comment matches only
 * `live_comment` automations. Every other match is returned in `otherMatches` (logged
 * `comment_already_answered`).
 *
 * @remarks
 * Pure. The caller passes the account's live, not-stopped automations only.
 */
export function chooseCommentAutomation<T extends AutomationMatchCandidate>({
  candidates,
  kind,
  mediaId,
  adId,
  mediaPublishedAt,
  text,
}: {
  candidates: readonly T[];
  kind: 'comment' | 'live_comment' | 'ad_comment';
  mediaId: string;
  adId: string | null;
  mediaPublishedAt: Date | null;
  text: string | null;
}): { chosen: AutomationMatch<T> | null; otherMatches: T[] } {
  const isKeywordMatch = (candidate: T) =>
    matchesAutomationKeywords({ keywords: candidate.keywords, text, isMatchWithoutKeywords: true });
  const linked: T[] = [];
  const anyPost: T[] = [];
  for (const candidate of candidates) {
    if (!isKeywordMatch(candidate)) continue;
    const group = commentCandidateGroup({ candidate, kind, mediaId, adId, mediaPublishedAt });
    if (group === 'linked') linked.push(candidate);
    else if (group === 'any_post') anyPost.push(candidate);
  }
  linked.sort((left, right) => byAge({ left, right }));
  anyPost.sort((left, right) => byAge({ left, right }));
  const chosen = linked[0] ?? anyPost[0] ?? null;
  const otherMatches = [...linked, ...anyPost]
    .filter((candidate) => candidate !== chosen)
    .sort((left, right) => byAge({ left, right }));
  return {
    chosen:
      chosen === null
        ? null
        : { automation: chosen, triggerType: chosen.trigger_type as AutomationTriggerType },
    otherMatches,
  };
}

/** What a message event is, for the match order of plan §4.3. */
export interface AutomationMessageMatchInput {
  kind: 'message' | 'story_reply' | 'story_mention' | 'shared_post';
  text: string | null;
  storyId: string | null;
  sharedMediaId: string | null;
  isFirstMessage: boolean;
  isOwnerChatting: boolean;
}

/** One level-3 candidate, ranked: an exact target first, then its own way to start, then the oldest. */
interface RankedMatch<T extends AutomationMatchCandidate> {
  automation: T;
  triggerType: AutomationTriggerType;
  isExactTarget: boolean;
  isOwnWay: boolean;
}

/**
 * A candidate started its own targeted way (a story reply, a shared post): its trigger is
 * `triggerType`, its target is "any" or the event's, and the text matches its keywords (none = all).
 */
function isOwnTargetedMatch<T extends AutomationMatchCandidate>({
  candidate,
  triggerType,
  targetId,
  eventId,
  text,
}: {
  candidate: T;
  triggerType: AutomationTriggerType;
  targetId: string | null;
  eventId: string | null;
  text: string | null;
}): boolean {
  if (candidate.trigger_type !== triggerType) return false;
  const isTargetMatch =
    candidate.target_scope === 'any' || (eventId !== null && targetId === eventId);
  return (
    isTargetMatch &&
    matchesAutomationKeywords({ keywords: candidate.keywords, text, isMatchWithoutKeywords: true })
  );
}

/** A level-3 match of one candidate for one message kind, or `null`. */
function levelThreeMatchOf<T extends AutomationMatchCandidate>({
  candidate,
  input,
}: {
  candidate: T;
  input: AutomationMessageMatchInput;
}): RankedMatch<T> | null {
  const keywordMatch = (isMatchWithoutKeywords: boolean) =>
    matchesAutomationKeywords({
      keywords: candidate.keywords,
      text: input.text,
      isMatchWithoutKeywords,
    });
  const ranked = ({
    triggerType,
    isExactTarget,
    isOwnWay,
  }: {
    triggerType: AutomationTriggerType;
    isExactTarget: boolean;
    isOwnWay: boolean;
  }) => ({ automation: candidate, triggerType, isExactTarget, isOwnWay });
  const isAlso = (way: string) => candidate.also_start_from.includes(way) && keywordMatch(false);
  switch (input.kind) {
    case 'message':
      if (candidate.trigger_type === 'dm_keyword' && keywordMatch(false)) {
        return ranked({ triggerType: 'dm_keyword', isExactTarget: false, isOwnWay: true });
      }
      return isAlso('dm')
        ? ranked({ triggerType: 'dm_keyword', isExactTarget: false, isOwnWay: false })
        : null;
    case 'story_reply':
      if (
        isOwnTargetedMatch({
          candidate,
          triggerType: 'story_reply',
          targetId: candidate.target_instagram_story_id,
          eventId: input.storyId,
          text: input.text,
        })
      ) {
        return ranked({
          triggerType: 'story_reply',
          isExactTarget: candidate.target_scope !== 'any',
          isOwnWay: true,
        });
      }
      return isAlso('story_reply')
        ? ranked({ triggerType: 'story_reply', isExactTarget: false, isOwnWay: false })
        : null;
    case 'story_mention':
      return candidate.trigger_type === 'story_mention'
        ? ranked({ triggerType: 'story_mention', isExactTarget: false, isOwnWay: true })
        : null;
    case 'shared_post':
      return isOwnTargetedMatch({
        candidate,
        triggerType: 'shared_post',
        targetId: candidate.target_instagram_media_id,
        eventId: input.sharedMediaId,
        text: input.text,
      })
        ? ranked({
            triggerType: 'shared_post',
            isExactTarget: candidate.target_scope !== 'any',
            isOwnWay: true,
          })
        : null;
  }
}

/** Level 3 of plan §4.3: keyword or kind — an exact target first, then its own way, then the oldest. */
function levelThreeMatches<T extends AutomationMatchCandidate>({
  candidates,
  input,
}: {
  candidates: readonly T[];
  input: AutomationMessageMatchInput;
}): RankedMatch<T>[] {
  return candidates
    .flatMap((candidate) => {
      const match = levelThreeMatchOf({ candidate, input });
      return match === null ? [] : [match];
    })
    .sort((left, right) => {
      if (left.isExactTarget !== right.isExactTarget) return left.isExactTarget ? -1 : 1;
      if (left.isOwnWay !== right.isOwnWay) return left.isOwnWay ? -1 : 1;
      return byAge({ left: left.automation, right: right.automation });
    });
}

/**
 * The one automation a message event starts (plan §4.3 levels 3–5, D37): keyword or kind (an exact
 * target first, then its own way to start before "also start from", then the oldest); else her first
 * ever DM's "first message" automation; else "no other automation answered" — not while the owner
 * chats with her by hand. A message without words (a photo, a sticker) reaches only levels 4 and 5.
 * `null` when nothing matches.
 *
 * @remarks
 * Pure. A match whose once key is used still ends the search — the caller logs it ignored.
 */
export function chooseMessageAutomation<T extends AutomationMatchCandidate>({
  candidates,
  input,
}: {
  candidates: readonly T[];
  input: AutomationMessageMatchInput;
}): AutomationMatch<T> | null {
  const hasWords = input.text !== null && input.text.trim() !== '';
  if (hasWords || input.kind !== 'message') {
    const [first] = levelThreeMatches({ candidates, input });
    if (first !== undefined)
      return { automation: first.automation, triggerType: first.triggerType };
  }
  if (input.kind !== 'message') return null;
  const oldestOf = (triggerType: AutomationTriggerType) =>
    candidates
      .filter((candidate) => candidate.trigger_type === triggerType)
      .sort((left, right) => byAge({ left, right }))[0];
  if (input.isFirstMessage) {
    const first = oldestOf('first_message');
    if (first !== undefined) return { automation: first, triggerType: 'first_message' };
  }
  if (input.isOwnerChatting) return null;
  const fallback = oldestOf('default_reply');
  return fallback === undefined ? null : { automation: fallback, triggerType: 'default_reply' };
}

/**
 * The automation an exact source names (plan §4.3 level 2): a starter question's text, an ig.me
 * link's `ref` or an ad's id, the oldest first. `null` when none.
 *
 * @remarks
 * Pure. A paused automation is not a candidate, so its starter question falls through (rule 5).
 */
export function chooseExactSourceAutomation<T extends AutomationMatchCandidate>({
  candidates,
  kind,
  value,
}: {
  candidates: readonly T[];
  kind: 'starter_question' | 'ref_link' | 'ad_message';
  value: string;
}): AutomationMatch<T> | null {
  const trimmed = value.trim();
  const matching = candidates
    .filter((candidate) => {
      if (candidate.trigger_type !== kind) return false;
      if (kind === 'starter_question') return candidate.starter_questions.includes(trimmed);
      if (kind === 'ref_link') return candidate.ref_code === trimmed;
      return candidate.ad_id === trimmed;
    })
    .sort((left, right) => byAge({ left, right }));
  const [chosen] = matching;
  return chosen === undefined ? null : { automation: chosen, triggerType: kind };
}

/**
 * The one automation a tag event starts (plan §5.12, D45): the oldest live one of that change and
 * tag, never the automation whose tag step made the event. `null` when none.
 *
 * @remarks
 * Pure.
 */
export function chooseTagAutomation<T extends AutomationMatchCandidate>({
  candidates,
  change,
  tag,
  sourceAutomationId,
}: {
  candidates: readonly T[];
  change: 'added' | 'removed';
  tag: string;
  sourceAutomationId: number | null;
}): AutomationMatch<T> | null {
  const triggerType: AutomationTriggerType = change === 'added' ? 'tag_added' : 'tag_removed';
  const [chosen] = candidates
    .filter(
      (candidate) =>
        candidate.trigger_type === triggerType &&
        candidate.trigger_tag === tag &&
        candidate.id !== sourceAutomationId,
    )
    .sort((left, right) => byAge({ left, right }));
  return chosen === undefined ? null : { automation: chosen, triggerType };
}

/** A non-blank string, trimmed; `null` otherwise. */
function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * The email a DM answers with (D18): Instagram's `user_email` quick reply first, then an
 * attachment's email, then the typed text. `null` when the message carries none of them.
 */
export function pickEmailAnswer({
  quickReplyPayload,
  attachmentEmail,
  text,
}: {
  quickReplyPayload: string | null;
  attachmentEmail: string | null;
  text: string | null;
}): string | null {
  return nonBlank(quickReplyPayload) ?? nonBlank(attachmentEmail) ?? nonBlank(text);
}

/**
 * The phone number a DM answers with: Instagram's `user_phone_number` quick reply first, then the
 * typed text. `null` when the message carries neither.
 */
export function pickPhoneAnswer({
  quickReplyPayload,
  text,
}: {
  quickReplyPayload: string | null;
  text: string | null;
}): string | null {
  return nonBlank(quickReplyPayload) ?? nonBlank(text);
}
