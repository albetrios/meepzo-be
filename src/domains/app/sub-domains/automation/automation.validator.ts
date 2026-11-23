import { ConflictError, ValidationError, type ValidationErrorItem } from '@/shared/errors/index.js';
import {
  DEFAULT_INVALID_INPUT_ERROR_KEY,
  parseWithSchema,
} from '@/shared/utils/validation/parse-with-schema.util.js';
import { AUTOMATION_NEXT_POST_START_GRACE_MILLISECONDS } from './automation.constants.js';
import {
  createAutomationDto,
  deleteAutomationQueryDto,
  listAutomationsQueryDto,
  updateAutomationDto,
  type CreateAutomationInput,
  type UpdateAutomationInput,
} from './automation.dto.js';
import type {
  AutomationCreateChanges,
  AutomationDeleteReason,
  AutomationFinalMessage,
  AutomationListQuery,
  AutomationMergedFields,
  AutomationOpeningMessage,
  AutomationStoredNextPost,
  AutomationUpdateChanges,
  AutomationWritableFields,
} from './automation.types.js';

/** The message objects as the DTO parses them — `button_title` and `links` may be absent. */
type ParsedOpeningMessage = NonNullable<CreateAutomationInput['opening_message']>;
type ParsedFinalMessage = CreateAutomationInput['final_message'];

/** The writable fields of either body, as the DTOs parse them (every one optional here). */
type ParsedWritableFields = Omit<UpdateAutomationInput, 'expected_updated_at'>;

/** The opening message as it is stored: `button_title` always present (`null` = no button). */
function toOpeningMessage(message: ParsedOpeningMessage): AutomationOpeningMessage {
  return { text: message.text, button_title: message.button_title ?? null };
}

/** The final message as it is stored: `links` always present (empty = none). */
function toFinalMessage(message: ParsedFinalMessage): AutomationFinalMessage {
  return {
    text: message.text,
    links: (message.links ?? []).map((link) => ({ title: link.title, url: link.url })),
  };
}

/** Each value once, in the order first sent. */
function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * The fields a parsed body sets, normalised as the table stores them (AU7): keywords lowercased and
 * deduplicated (the DTO trimmed them), tags deduplicated, the window ends as dates, the opening
 * message's `button_title` and the final message's `links` always present. A field the body left
 * out stays absent; `null` stays `null` (it clears a nullable field).
 */
function normalizeWritableFields(parsed: ParsedWritableFields): AutomationUpdateChanges {
  const changes: AutomationUpdateChanges = {};
  const copiedKeys = [
    'name',
    'status',
    'trigger_type',
    'target_scope',
    'target_instagram_media_id',
    'target_instagram_story_id',
    'is_dm_keyword_trigger_enabled',
    'is_public_reply_enabled',
    'public_reply_texts',
    'is_opening_message_enabled',
    'is_follow_required',
    'follow_request_message',
    'is_email_collection_enabled',
    'email_request_message',
    'is_phone_collection_enabled',
    'phone_request_message',
  ] as const satisfies readonly (keyof ParsedWritableFields & keyof AutomationUpdateChanges)[];
  for (const key of copiedKeys) {
    if (parsed[key] !== undefined) {
      Object.assign(changes, { [key]: parsed[key] });
    }
  }
  if (parsed.keywords !== undefined) {
    changes.keywords = uniqueValues(parsed.keywords.map((keyword) => keyword.toLowerCase()));
  }
  if (parsed.tags !== undefined) changes.tags = uniqueValues(parsed.tags);
  if (parsed.next_post_starts_at !== undefined) {
    changes.next_post_starts_at =
      parsed.next_post_starts_at === null ? null : new Date(parsed.next_post_starts_at);
  }
  if (parsed.next_post_ends_at !== undefined) {
    changes.next_post_ends_at =
      parsed.next_post_ends_at === null ? null : new Date(parsed.next_post_ends_at);
  }
  if (parsed.opening_message !== undefined) {
    changes.opening_message =
      parsed.opening_message === null ? null : toOpeningMessage(parsed.opening_message);
  }
  if (parsed.final_message !== undefined) {
    changes.final_message = toFinalMessage(parsed.final_message);
  }
  return changes;
}

/**
 * Parses the `POST /app/automations` body (route 12) with the strict {@link createAutomationDto}
 * and normalises it (keywords lowercased and deduplicated, tags deduplicated, dates as `Date`).
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) on a bad shape, a value out of range, an unknown or
 * read-only field (`instagram_account_id` included, AU27), a missing or `null` `final_message`
 * (D19). The cross-field rules run later on the merged automation ({@link validateAutomationFlow}).
 */
