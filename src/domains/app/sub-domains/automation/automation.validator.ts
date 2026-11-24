import { randomBytes } from 'node:crypto';
import { ValidationError, type ValidationErrorItem } from '@/shared/errors/index.js';
import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import type { ChannelFeature } from '@/domains/app/sub-domains/channel-account/channel-account-capabilities.constants.js';
import {
  AUTOMATION_ALSO_START_FROM_BY_TRIGGER_TYPE,
  AUTOMATION_BUTTON_TEXT_MAX_LENGTH,
  AUTOMATION_BUTTON_TITLE_MAX_LENGTH,
  AUTOMATION_CARD_TEXT_MAX_LENGTH,
  AUTOMATION_CARDS_MAX_COUNT,
  AUTOMATION_COMMENT_TRIGGER_TYPES,
  AUTOMATION_HELLO_BUTTONS_MAX_COUNT,
  AUTOMATION_LINK_BUTTONS_MAX_COUNT,
  AUTOMATION_LINK_URL_MAX_LENGTH,
  AUTOMATION_MESSAGE_TEXT_MAX_BYTES,
  AUTOMATION_MESSAGE_VERSIONS_MAX_COUNT,
  AUTOMATION_MESSAGE_WAIT_MAX_MINUTES,
  AUTOMATION_MESSAGES_MAX_COUNT,
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_PUBLIC_REPLY_LINES_WITH_REPLY_LIKE_PERSON_MIN_COUNT,
  AUTOMATION_QUESTION_WORDINGS_MAX_COUNT,
  AUTOMATION_QUICK_REPLIES_MAX_COUNT,
  AUTOMATION_QUICK_REPLY_MAX_LENGTH,
  AUTOMATION_REF_CODE_MAX_LENGTH,
  AUTOMATION_REF_CODE_SUFFIX_LENGTH,
  AUTOMATION_SHE_MESSAGED_FIRST_TRIGGER_TYPES,
  AUTOMATION_STARTER_QUESTIONS_MAX_COUNT,
  AUTOMATION_TAG_MAX_LENGTH,
  AUTOMATION_TAGS_MAX_COUNT,
  AUTOMATION_TARGET_SCOPES_BY_TRIGGER_TYPE,
  AUTOMATION_TRIGGER_TYPE_GROUPS,
  type AutomationPauseMode,
  type AutomationStatus,
  type AutomationTriggerType,
} from './automation.constants.js';
import {
  createAutomationDto,
  deleteAutomationQueryDto,
  emptyAutomationActionDto,
  keywordTestAutomationDto,
  listAutomationsQueryDto,
  pauseAutomationDto,
  updateAutomationDto,
  type UpdateAutomationInput,
} from './automation.dto.js';
import type { AutomationMessage, AutomationSteps } from './automation-steps.dto.js';
import type {
  AutomationCreateChanges,
  AutomationDeleteReason,
  AutomationListQuery,
  AutomationProblem,
  AutomationUpdateChanges,
  AutomationWritableFields,
} from './automation.types.js';

/** The writable fields of either body, as the DTOs parse them (every one optional here). */
type ParsedWritableFields = Omit<UpdateAutomationInput, 'expected_updated_at'>;

/** Each value once, in the order first sent. */
function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * The fields a parsed body sets, normalised as the table stores them: keywords lowercased and
 * deduplicated, starter questions and public reply lines deduplicated, `also_start_from` once each,
 * the `between` dates as `Date`. A field the body left out stays absent; `null` clears it.
 */
function normalizeWritableFields(parsed: ParsedWritableFields): AutomationUpdateChanges {
  const { keywords, target_starts_at, target_ends_at, also_start_from, ...rest } = parsed;
  const changes: AutomationUpdateChanges = { ...(rest as AutomationUpdateChanges) };
  if (keywords !== undefined) {
    changes.keywords = uniqueValues(keywords.map((keyword) => keyword.toLowerCase()));
  }
  if (also_start_from !== undefined) {
    changes.also_start_from = uniqueValues(
      also_start_from,
    ) as AutomationWritableFields['also_start_from'];
  }
  if (target_starts_at !== undefined) {
    changes.target_starts_at = target_starts_at === null ? null : new Date(target_starts_at);
  }
  if (target_ends_at !== undefined) {
    changes.target_ends_at = target_ends_at === null ? null : new Date(target_ends_at);
  }
  return changes;
}

