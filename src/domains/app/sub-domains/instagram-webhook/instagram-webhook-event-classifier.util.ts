import { createHash } from 'node:crypto';
import type {
  InstagramWebhookEventKind,
  InstagramWebhookEventSkipReason,
} from './instagram-webhook-event/instagram-webhook-event.constants.js';
import {
  INSTAGRAM_WEBHOOK_EVENT_KEY_MAX_LENGTH,
  INSTAGRAM_WEBHOOK_USER_ID_PATTERN,
} from './instagram-webhook.constants.js';

/** A JSON object as Meta sent it. */
type MetaObject = Record<string, unknown>;

/**
 * A Meta time at or above this is milliseconds (`messaging[].timestamp`), below it seconds
 * (`entry.time` of a `changes[]` delivery): 1e11 seconds is the year 5138, 1e11 ms is 1973.
 */
const META_MILLISECOND_TIME_THRESHOLD = 100_000_000_000;

/**
 * The two Instagram ids of the account a delivery entry is for (WH9): the webhook user id (the
 * entry's `id`) and the app-scoped id used in send URLs. Activity by either is the account's own.
 */
export interface InstagramWebhookAccountIds {
  instagramUserId: string;
  instagramAppUserId: string;
}

/** Where an item sat in its entry: a `changes[]` item or a `messaging[]` item. */
export type InstagramWebhookItemSource = 'changes' | 'messaging';

/** One item of a delivery entry, a JSON object — one event (WH9). */
export interface InstagramWebhookEntryItem {
  source: InstagramWebhookItemSource;
  item: MetaObject;
}

/**
 * What the classifier makes of one item (feat-instagram-dm-sending routes-final § 5.A.10): its
 * kind, its key (unique per account), the kind's own skip reason, the person on the other side,
 * Meta's time and the item as received.
 */
export interface ClassifiedInstagramWebhookEvent {
  eventKind: InstagramWebhookEventKind;
  /** At most 512 characters; unique per Instagram account, never across accounts. */
  eventKey: string;
  /** `own_comment` · `edit` · `unsupported`, or `null` for an event to handle. */
  kindSkipReason: InstagramWebhookEventSkipReason | null;
  /** The sender (an echo: the recipient), digits only; `null` when the item names nobody else. */
  contactInstagramUserId: string | null;
  /** The item's `timestamp`, else the entry's `time`; `null` when neither reads as a time. */
  occurredAt: Date | null;
  /**
   * The item as the receiver hands it — as Meta sent it, its text already cleaned for Postgres
   * (D53); for a `messages` change, the whole change item.
   */
  payload: MetaObject;
  /**
   * An `echo`'s `mid` — only on an echo: the receiver drops it when the own-message lookup knows
   * it as one of our sent messages (WH9 step 3, WHQ1).
   */
  echoMessageId?: string;
}

/** `value` as a JSON object, or `null` (an array, a scalar, nothing). */
function asMetaObject(value: unknown): MetaObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as MetaObject)
    : null;
}

/** A non-empty string, or a finite number as text — an opaque Meta identifier; else `null`. */
function readIdentifier(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** The SHA-256 (hex) of a string as it is, of anything else as its JSON. */
function sha256Hex(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value ?? null) ?? 'null');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * An Instagram id as the events table stores it — digits, at most 64 (a digit string, or a JSON
 * number that is still exact) — else `null`.
 */