export function validateCreateAutomation(data: unknown): AutomationCreateChanges {
  const parsed = parseWithSchema({ schema: createAutomationDto, data });
  const changes = normalizeWritableFields(parsed);
  return {
    ...changes,
    name: parsed.name,
    trigger_type: parsed.trigger_type,
    final_message: toFinalMessage(parsed.final_message),
  };
}

/**
 * Parses the `PATCH /app/automations/{automation_id}` body (route 14) with the strict
 * {@link updateAutomationDto}: the normalised changes and the `expected_updated_at` the client
 * opened (AU11).
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) as {@link validateCreateAutomation}, plus an empty body
 * (`errors:validation.sendAtLeastOneField`).
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
 * Parses the `GET /app/automations` query (route 11) with the strict
 * {@link listAutomationsQueryDto} into the service's {@link AutomationListQuery}.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`, `errors[].field` the parameter) on a bad value, a
 * malformed `instagram_account_id` or an unknown parameter.
 */
export function validateListAutomationsQuery(data: unknown): AutomationListQuery {
  const parsed = parseWithSchema({ schema: listAutomationsQueryDto, data });
  return {
    limit: parsed.limit,
    after: parsed.after,
    q: parsed.q,
    sort: parsed.sort,
    order: parsed.order,
    status: parsed.status,
    triggerType: parsed.trigger_type,
    targetScope: parsed.target_scope,
    nextPostStatus: parsed.next_post_status,
    instagramAccountPublicId: parsed.instagram_account_id,
  };
}

/**
 * Parses the `DELETE /app/automations/{automation_id}` query (route 15, AU12, AQ6): the reason, and
 * the note `other` requires.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) on a missing or unknown reason, `other` without a note,
 * a note over 280 characters, or an unknown parameter.
 */
export function validateDeleteAutomationQuery(data: unknown): AutomationDeleteReason {
  const parsed = parseWithSchema({ schema: deleteAutomationQueryDto, data });
  return { reason: parsed.reason, note: parsed.note ?? null };
}

/**
 * The automation a create saves: the defaults of 3.A.3 with the body laid over them (AU8) —
 * `inactive`, `any`, the DM keyword trigger and the opening message on, everything else off or
 * empty.
 */
export function mergeAutomationForCreate(
  changes: AutomationCreateChanges,
): AutomationWritableFields {
  return {
    status: 'inactive',
    target_scope: 'any',
    target_instagram_media_id: null,
    target_instagram_story_id: null,
    next_post_starts_at: null,
    next_post_ends_at: null,
    is_dm_keyword_trigger_enabled: true,
    keywords: [],
    tags: [],
    is_public_reply_enabled: false,
    public_reply_texts: [],
    is_opening_message_enabled: true,
    opening_message: null,
    is_follow_required: false,
    follow_request_message: null,
    is_email_collection_enabled: false,
    email_request_message: null,
    is_phone_collection_enabled: false,
    phone_request_message: null,
    ...changes,
  };
}

/**
 * The automation an edit saves: the stored automation with the body laid over it (§6.10 — "all
 * create rules run on the merged automation", AU8). A field the body left out keeps its stored
 * value; a message object is replaced whole, never merged key by key.
 */
export function mergeAutomationForUpdate({
  stored,
  changes,
}: {
  stored: AutomationWritableFields;
  changes: AutomationUpdateChanges;
}): AutomationWritableFields {
  const merged: AutomationWritableFields = { ...stored };
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) Object.assign(merged, { [key]: value });
  }
  return merged;
}

/** One broken rule as an `errors[]` item on its body field. */
interface FlowIssue {
  field: string;
  messageKey: string;
}

/** Collects at most one issue per field — the first rule that breaks it. */
class FlowIssueList {
  private readonly issues = new Map<string, FlowIssue>();

  add({ field, messageKey }: FlowIssue): void {
    const bodyField = `body.${field}`;
    if (!this.issues.has(bodyField)) {
      this.issues.set(bodyField, { field: bodyField, messageKey });
    }
  }

  has(field: string): boolean {
    return this.issues.has(`body.${field}`);
  }

  toItems(): ValidationErrorItem[] {
    return [...this.issues.values()].map(({ field, messageKey }) => ({ field, messageKey }));
  }
}