/**
 * Parses route 28's body with the strict {@link createAutomationDto} and normalises it (AU11).
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) on a bad shape, a value out of range, an unknown or
 * read-only field (`status` included — actions only, AU3), a missing `name`, `channel_account_id`
 * or `trigger_type` (AUQ3).
 */
export function validateCreateAutomation(data: unknown): AutomationCreateChanges {
  const { channel_account_id, ...parsed } = parseWithSchema({ schema: createAutomationDto, data });
  return {
    ...normalizeWritableFields(parsed),
    name: parsed.name,
    trigger_type: parsed.trigger_type,
    channel_account_id,
  };
}

/**
 * Parses route 30's body with the strict {@link updateAutomationDto}: the normalised changes and the
 * `expected_updated_at` the client opened.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) as {@link validateCreateAutomation}, plus an empty body.
 */
export function validateUpdateAutomation(data: unknown): {
  changes: AutomationUpdateChanges;
  expectedUpdatedAt: string | undefined;
} {
  const { expected_updated_at: expectedUpdatedAt, ...parsed } = parseWithSchema({
    schema: updateAutomationDto,
    data,
  });
  return { changes: normalizeWritableFields(parsed), expectedUpdatedAt };
}

/**
 * Parses route 27's query (AU10) into the service's {@link AutomationListQuery}.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) — a missing or malformed `channel_account_id`, a bad list
 * value, an unknown parameter.
 */
export function validateListAutomationsQuery(data: unknown): AutomationListQuery {
  const parsed = parseWithSchema({ schema: listAutomationsQueryDto, data });
  return {
    limit: parsed.limit,
    after: parsed.after,
    q: parsed.q,
    sort: parsed.sort,
    order: parsed.order,
    channelAccountPublicId: parsed.channel_account_id,
    statuses: (parsed.status?.split(',') ?? []) as AutomationStatus[],
    triggerTypes: (parsed.trigger_type?.split(',') ?? []) as AutomationTriggerType[],
  };
}

/**
 * Parses route 31's query (AU16, P11): the optional reason, and the note `other` requires.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) on an unknown reason, `other` without a note, a long
 * note, an unknown parameter.
 */
export function validateDeleteAutomationQuery(data: unknown): AutomationDeleteReason {
  const parsed = parseWithSchema({ schema: deleteAutomationQueryDto, data });
  return { reason: parsed.reason ?? null, note: parsed.note ?? null };
}

/**
 * Checks the strictly empty body of routes 32 and 34 (4.A.8).
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) on any field. An absent body is an empty one.
 */
export function validateEmptyAutomationAction(data: unknown): void {
  parseWithSchema({ schema: emptyAutomationActionDto, data: data ?? {} });
}

/**
 * Parses route 33's body (AU14): the pause mode.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) on a missing or unknown `mode`.
 */
export function validatePauseAutomation(data: unknown): AutomationPauseMode {
  return parseWithSchema({ schema: pauseAutomationDto, data }).mode;
}

/**
 * Parses route 35's body (AU17): the text and its optional source.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) on an empty or long text, an unknown source.
 */
export function validateKeywordTestAutomation(data: unknown): {
  text: string;
  source: 'comment' | 'dm' | 'story_reply' | undefined;
} {
  const parsed = parseWithSchema({ schema: keywordTestAutomationDto, data });
  return { text: parsed.text, source: parsed.source };
}

/**
 * The automation a create saves (AU11): the defaults of 4.A.3 with the body over them — `any`,
 * the mention on, every other part off or empty, `steps` `{}`. "Reply like a person" defaults to
 * the plan's switch (D59) — the caller passes it.
 */
