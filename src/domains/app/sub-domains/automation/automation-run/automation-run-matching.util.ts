import type { AutomationTargetScope } from '@/domains/app/sub-domains/automation/automation.constants.js';
import type {
  AutomationRunTriggerType,
  AutomationCommentLogIgnoredReason,
  AutomationRunStatus,
} from './automation-run.constants.js';

/** The automation fields the matching rules read (AU16) — a row of `app.automations` fits. */
export interface AutomationMatchCandidate {
  id: number;
  created_at: Date;
  trigger_type: string;
  target_scope: string;
  target_instagram_media_id: string | null;
  target_instagram_story_id: string | null;
  keywords: readonly string[];
  is_dm_keyword_trigger_enabled: boolean;
}

/** Oldest first: `created_at`, then `id` (AU16). */
function byAge<T extends AutomationMatchCandidate>({ left, right }: { left: T; right: T }): number {
  const timeDifference = left.created_at.getTime() - right.created_at.getTime();
  return timeDifference === 0 ? left.id - right.id : timeDifference;
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
 * matches every comment and story reply (`isMatchWithoutKeywords`) but never a DM.
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

/**
 * One automation answers a comment (AU16, AQ1 — your rule, D26): among the account's live comment
 * automations whose keywords the comment matches, the post-linked ones (`specific` on this post,
 * or a `next` linked to it) are checked first and the oldest match is chosen; only when none of
 * them matches is the oldest matching "any post" automation chosen. Every other match — of either
 * kind — is returned in `otherMatches` (logged `comment_already_answered`).
 *
 * @remarks
 * A `next` automation still `waiting` or `expired` has no media id, so it matches nothing; an
 * automation of another post, or one that does not match, is in neither list. The caller passes
 * the account's live comment automations only (AU27).
 */
export function chooseCommentAutomation<T extends AutomationMatchCandidate>({
  candidates,
  instagramMediaId,
  text,
}: {
  candidates: readonly T[];
  instagramMediaId: string;
  text: string | null;
}): { chosen: T | null; otherMatches: T[] } {
  const matching = candidates
    .filter(
      (candidate) => candidate.trigger_type === ('comment' satisfies AutomationRunTriggerType),
    )
    .filter((candidate) =>
      matchesAutomationKeywords({
        keywords: candidate.keywords,
        text,
        isMatchWithoutKeywords: true,
      }),
    );
  const postLinked = matching
    .filter(
      (candidate) =>
        (candidate.target_scope === ('specific' satisfies AutomationTargetScope) ||
          candidate.target_scope === ('next' satisfies AutomationTargetScope)) &&
        candidate.target_instagram_media_id === instagramMediaId,
    )
    .sort((left, right) => byAge({ left, right }));
  const anyPost = matching
    .filter((candidate) => candidate.target_scope === ('any' satisfies AutomationTargetScope))
    .sort((left, right) => byAge({ left, right }));
  const chosen = postLinked[0] ?? anyPost[0] ?? null;
  const otherMatches = [...postLinked, ...anyPost]
    .filter((candidate) => candidate !== chosen)
    .sort((left, right) => byAge({ left, right }));
  return { chosen, otherMatches };
}

/**
 * The automation a DM starts (AU16): the **first** of the account's live automations — any
 * trigger — with the DM keyword trigger on and a keyword the text contains, oldest first. No
 * keywords never matches a DM (schema-routes § 6.5).
 */
export function chooseDirectMessageAutomation<T extends AutomationMatchCandidate>({
  candidates,
  text,
}: {
  candidates: readonly T[];
  text: string | null;
}): T | null {
  const matching = candidates
    .filter((candidate) => candidate.is_dm_keyword_trigger_enabled)
    .filter((candidate) =>
      matchesAutomationKeywords({
        keywords: candidate.keywords,
        text,
        isMatchWithoutKeywords: false,
      }),
    )
    .sort((left, right) => byAge({ left, right }));
  return matching[0] ?? null;
}

/**
 * The automation a story reply starts (AU16): the account's first live `story_reply` automation —
 * `any`, or `specific` on this story — whose keywords match (none = every story reply), oldest
 * first. An expired story simply stops matching (D18): nothing here reads the story's age.
 */
export function chooseStoryReplyAutomation<T extends AutomationMatchCandidate>({
  candidates,
  instagramStoryId,
  text,
}: {
  candidates: readonly T[];
  instagramStoryId: string;
  text: string | null;
}): T | null {
  const matching = candidates
    .filter(
      (candidate) => candidate.trigger_type === ('story_reply' satisfies AutomationRunTriggerType),
    )
    .filter(
      (candidate) =>
        candidate.target_scope === ('any' satisfies AutomationTargetScope) ||
        (candidate.target_scope === ('specific' satisfies AutomationTargetScope) &&
          candidate.target_instagram_story_id === instagramStoryId),
    )
    .filter((candidate) =>
      matchesAutomationKeywords({
        keywords: candidate.keywords,
        text,
        isMatchWithoutKeywords: true,
      }),
    )
    .sort((left, right) => byAge({ left, right }));
  return matching[0] ?? null;
}

/**
 * What a trigger meets for the chosen automation and contact (AU17, D14), in order:
 * (1) another run of the contact waits for an email → `waiting_for_other_email` (the trigger is
 * queued on that run and the question asked again); (2) this automation's run waits →
 * `already_waiting`; (3) it runs → `run_in_progress`; (4) its last run is `completed` or `failed`
 * → `previous_run_final`. `null` = a new run may start (no run yet, or the last one `cancelled`).
 */
export function decideExistingRunConflict({
  hasEmailWaitingRun,
  latestRunStatus,
}: {
  /** Whether another automation's run of the contact waits for an email. */
  hasEmailWaitingRun: boolean;
  /** The status of this automation's last run for the contact; `null` = none. */
  latestRunStatus: AutomationRunStatus | null;
}): AutomationCommentLogIgnoredReason | null {
  if (hasEmailWaitingRun) return 'waiting_for_other_email';
  if (latestRunStatus === 'waiting') return 'already_waiting';
  if (latestRunStatus === 'running') return 'run_in_progress';
  if (latestRunStatus === 'completed' || latestRunStatus === 'failed') return 'previous_run_final';
  return null;
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