/** The window rules of a `next` automation (AU9), added to `issues`. */
function addNextPostWindowIssues({
  automation,
  stored,
  now,
  issues,
}: {
  automation: AutomationWritableFields;
  stored: AutomationStoredNextPost | null;
  now: Date;
  issues: FlowIssueList;
}): void {
  const startsAt = automation.next_post_starts_at;
  const endsAt = automation.next_post_ends_at;
  if (startsAt === null)
    issues.add({
      field: 'next_post_starts_at',
      messageKey: 'errors:validation.nextPostDatesRequired',
    });
  if (endsAt === null)
    issues.add({
      field: 'next_post_ends_at',
      messageKey: 'errors:validation.nextPostDatesRequired',
    });
  if (startsAt === null || endsAt === null) return;
  if (endsAt.getTime() <= startsAt.getTime()) {
    issues.add({
      field: 'next_post_ends_at',
      messageKey: 'errors:validation.nextPostEndBeforeStart',
    });
  }
  // Only a stored `next` window counts as the one being changed; anything else is new.
  const storedWindow = stored?.target_scope === 'next' ? stored : null;
  const storedStartsAt = storedWindow?.next_post_starts_at ?? null;
  const storedEndsAt = storedWindow?.next_post_ends_at ?? null;
  const isStartChanged = storedStartsAt?.getTime() !== startsAt.getTime();
  const isEndChanged = storedEndsAt?.getTime() !== endsAt.getTime();
  if (isStartChanged) {
    const hasStarted = storedStartsAt !== null && storedStartsAt.getTime() <= now.getTime();
    if (hasStarted && startsAt.getTime() < storedStartsAt.getTime()) {
      issues.add({
        field: 'next_post_starts_at',
        messageKey: 'errors:validation.nextPostStartMovedEarlier',
      });
    } else if (startsAt.getTime() < now.getTime() - AUTOMATION_NEXT_POST_START_GRACE_MILLISECONDS) {
      issues.add({
        field: 'next_post_starts_at',
        messageKey: 'errors:validation.nextPostStartInPast',
      });
    }
  }
  if (isEndChanged && endsAt.getTime() < now.getTime()) {
    issues.add({ field: 'next_post_ends_at', messageKey: 'errors:validation.nextPostEndInPast' });
  }
}

/** One target id rule: the id must be set (`required`) or must be absent (`forbidden`). */
interface TargetIdCheck {
  field: 'target_instagram_media_id' | 'target_instagram_story_id';
  rule: 'required' | 'forbidden';
}

/**
 * The target id checks of a scope and trigger, in the order they are reported: `specific` needs the
 * id of its trigger (a comment's media, a story reply's story) and no other — a `dm` names none —
 * while `next` and `any` name none.
 */
function targetIdChecks(automation: AutomationWritableFields): TargetIdCheck[] {
  if (automation.target_scope !== 'specific') {
    return [
      { field: 'target_instagram_media_id', rule: 'forbidden' },
      { field: 'target_instagram_story_id', rule: 'forbidden' },
    ];
  }
  if (automation.trigger_type === 'comment') {
    return [
      { field: 'target_instagram_media_id', rule: 'required' },
      { field: 'target_instagram_story_id', rule: 'forbidden' },
    ];
  }
  if (automation.trigger_type === 'story_reply') {
    return [
      { field: 'target_instagram_story_id', rule: 'required' },
      { field: 'target_instagram_media_id', rule: 'forbidden' },
    ];
  }
  return [];
}

/** The target id rules (AU8, 3.A.9): each scope names exactly the ids it needs, and no other. */
function addTargetIdIssues({
  automation,
  isMediaIdSent,
  issues,
}: {
  automation: AutomationWritableFields;
  isMediaIdSent: boolean;
  issues: FlowIssueList;
}): void {
  const isSet = {
    // On `next` the server sets the media id when it links (AU9): only one the body sends counts.
    target_instagram_media_id:
      automation.target_scope === 'next'
        ? isMediaIdSent
        : automation.target_instagram_media_id !== null,
    target_instagram_story_id: automation.target_instagram_story_id !== null,
  };
  for (const { field, rule } of targetIdChecks(automation)) {
    const isBroken = rule === 'required' ? !isSet[field] : isSet[field];
    if (isBroken) {
      issues.add({ field, messageKey: 'errors:validation.specificNeedsTarget' });
    }
  }
}