export function mergeAutomationForCreate({
  changes,
  isReplyLikePersonDefault,
}: {
  changes: AutomationCreateChanges;
  /** Whether the plan's `reply_like_person` switch is on (D59, P83). */
  isReplyLikePersonDefault: boolean;
}): AutomationWritableFields {
  const { channel_account_id: _channelAccountId, ...fields } = changes;
  return {
    also_start_from: [],
    target_scope: 'any',
    target_instagram_media_id: null,
    target_instagram_story_id: null,
    target_starts_at: null,
    target_ends_at: null,
    keywords: [],
    ref_code: null,
    starter_questions: [],
    ad_id: null,
    trigger_tag: null,
    default_reply_mode: null,
    is_public_reply_enabled: false,
    public_reply_texts: [],
    is_public_reply_mention_enabled: true,
    is_reply_like_person_enabled: isReplyLikePersonDefault,
    public_reply_hour_limit: null,
    is_hide_comment_after_direct_message_enabled: false,
    steps: {},
    ...fields,
  };
}

/** The automation an edit saves: the stored fields with the body over them (AU12). */
export function mergeAutomationForUpdate({
  stored,
  changes,
}: {
  stored: AutomationWritableFields;
  changes: AutomationUpdateChanges;
}): AutomationWritableFields {
  return { ...stored, ...changes };
}

/**
 * Refuses a change of the way to start into another Flowdm group (AU12, plan §4.1):
 * `400` naming `trigger_type`.
 *
 * @remarks
 * Failure modes: `ValidationError` (`errors:validation.automationTriggerTypeGroup`). Side effects:
 * none.
 */
export function assertTriggerTypeGroupUnchanged({
  stored,
  next,
}: {
  stored: AutomationTriggerType;
  next: AutomationTriggerType;
}): void {
  if (AUTOMATION_TRIGGER_TYPE_GROUPS[stored] === AUTOMATION_TRIGGER_TYPE_GROUPS[next]) return;
  throw new ValidationError('errors:validation.automationTriggerTypeGroup', undefined, undefined, [
    { field: 'trigger_type', messageKey: 'errors:validation.automationTriggerTypeGroup' },
  ]);
}

/** One problem with its `errors:automationProblems.<reason>` key. */
function problem({
  field,
  reason,
  messageParams,
}: {
  field: string;
  reason: string;
  messageParams?: Record<string, string | number>;
}): AutomationProblem {
  return {
    field,
    reason,
    messageKey: `errors:automationProblems.${reason}`,
    ...(messageParams === undefined ? {} : { messageParams }),
  };
}

/** Whether a text is empty after trimming. */
function isBlank(text: string | undefined | null): boolean {
  return (text ?? '').trim().length === 0;
}