export function readInstagramWebhookUserId(value: unknown): string | null {
  if (typeof value === 'string')
    return INSTAGRAM_WEBHOOK_USER_ID_PATTERN.test(value) ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/**
 * A Meta time — Unix seconds or milliseconds, a number or a digit string — as a `Date`; `null`
 * when it is missing or out of range.
 */
export function readInstagramWebhookTime(value: unknown): Date | null {
  let numeric = Number.NaN;
  if (typeof value === 'number') numeric = value;
  else if (typeof value === 'string' && /^\d{1,16}$/.test(value)) numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const milliseconds =
    numeric < META_MILLISECOND_TIME_THRESHOLD ? numeric * 1000 : Math.trunc(numeric);
  const time = new Date(milliseconds);
  return Number.isNaN(time.getTime()) ? null : time;
}

/**
 * An event key from its prefix and parts, `<prefix>:<part>:…` — at most 512 characters; a longer
 * one becomes `<prefix>:sha256:<64 hex>` of its parts (5.A.10).
 */
export function buildInstagramWebhookEventKey({
  prefix,
  parts,
}: {
  prefix: string;
  parts: readonly string[];
}): string {
  const key = [prefix, ...parts].join(':');
  if (key.length <= INSTAGRAM_WEBHOOK_EVENT_KEY_MAX_LENGTH) return key;
  return `${prefix}:sha256:${sha256Hex(parts.join(':'))}`;
}

/**
 * Splits one delivery entry into its items (WH9): each `changes[]` item and each `messaging[]` item
 * is one event. An item that is not a JSON object cannot be stored (the payload column holds an
 * object) and is counted in `droppedItemCount` instead.
 */
export function listInstagramWebhookEntryItems({
  changes,
  messaging,
}: {
  changes?: readonly unknown[] | undefined;
  messaging?: readonly unknown[] | undefined;
}): { items: InstagramWebhookEntryItem[]; droppedItemCount: number } {
  const items: InstagramWebhookEntryItem[] = [];
  let droppedItemCount = 0;
  const sources: Array<[InstagramWebhookItemSource, readonly unknown[] | undefined]> = [
    ['changes', changes],
    ['messaging', messaging],
  ];
  for (const [source, list] of sources) {
    for (const candidate of list ?? []) {
      const item = asMetaObject(candidate);
      if (item === null) droppedItemCount += 1;
      else items.push({ source, item });
    }
  }
  return { items, droppedItemCount };
}

/** Whether an Instagram id is either of the account's own (WH9). */
function isAccountItself({
  instagramId,
  accountIds,
}: {
  instagramId: string | null;
  accountIds: InstagramWebhookAccountIds;
}): boolean {
  return (
    instagramId !== null &&
    (instagramId === accountIds.instagramUserId || instagramId === accountIds.instagramAppUserId)
  );
}

/** The `id` of a nested `{ id }` object (`sender`, `recipient`, `from`) as an Instagram id. */
function readNestedUserId({ object, key }: { object: MetaObject; key: string }): string | null {
  return readInstagramWebhookUserId(asMetaObject(object[key])?.id);
}

/** The shared input of the item classifiers. */
interface ItemClassification {
  accountIds: InstagramWebhookAccountIds;
  /** The entry's `time`, the fallback for `occurredAt`. */
  entryTime: unknown;
}

/** What one `messaging[]` rule of 5.A.10 decides: the kind, the key's prefix and parts, the reason. */
interface MessagingRule {
  eventKind: InstagramWebhookEventKind;
  prefix: string;
  parts: readonly string[];
  kindSkipReason: InstagramWebhookEventSkipReason | null;
  /** Only an echo names someone else than the sender (its recipient). */
  contactIsRecipient?: boolean;
  /** An echo's `mid` (see {@link ClassifiedInstagramWebhookEvent.echoMessageId}). */
  echoMessageId?: string;
}

/** The `type` of each of a message's attachments (`story_mention`, `share`, `ig_post`, `image`, …). */
function readAttachmentTypes(message: MetaObject): string[] {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  return attachments
    .map((attachment) => asMetaObject(attachment)?.type)
    .filter((type): type is string => typeof type === 'string');
}

/** A message attachment type that shares a post (5.A.10, Meta test). */
const SHARED_POST_ATTACHMENT_TYPES: ReadonlySet<string> = new Set(['share', 'ig_post']);

/** The payload prefix of a starter-question tap (5.A.10 `ice_breaker`, WH8). */
const STARTER_QUESTION_PAYLOAD_PREFIX = 'starter:';

/**
 * The 5.A.10 rule of a link or ad referral — `referral:<sender>:<time>:<SHA-256 of ref and
 * source>` — for a `messaging_referral` item or a message carrying a `referral`; `null` without one
 * or without a sender.
 */
function referralRule({
  referral,
  item,
  senderId,
}: {
  referral: MetaObject | null;
  item: MetaObject;
  senderId: string | null;
}): MessagingRule | null {
  if (referral === null || senderId === null) return null;
  return {
    eventKind: 'referral',
    prefix: 'referral',
    parts: [
      senderId,
      readIdentifier(item.timestamp) ?? '',
      sha256Hex({ ref: referral.ref ?? null, source: referral.source ?? null }),
    ],
    kindSkipReason: null,
  };
}

/** The 5.A.10 rule a message item (`message` with its `mid`) falls under, or `null` without one. */
function messageRule({
  item,
  senderId,
  accountIds,
}: {
  item: MetaObject;
  senderId: string | null;
  accountIds: InstagramWebhookAccountIds;
}): MessagingRule | null {
  const message = asMetaObject(item.message);
  const messageId = readIdentifier(message?.mid);
  if (message === null || messageId === null) return null;
  // The account's own DM — an echo (`is_echo`, `is_self`, or sent by the account): saved
  // `received` for the owner's quiet time (WH10) unless the receiver finds it is ours (WH9 step 3).
  if (
    message.is_echo === true ||
    message.is_self === true ||
    isAccountItself({ instagramId: senderId, accountIds })
  ) {
    return {
      eventKind: 'echo',
      prefix: 'echo',
      parts: [messageId],
      kindSkipReason: null,
      contactIsRecipient: true,
      echoMessageId: messageId,
    };
  }
  if (message.is_deleted === true) {
    return {
      eventKind: 'unknown',
      prefix: 'deleted',
      parts: [messageId],
      kindSkipReason: 'unsupported',
    };
  }
  const referral = referralRule({
    referral: asMetaObject(message.referral) ?? asMetaObject(item.referral),
    item,
    senderId,
  });
  if (referral !== null) return referral;
  const storyId = readIdentifier(asMetaObject(asMetaObject(message.reply_to)?.story)?.id);
  const attachmentTypes = readAttachmentTypes(message);
  let eventKind: InstagramWebhookEventKind = 'message';
  if (storyId !== null) eventKind = 'story_reply';
  else if (attachmentTypes.includes('story_mention')) eventKind = 'story_mention';
  else if (attachmentTypes.some((type) => SHARED_POST_ATTACHMENT_TYPES.has(type))) {
    eventKind = 'shared_post';
  }
  return { eventKind, prefix: 'message', parts: [messageId], kindSkipReason: null };
}

/**
 * The 5.A.10 rule of a button click: `postback:<mid>`, or without `mid` (a gap of the drop) keyed
 * by sender, time and its payload's hash; a payload starting `starter:` is a starter-question tap
 * (`ice_breaker`, WH8); `null` when it is no postback, or names nobody.
 */
function postbackRule({
  item,
  senderId,
}: {
  item: MetaObject;
  senderId: string | null;
}): MessagingRule | null {
  const postback = asMetaObject(item.postback);
  if (postback === null) return null;
  const eventKind: InstagramWebhookEventKind =
    typeof postback.payload === 'string' &&
    postback.payload.startsWith(STARTER_QUESTION_PAYLOAD_PREFIX)
      ? 'ice_breaker'
      : 'postback';
  const postbackId = readIdentifier(postback.mid);
  if (postbackId !== null) {
    return { eventKind, prefix: 'postback', parts: [postbackId], kindSkipReason: null };
  }
  if (senderId === null) return null;
  return {
    eventKind,
    prefix: 'postback',
    parts: [senderId, readIdentifier(item.timestamp) ?? '', sha256Hex(postback.payload)],
    kindSkipReason: null,
  };
}

/** Whether a `messaging[]` item is a read receipt — never saved (WH8, WH9 step 3). */
function isReadReceipt(item: MetaObject): boolean {
  return asMetaObject(item.read) !== null;
}

/**
 * The rule of a reaction (`received` — it refreshes her window only, 5.A.10) or an edit (skipped
 * `edit`); `null` for anything else.
 */
function reactionOrEditRule(item: MetaObject): MessagingRule | null {
  const reaction = asMetaObject(item.reaction);
  const reactionMessageId = readIdentifier(reaction?.mid);
  if (reaction !== null && reactionMessageId !== null) {
    return {
      eventKind: 'reaction',
      prefix: 'reaction',
      parts: [
        reactionMessageId,
        readIdentifier(reaction.action) ?? '',
        readIdentifier(item.timestamp) ?? '',
      ],
      kindSkipReason: null,
    };
  }
  const messageEdit = asMetaObject(item.message_edit);
  const editedMessageId = readIdentifier(messageEdit?.mid);
  if (messageEdit !== null && editedMessageId !== null) {
    return {
      eventKind: 'edit',
      prefix: 'edit',
      parts: [editedMessageId, readIdentifier(messageEdit.num_edit) ?? ''],
      kindSkipReason: 'edit',
    };
  }
  return null;
}

/**
 * A `messaging[]` item — or the `value` of a `messages` change (D18), whose `payload` is then the
 * whole change item (5.A.10's `messaging[]` rows).
 */
function classifyMessagingItem({
  item,
  payload,
  accountIds,
  entryTime,
}: ItemClassification & {
  item: MetaObject;
  payload: MetaObject;
}): ClassifiedInstagramWebhookEvent | null {
  if (isReadReceipt(item)) return null;
  const senderId = readNestedUserId({ object: item, key: 'sender' });
  const rule: MessagingRule = messageRule({ item, senderId, accountIds }) ??
    postbackRule({ item, senderId }) ??
    referralRule({ referral: asMetaObject(item.referral), item, senderId }) ??
    reactionOrEditRule(item) ?? {
      // Anything else — an opt-in, a story repost, an item missing the id its kind keys on.
      eventKind: 'unknown',
      prefix: 'messaging',
      parts: [sha256Hex(item)],
      kindSkipReason: 'unsupported',
    };
  let contactInstagramUserId = senderId;
  if (rule.contactIsRecipient === true) {
    const recipientId = readNestedUserId({ object: item, key: 'recipient' });
    contactInstagramUserId = isAccountItself({ instagramId: recipientId, accountIds })
      ? null
      : recipientId;
  }
  return {
    eventKind: rule.eventKind,
    eventKey: buildInstagramWebhookEventKey({ prefix: rule.prefix, parts: rule.parts }),
    kindSkipReason: rule.kindSkipReason,
    contactInstagramUserId,
    occurredAt: readInstagramWebhookTime(item.timestamp) ?? readInstagramWebhookTime(entryTime),
    payload,
    ...(rule.echoMessageId === undefined ? {} : { echoMessageId: rule.echoMessageId }),
  };
}

/** The two comment fields of 5.A.10 and the kind each is saved as. */
const COMMENT_CHANGE_KINDS: Readonly<Record<string, InstagramWebhookEventKind>> = {
  comments: 'comment',
  live_comments: 'live_comment',
};

/**
 * A `changes[]` item: a comment or a Live comment, a `messages` change (a DM, D18), or any other
 * field.
 */
function classifyChangeItem({
  item,
  accountIds,
  entryTime,
}: ItemClassification & { item: MetaObject }): ClassifiedInstagramWebhookEvent | null {
  const field = typeof item.field === 'string' ? item.field : '';
  const value = asMetaObject(item.value);
  if (field === 'messages' && value !== null) {
    return classifyMessagingItem({ item: value, payload: item, accountIds, entryTime });
  }
  const occurredAt =
    readInstagramWebhookTime(value?.timestamp) ?? readInstagramWebhookTime(entryTime);
  const commentKind = Object.hasOwn(COMMENT_CHANGE_KINDS, field)
    ? COMMENT_CHANGE_KINDS[field]
    : undefined;
  const commentId = commentKind === undefined ? null : readIdentifier(value?.id);
  if (value !== null && commentKind !== undefined && commentId !== null) {
    const fromId = readNestedUserId({ object: value, key: 'from' });
    // The account's own comment — its public reply comes back as a comment change (WH8, P24).
    const isOwnComment = isAccountItself({ instagramId: fromId, accountIds });
    return {
      eventKind: commentKind,
      eventKey: buildInstagramWebhookEventKey({ prefix: commentKind, parts: [commentId] }),
      kindSkipReason: isOwnComment ? 'own_comment' : null,
      contactInstagramUserId: isOwnComment ? null : fromId,
      occurredAt,
      payload: item,
    };
  }
  return {
    eventKind: 'unknown',
    eventKey: buildInstagramWebhookEventKey({
      prefix: 'change',
      parts: [field, sha256Hex(item.value)],
    }),
    kindSkipReason: 'unsupported',
    contactInstagramUserId: null,
    occurredAt,
    payload: item,
  };
}

/**
 * Gives one delivery item its kind, key, skip reason, contact and time (feat-instagram-dm-sending
 * routes-final § 5.A.10, WH8, WHC5) — the one pure classifier the receiver saves events by; `null`
 * for a read receipt, which is never saved.
 *
 * @remarks
 * - **Algorithm:** a `changes[]` item — `comments` → `comment:<value.id>`, `live_comments` →
 *   `live_comment:<value.id>` (either skipped `own_comment` when `from.id` is the account itself,
 *   P24), `messages` → read as a `messaging[]` item (D18), any other field →
 *   `change:<field>:<SHA-256 of value>`, skipped `unsupported`. A `messaging[]` item — a read
 *   receipt → `null`; a message (`is_echo`, `is_self` or sent by the account → `echo:<mid>`
 *   `received`, carrying `echoMessageId` for the own-message drop; `is_deleted` → `deleted:<mid>`
 *   skipped `unsupported`; a `referral` → `referral`; `reply_to.story.id` → `story_reply`; a
 *   `story_mention` attachment → `story_mention`; a `share` / `ig_post` attachment → `shared_post`;
 *   else `message` — all but the referral keyed `message:<mid>`), a postback (`ice_breaker` when its
 *   payload starts `starter:`, else `postback`; `postback:<mid>`, or without `mid`
 *   `postback:<sender>:<timestamp>:<SHA-256 of payload>`), a `messaging_referral` →
 *   `referral:<sender>:<timestamp>:<SHA-256 of ref and source>`, a reaction →
 *   `reaction:<mid>:<action>:<timestamp>` `received`, `edit:<mid>:<num_edit>` skipped `edit`,
 *   anything else (a story repost, an opt-in) `messaging:<SHA-256 of item>` skipped `unsupported`.
 *   Keys longer than 512 characters become `<prefix>:sha256:<hash of parts>`.
 * - **Failure modes:** none — every object item but a read receipt gets a kind; an item missing the
 *   id its kind keys on falls to `unknown` / `unsupported`.
 * - **Side effects:** none; pure. It never reads or logs message text — only ids, flags and hashes.
 * - **Notes:** keys are unique per account, never across accounts (the key table's key includes the
 *   account) — so two connected accounts messaging each other save an echo on one and a message on
 *   the other. Whether an echo is one of our own sent messages, and the switch-off skip reason, are
 *   the receiver's (WH9, WH3), not the classifier's.
 */
export function classifyInstagramWebhookItem({
  source,
  item,
  accountIds,
  entryTime,
}: InstagramWebhookEntryItem & ItemClassification): ClassifiedInstagramWebhookEvent | null {
  return source === 'changes'
    ? classifyChangeItem({ item, accountIds, entryTime })
    : classifyMessagingItem({ item, payload: item, accountIds, entryTime });
}