/** The scope rules (AU8): `next` only on comments, and a `dm` automation only on `any`. */
function addTargetScopeIssues({
  automation,
  issues,
}: {
  automation: AutomationWritableFields;
  issues: FlowIssueList;
}): void {
  if (automation.target_scope === 'next' && automation.trigger_type !== 'comment') {
    issues.add({ field: 'target_scope', messageKey: 'errors:validation.nextScopeOnlyForComments' });
  }
  if (automation.trigger_type === 'dm' && automation.target_scope !== 'any') {
    issues.add({ field: 'target_scope', messageKey: 'errors:validation.dmScopeOnlyAny' });
  }
}

/** The `dm` trigger rules (AU8): at least one keyword, and the DM keyword trigger on. */
function addDirectMessageIssues({
  automation,
  issues,
}: {
  automation: AutomationWritableFields;
  issues: FlowIssueList;
}): void {
  if (automation.trigger_type !== 'dm') return;
  if (automation.keywords.length === 0) {
    issues.add({ field: 'keywords', messageKey: 'errors:validation.dmNeedsKeyword' });
  }
  if (!automation.is_dm_keyword_trigger_enabled) {
    issues.add({
      field: 'is_dm_keyword_trigger_enabled',
      messageKey: 'errors:validation.dmKeywordTriggerRequired',
    });
  }
}

/** The public reply rules (AU8): only on comments, and with at least one text. */
function addPublicReplyIssues({
  automation,
  issues,
}: {
  automation: AutomationWritableFields;
  issues: FlowIssueList;
}): void {
  if (!automation.is_public_reply_enabled) return;
  if (automation.trigger_type !== 'comment') {
    issues.add({
      field: 'is_public_reply_enabled',
      messageKey: 'errors:validation.publicReplyOnlyForComments',
    });
  } else if (automation.public_reply_texts.length === 0) {
    issues.add({
      field: 'public_reply_texts',
      messageKey: 'errors:validation.publicReplyOnlyForComments',
    });
  }
}

/**
 * The message rules (AU8, AQ2): the opening and follow messages saved when their step is on, and
 * the opening button on a comment automation's opening message.
 */
function addMessageIssues({
  automation,
  issues,
}: {
  automation: AutomationWritableFields;
  issues: FlowIssueList;
}): void {
  const opening = automation.is_opening_message_enabled ? automation.opening_message : undefined;
  if (opening === null) {
    issues.add({ field: 'opening_message', messageKey: 'errors:validation.messageObjectRequired' });
  }
  if (automation.trigger_type === 'comment' && opening?.button_title === null) {
    issues.add({
      field: 'opening_message.button_title',
      messageKey: 'errors:validation.openingButtonRequired',
    });
  }
  if (automation.is_follow_required && automation.follow_request_message === null) {
    issues.add({
      field: 'follow_request_message',
      messageKey: 'errors:validation.messageObjectRequired',
    });
  }
}

/**
 * The one flow rule set, run on the merged automation — create = the defaults + the body, edit =
 * the stored row + the body (AU8). Every save is complete, whatever the status, so "`status = live`
 * needs a complete flow" is this same check.
 *
 * @remarks
 * - **Algorithm:** collects one `errors[]` item per broken field (the first rule that breaks it,
 *   `body.<field>`): the scope (`next` only on comments, `dm` only `any`); the target ids (each
 *   scope names exactly the ids it needs; a media id sent on `next`); `dm` needs a keyword and the
 *   DM keyword trigger on; a public reply only on comments, with 1–20 texts; the opening and
 *   follow messages when their step is on; the opening button on a comment automation with the
 *   opening message on (AQ2); the "next post" window (AU9) — both dates, the end after the start,
 *   a new or changed start not before 24 hours ago, a started window never moved earlier, a new or
 *   changed end not in the past.
 * - **Failure modes:** `ValidationError` (`400`, `errors:invalidInput`) with every item.
 * - **Side effects:** none — a pure function of its input and `now`.
 * - **Notes:** `stored` is the edited row's "next post" state (`null` on a create); a date is
 *   "changed" when it differs from a stored `next` window. `isMediaIdSent` is the body sending a
 *   media id (not `null`, and on an edit not the stored one) — never allowed on `next`, where the
 *   server sets it when it links.
 */