/** Whether a link is an `https://` address within the length limit. */
function isHttpsLink(url: string | undefined): boolean {
  if (url === undefined || url.length > AUTOMATION_LINK_URL_MAX_LENGTH) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** A text's UTF-8 bytes (an emoji or a Gujarati letter is 2 to 4, plan §18.5). */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Go-live check 6 — the way to start's own field, and where it listens (plan §18.5). */
function listTriggerProblems(fields: AutomationWritableFields): AutomationProblem[] {
  const problems: AutomationProblem[] = [];
  const type = fields.trigger_type;
  const allowedScopes = AUTOMATION_TARGET_SCOPES_BY_TRIGGER_TYPE[type] ?? ['any'];
  if (!allowedScopes.includes(fields.target_scope)) {
    problems.push(problem({ field: 'target_scope', reason: 'target_scope_not_allowed' }));
  } else if (fields.target_scope === 'specific') {
    const isStory = type === 'story_reply';
    const id = isStory ? fields.target_instagram_story_id : fields.target_instagram_media_id;
    if (id === null) {
      problems.push(
        problem({
          field: isStory ? 'target_instagram_story_id' : 'target_instagram_media_id',
          reason: 'missing',
        }),
      );
    }
  } else if (
    fields.target_scope === 'between' &&
    (fields.target_starts_at === null || fields.target_ends_at === null)
  ) {
    problems.push(problem({ field: 'target_starts_at', reason: 'missing' }));
  }
  if (type === 'ref_link' && fields.ref_code === null) {
    problems.push(problem({ field: 'ref_code', reason: 'missing' }));
  }
  if ((type === 'ad_comment' || type === 'ad_message') && fields.ad_id === null) {
    problems.push(problem({ field: 'ad_id', reason: 'missing' }));
  }
  if ((type === 'tag_added' || type === 'tag_removed') && fields.trigger_tag === null) {
    problems.push(problem({ field: 'trigger_tag', reason: 'missing' }));
  }
  if (type === 'default_reply' && fields.default_reply_mode === null) {
    problems.push(problem({ field: 'default_reply_mode', reason: 'missing' }));
  }
  const allowedAlso = AUTOMATION_ALSO_START_FROM_BY_TRIGGER_TYPE[type] ?? [];
  if (fields.also_start_from.some((value) => !allowedAlso.includes(value))) {
    problems.push(problem({ field: 'also_start_from', reason: 'not_allowed' }));
  }
  return problems;
}

/** Go-live checks 7 and 8 (the automation's own part) — words and starter questions. */
function listWordProblems(fields: AutomationWritableFields): AutomationProblem[] {
  const problems: AutomationProblem[] = [];
  const needsKeywords =
    fields.trigger_type === 'dm_keyword' || fields.also_start_from.includes('dm');
  if (needsKeywords && fields.keywords.length === 0) {
    problems.push(problem({ field: 'keywords', reason: 'missing' }));
  }
  if (fields.trigger_type === 'starter_question') {
    if (fields.starter_questions.length === 0) {
      problems.push(problem({ field: 'starter_questions', reason: 'missing' }));
    } else if (fields.starter_questions.length > AUTOMATION_STARTER_QUESTIONS_MAX_COUNT) {
      problems.push(problem({ field: 'starter_questions', reason: 'too_many' }));
    }
  }
  if (
    fields.trigger_tag !== null &&
    fields.steps.tags?.list.some((tag) => tag.trim() === fields.trigger_tag)
  ) {
    problems.push(problem({ field: 'steps.tags.list', reason: 'trigger_tag_in_tags' }));
  }
  return problems;
}

/** Go-live check 11 — the hello, each version (P2). */
function listHelloProblems(fields: AutomationWritableFields): AutomationProblem[] {
  const hello = fields.steps.hello;
  if (hello?.on !== true) return [];
  const problems: AutomationProblem[] = [];
  if (
    hello.nudge === true &&
    !AUTOMATION_SHE_MESSAGED_FIRST_TRIGGER_TYPES.includes(fields.trigger_type)
  ) {
    problems.push(problem({ field: 'steps.hello.nudge', reason: 'not_allowed' }));
  }
  if (
    hello.versions.length === 0 ||
    hello.versions.length > AUTOMATION_MESSAGE_VERSIONS_MAX_COUNT
  ) {
    problems.push(problem({ field: 'steps.hello.versions', reason: 'count' }));
  }
  hello.versions.forEach((version, index) => {
    const path = `steps.hello.versions.${index}`;
    if (isBlank(version.text) || version.text.length > AUTOMATION_BUTTON_TEXT_MAX_LENGTH) {
      problems.push(problem({ field: `${path}.text`, reason: 'text_invalid' }));
    }
    if (
      version.buttons.length === 0 ||
      version.buttons.length > AUTOMATION_HELLO_BUTTONS_MAX_COUNT
    ) {
      problems.push(problem({ field: `${path}.buttons`, reason: 'count' }));
    }
    version.buttons.forEach((button, buttonIndex) => {
      if (isBlank(button.title) || button.title.length > AUTOMATION_BUTTON_TITLE_MAX_LENGTH) {
        problems.push(
          problem({ field: `${path}.buttons.${buttonIndex}.title`, reason: 'text_invalid' }),
        );
      }
      if (button.action === 'link' && !isHttpsLink(button.url)) {
        problems.push(
          problem({ field: `${path}.buttons.${buttonIndex}.url`, reason: 'link_invalid' }),
        );
      }
    });
    if (!version.buttons.some((button) => button.action === 'next')) {
      problems.push(problem({ field: `${path}.buttons`, reason: 'next_button_missing' }));
    }
  });
  return problems;
}

/** Go-live checks 13 and 14 — the follow ask and the email / phone wordings. */
function listAskProblems(fields: AutomationWritableFields): AutomationProblem[] {
  const problems: AutomationProblem[] = [];
  const follow = fields.steps.follow;
  if (follow?.on === true) {
    if (
      follow.versions.length === 0 ||
      follow.versions.length > AUTOMATION_MESSAGE_VERSIONS_MAX_COUNT
    ) {
      problems.push(problem({ field: 'steps.follow.versions', reason: 'count' }));
    }
    follow.versions.forEach((version, index) => {
      const path = `steps.follow.versions.${index}`;
      if (isBlank(version.text) || version.text.length > AUTOMATION_BUTTON_TEXT_MAX_LENGTH) {
        problems.push(problem({ field: `${path}.text`, reason: 'text_invalid' }));
      }
      for (const key of ['profile_button_title', 'following_button_title'] as const) {
        if (isBlank(version[key]) || version[key].length > AUTOMATION_BUTTON_TITLE_MAX_LENGTH) {
          problems.push(problem({ field: `${path}.${key}`, reason: 'text_invalid' }));
        }
      }
    });
  }
  for (const part of ['email', 'phone'] as const) {
    const ask = fields.steps[part];
    if (ask?.on !== true) continue;
    if (ask.wordings.length === 0 || ask.wordings.length > AUTOMATION_QUESTION_WORDINGS_MAX_COUNT) {
      problems.push(problem({ field: `steps.${part}.wordings`, reason: 'count' }));
    }
    ask.wordings.forEach((wording, index) => {
      if (isBlank(wording) || byteLength(wording) > AUTOMATION_MESSAGE_TEXT_MAX_BYTES) {
        problems.push(
          problem({ field: `steps.${part}.wordings.${index}`, reason: 'text_invalid' }),
        );
      }
    });
  }
  return problems;
}

/** Go-live check 15 — one message, broken for its kind (plan §5.9); files are the service's. */
function listMessageProblems({
  message,
  path,
}: {
  message: AutomationMessage;
  path: string;
}): AutomationProblem[] {
  const problems: AutomationProblem[] = [];
  if (message.wait_minutes > AUTOMATION_MESSAGE_WAIT_MAX_MINUTES) {
    problems.push(problem({ field: `${path}.wait_minutes`, reason: 'wait_too_long' }));
  }
  switch (message.kind) {
    case 'text': {
      const buttons = message.buttons ?? [];
      const isTooLong =
        buttons.length > 0
          ? message.text.length > AUTOMATION_BUTTON_TEXT_MAX_LENGTH
          : byteLength(message.text) > AUTOMATION_MESSAGE_TEXT_MAX_BYTES;
      if (isBlank(message.text) || isTooLong) {
        problems.push(problem({ field: `${path}.text`, reason: 'text_invalid' }));
      }
      if (buttons.length > AUTOMATION_LINK_BUTTONS_MAX_COUNT) {
        problems.push(problem({ field: `${path}.buttons`, reason: 'count' }));
      }
      buttons.forEach((button, index) => {
        if (isBlank(button.title) || button.title.length > AUTOMATION_BUTTON_TITLE_MAX_LENGTH) {
          problems.push(
            problem({ field: `${path}.buttons.${index}.title`, reason: 'text_invalid' }),
          );
        }
        if (!isHttpsLink(button.url)) {
          problems.push(problem({ field: `${path}.buttons.${index}.url`, reason: 'link_invalid' }));
        }
      });
      break;
    }
    case 'cards': {
      if (message.cards.length === 0 || message.cards.length > AUTOMATION_CARDS_MAX_COUNT) {
        problems.push(problem({ field: `${path}.cards`, reason: 'count' }));
      }
      message.cards.forEach((card, index) => {
        const cardPath = `${path}.cards.${index}`;
        if (isBlank(card.title) || card.title.length > AUTOMATION_CARD_TEXT_MAX_LENGTH) {
          problems.push(problem({ field: `${cardPath}.title`, reason: 'text_invalid' }));
        }
        if ((card.subtitle ?? '').length > AUTOMATION_CARD_TEXT_MAX_LENGTH) {
          problems.push(problem({ field: `${cardPath}.subtitle`, reason: 'text_invalid' }));
        }
        if (card.url !== undefined && !isHttpsLink(card.url)) {
          problems.push(problem({ field: `${cardPath}.url`, reason: 'link_invalid' }));
        }
        const hasOtherField =
          card.image_upload_id !== undefined ||
          !isBlank(card.subtitle) ||
          card.url !== undefined ||
          !isBlank(card.button_title);
        if (!hasOtherField) {
          problems.push(problem({ field: cardPath, reason: 'card_needs_more' }));
        }
      });
      break;
    }
    case 'quick_replies': {
      if (isBlank(message.text) || byteLength(message.text) > AUTOMATION_MESSAGE_TEXT_MAX_BYTES) {
        problems.push(problem({ field: `${path}.text`, reason: 'text_invalid' }));
      }
      if (
        message.replies.length === 0 ||
        message.replies.length > AUTOMATION_QUICK_REPLIES_MAX_COUNT
      ) {
        problems.push(problem({ field: `${path}.replies`, reason: 'count' }));
      }
      message.replies.forEach((reply, index) => {
        if (isBlank(reply) || reply.length > AUTOMATION_QUICK_REPLY_MAX_LENGTH) {
          problems.push(problem({ field: `${path}.replies.${index}`, reason: 'text_invalid' }));
        }
      });
      break;
    }
    default:
      // image, audio, file (the upload id the shape requires — the file check is the service's)
      // and post (`newest` or a media id) carry nothing more to check here.
      break;
  }
  return problems;
}

/** Go-live checks 12 and 15 — the message list, and a comment start without a hello. */
function listMessagesProblems(fields: AutomationWritableFields): AutomationProblem[] {
  const messages = fields.steps.messages ?? [];
  const problems: AutomationProblem[] = [];
  if (messages.length === 0 || messages.length > AUTOMATION_MESSAGES_MAX_COUNT) {
    problems.push(problem({ field: 'steps.messages', reason: 'count' }));
  }
  messages.forEach((message, index) => {
    problems.push(...listMessageProblems({ message, path: `steps.messages.${index}` }));
  });
  const hasAsk =
    fields.steps.hello?.on === true ||
    fields.steps.follow?.on === true ||
    fields.steps.email?.on === true ||
    fields.steps.phone?.on === true;
  if (AUTOMATION_COMMENT_TRIGGER_TYPES.includes(fields.trigger_type) && !hasAsk) {
    const first = messages[0];
    const isOnePlainText =
      messages.length === 1 && first?.kind === 'text' && first.image_upload_id === undefined;
    if (!isOnePlainText) {
      problems.push(problem({ field: 'steps.hello.on', reason: 'comment_needs_hello' }));
    }
  }
  return problems;
}

/** Go-live checks 16 and 17 — public reply lines, hide, tags. */
function listReplyAndTagProblems(fields: AutomationWritableFields): AutomationProblem[] {
  const problems: AutomationProblem[] = [];
  const isCommentStart = fields.trigger_type === 'comment' || fields.trigger_type === 'ad_comment';
  if (fields.is_public_reply_enabled) {
    if (!isCommentStart) {
      problems.push(problem({ field: 'is_public_reply_enabled', reason: 'not_allowed' }));
    } else if (fields.public_reply_texts.length === 0) {
      problems.push(problem({ field: 'public_reply_texts', reason: 'missing' }));
    } else if (
      fields.is_reply_like_person_enabled &&
      fields.public_reply_texts.length <
        AUTOMATION_PUBLIC_REPLY_LINES_WITH_REPLY_LIKE_PERSON_MIN_COUNT
    ) {
      problems.push(
        problem({
          field: 'public_reply_texts',
          reason: 'reply_lines_too_few',
          messageParams: { min: AUTOMATION_PUBLIC_REPLY_LINES_WITH_REPLY_LIKE_PERSON_MIN_COUNT },
        }),
      );
    }
  }
  if (fields.is_hide_comment_after_direct_message_enabled && !isCommentStart) {
    problems.push(
      problem({ field: 'is_hide_comment_after_direct_message_enabled', reason: 'not_allowed' }),
    );
  }
  const tags = fields.steps.tags;
  if (tags?.on === true) {
    if (tags.list.length === 0 || tags.list.length > AUTOMATION_TAGS_MAX_COUNT) {
      problems.push(problem({ field: 'steps.tags.list', reason: 'count' }));
    }
    tags.list.forEach((tag, index) => {
      if (isBlank(tag) || tag.length > AUTOMATION_TAG_MAX_LENGTH) {
        problems.push(problem({ field: `steps.tags.list.${index}`, reason: 'text_invalid' }));
      }
    });
  }
  return problems;
}

/**
 * The go-live **content** checks of an automation (AU13's 1 and 6–17 without the account-wide ones,
 * AUQ2): what a save of a live or paused automation runs on the merged result (AU12) and what
 * go-live lists with the account, plan, month, feature, file, starter-total, ref-code and catch-all
 * checks the service adds. Each problem names its step path so the editor jumps there.
 *
 * @remarks
 * Algorithm: pure — name; the way to start's own field and where it listens; words; starter
 * questions; the tag start's tag; the hello (P2 — a "sends your next step" button in every
 * version); the follow ask; the email / phone wordings; the message list (1–10, each complete for
 * its kind, waits ≤ 23 h, text ≤ 1,000 bytes or ≤ 640 characters with buttons); a comment start
 * without a hello is one plain text; public reply lines (≥ 3 with "Reply like a person"); hide;
 * tags. Failure modes: none (it answers a list). Side effects: none.
 */
export function listAutomationContentProblems(
  fields: AutomationWritableFields,
): AutomationProblem[] {
  const problems: AutomationProblem[] = [];
  if (isBlank(fields.name) || fields.name.length > AUTOMATION_NAME_MAX_LENGTH) {
    problems.push(problem({ field: 'name', reason: 'missing' }));
  }
  if (fields.ref_code !== null && fields.ref_code.length > AUTOMATION_REF_CODE_MAX_LENGTH) {
    problems.push(problem({ field: 'ref_code', reason: 'text_invalid' }));
  }
  return [
    ...problems,
    ...listTriggerProblems(fields),
    ...listWordProblems(fields),
    ...listHelloProblems(fields),
    ...listAskProblems(fields),
    ...listMessagesProblems(fields),
    ...listReplyAndTagProblems(fields),
  ];
}

/**
 * Throws route 30's `400` for a live or paused automation's content problems (AU12): one
 * `errors[]` item per problem, its `field` the body path (`body.steps.hello.versions.0.buttons`).
 *
 * @remarks
 * Failure modes: `ValidationError` (`errors:automationContentInvalid`) when any. Side effects: none.
 */
export function assertNoContentProblems(problems: readonly AutomationProblem[]): void {
  if (problems.length === 0) return;
  const items: ValidationErrorItem[] = problems.map((item) => ({
    field: `body.${item.field}`,
    reason: item.reason,
    messageKey: item.messageKey,
    ...(item.messageParams === undefined ? {} : { messageParams: item.messageParams }),
  }));
  throw new ValidationError('errors:automationContentInvalid', undefined, undefined, items);
}

/**
 * The PRO features an automation uses (AU4 (2), P83): each part its own plan switch — the email and
 * phone asks, "Reply like a person" with the public reply on, more than one reply line, a second
 * hello or follow version; a `starter_question` start reads `starter_questions`.
 */
export function listAutomationProFeatures(fields: AutomationWritableFields): ChannelFeature[] {
  const features: ChannelFeature[] = [];
  if (fields.steps.email?.on === true) features.push('email_ask');
  if (fields.steps.phone?.on === true) features.push('phone_ask');
  if (fields.is_public_reply_enabled && fields.is_reply_like_person_enabled) {
    features.push('reply_like_person');
  }
  if (fields.is_public_reply_enabled && fields.public_reply_texts.length > 1) {
    features.push('multiple_public_reply_lines');
  }
  const hasSecondVersion =
    (fields.steps.hello?.on === true && fields.steps.hello.versions.length > 1) ||
    (fields.steps.follow?.on === true && fields.steps.follow.versions.length > 1);
  if (hasSecondVersion) features.push('message_versions');
  return features;
}

/**
 * Every feature-check part of an automation (AU34, CA11): the way to start, each step it uses, each
 * message kind and each plan feature — what go-live hands 1B's one feature check.
 */
export function listAutomationFeatureParts(fields: AutomationWritableFields): {
  triggerType: AutomationTriggerType;
  steps: string[];
  messageKinds: string[];
  features: ChannelFeature[];
} {
  const steps: string[] = ['messages'];
  for (const part of ['hello', 'follow', 'email', 'phone', 'tags'] as const) {
    if (fields.steps[part]?.on === true) steps.push(part);
  }
  if (fields.is_public_reply_enabled) steps.push('public_reply');
  if (fields.is_hide_comment_after_direct_message_enabled) steps.push('hide_comment');
  const features = listAutomationProFeatures(fields);
  if (fields.trigger_type === 'starter_question') features.push('starter_questions');
  return {
    triggerType: fields.trigger_type,
    steps,
    messageKinds: [...new Set((fields.steps.messages ?? []).map((message) => message.kind))],
    features,
  };
}

/** Every upload an automation sends, with its step path (go-live check 15, D58). */
export function listAutomationUploads(
  steps: AutomationSteps,
): { field: string; uploadPublicId: string }[] {
  const uploads: { field: string; uploadPublicId: string }[] = [];
  (steps.messages ?? []).forEach((message, index) => {
    const path = `steps.messages.${index}`;
    if (message.kind === 'text' && message.image_upload_id !== undefined) {
      uploads.push({ field: `${path}.image_upload_id`, uploadPublicId: message.image_upload_id });
    }
    if (message.kind === 'image' || message.kind === 'audio' || message.kind === 'file') {
      uploads.push({ field: `${path}.upload_id`, uploadPublicId: message.upload_id });
    }
    if (message.kind === 'cards') {
      message.cards.forEach((card, cardIndex) => {
        if (card.image_upload_id !== undefined) {
          uploads.push({
            field: `${path}.cards.${cardIndex}.image_upload_id`,
            uploadPublicId: card.image_upload_id,
          });
        }
      });
    }
  });
  return uploads;
}

/**
 * A free `ref_code` (AU11, AU15): `base` (cut to leave room) plus `-` and 4 random characters — the
 * old one plus a tail for a duplicate, a random one for a `ref_link` draft without one.
 */
export function generateAutomationRefCode(base: string | null): string {
  const tail = randomBytes(8)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, AUTOMATION_REF_CODE_SUFFIX_LENGTH)
    .padEnd(AUTOMATION_REF_CODE_SUFFIX_LENGTH, 'x');
  if (base === null) return `link-${tail}`;
  const room = AUTOMATION_REF_CODE_MAX_LENGTH - AUTOMATION_REF_CODE_SUFFIX_LENGTH - 1;
  return `${base.slice(0, room)}-${tail}`;
}