export function validateAutomationFlow({
  automation,
  stored,
  isMediaIdSent,
  now,
}: {
  automation: AutomationWritableFields;
  stored: AutomationStoredNextPost | null;
  isMediaIdSent: boolean;
  now: Date;
}): void {
  const issues = new FlowIssueList();
  addTargetScopeIssues({ automation, issues });
  addTargetIdIssues({ automation, isMediaIdSent, issues });
  addDirectMessageIssues({ automation, issues });
  addPublicReplyIssues({ automation, issues });
  addMessageIssues({ automation, issues });
  if (automation.target_scope === 'next' && !issues.has('target_scope')) {
    addNextPostWindowIssues({ automation, stored, now, issues });
  }
  const items = issues.toItems();
  if (items.length > 0) {
    throw new ValidationError(DEFAULT_INVALID_INPUT_ERROR_KEY, undefined, undefined, items);
  }
}

/**
 * Refuses an edit that would change a `linked` automation's window, scope or target ids (AU9):
 * `409 next_post_already_linked`. A field sent with its stored value is no change.
 *
 * @remarks
 * Failure modes: `ConflictError('errors:nextPostAlreadyLinked')`, reason
 * `next_post_already_linked`. Side effects: none.
 */
export function assertNextPostLinkUnchanged({
  stored,
  changes,
}: {
  stored: Pick<
    AutomationMergedFields,
    | 'next_post_status'
    | 'target_scope'
    | 'target_instagram_media_id'
    | 'target_instagram_story_id'
    | 'next_post_starts_at'
    | 'next_post_ends_at'
  >;
  changes: AutomationUpdateChanges;
}): void {
  if (stored.next_post_status !== 'linked') return;
  const isDateChanged = ({ sent, kept }: { sent: Date | null | undefined; kept: Date | null }) =>
    sent !== undefined && sent?.getTime() !== kept?.getTime();
  const isValueChanged = ({
    sent,
    kept,
  }: {
    sent: string | null | undefined;
    kept: string | null;
  }) => sent !== undefined && sent !== kept;
  if (
    isValueChanged({ sent: changes.target_scope, kept: stored.target_scope }) ||
    isValueChanged({
      sent: changes.target_instagram_media_id,
      kept: stored.target_instagram_media_id,
    }) ||
    isValueChanged({
      sent: changes.target_instagram_story_id,
      kept: stored.target_instagram_story_id,
    }) ||
    isDateChanged({ sent: changes.next_post_starts_at, kept: stored.next_post_starts_at }) ||
    isDateChanged({ sent: changes.next_post_ends_at, kept: stored.next_post_ends_at })
  ) {
    throw new ConflictError('errors:nextPostAlreadyLinked').withReason('next_post_already_linked');
  }
}

/**
 * The "next post" state a save gives the merged automation (AU9): outside `next` every next-post
 * field is cleared; a new `next` waits; a stored `linked` one keeps its link; a stored `expired`
 * one waits again when its window changed; a stored `waiting` one keeps waiting.
 *
 * @remarks
 * Pure — the caller has already refused a change to a linked window ({@link
 * assertNextPostLinkUnchanged}) and checked the window ({@link validateAutomationFlow}).
 */
export function resolveNextPostState({
  automation,
  stored,
}: {
  automation: AutomationWritableFields;
  stored:
    | (AutomationStoredNextPost & {
        next_post_linked_at: Date | null;
        target_instagram_media_id: string | null;
      })
    | null;
}): AutomationMergedFields {
  if (automation.target_scope !== 'next') {
    return {
      ...automation,
      next_post_starts_at: null,
      next_post_ends_at: null,
      next_post_status: null,
      next_post_linked_at: null,
    };
  }
  const storedNext = stored?.target_scope === 'next' ? stored : null;
  if (storedNext?.next_post_status === 'linked') {
    return {
      ...automation,
      target_instagram_media_id: storedNext.target_instagram_media_id,
      next_post_status: 'linked',
      next_post_linked_at: storedNext.next_post_linked_at,
    };
  }
  const isWindowChanged =
    storedNext === null ||
    storedNext.next_post_starts_at?.getTime() !== automation.next_post_starts_at?.getTime() ||
    storedNext.next_post_ends_at?.getTime() !== automation.next_post_ends_at?.getTime();
  const nextPostStatus =
    storedNext?.next_post_status === 'expired' && !isWindowChanged ? 'expired' : 'waiting';
  return {
    ...automation,
    target_instagram_media_id: null,
    next_post_status: nextPostStatus,
    next_post_linked_at: null,
  };
}
