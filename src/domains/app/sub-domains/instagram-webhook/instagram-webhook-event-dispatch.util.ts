import { parseBroadcastButtonPayload } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient-button-payload.util.js';
import type { ChannelInboundEventKind } from '@/domains/app/app.channel-ports.js';
import {
  type AutomationButtonPayload,
  parseAutomationButtonPayload,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run-button-payload.util.js';
import type { InstagramWebhookEventKind } from './instagram-webhook-event/instagram-webhook-event.constants.js';
import { readInstagramWebhookUserId } from './instagram-webhook-event-classifier.util.js';
import { InstagramWebhookEventPermanentError } from './instagram-webhook.types.js';

/** A JSON object as Meta sent it. */
type MetaObject = Record<string, unknown>;

/**
 * Instagram's saved kind → the normalized inbound kind (feat-instagram-dm-sending § 5 WH27, WHC17):
 * what intake calls contacts and the run engine with. `edit` and `unknown` never cross (`null`) —
 * they are saved `skipped` and never taken in.
 */
export const INSTAGRAM_INBOUND_EVENT_KIND_OF = {
  comment: 'comment',
  live_comment: 'live_comment',
  message: 'message',
  postback: 'postback',
  ice_breaker: 'starter_question',
  story_reply: 'story_reply',
  story_mention: 'story_mention',
  shared_post: 'shared_post',
  referral: 'referral',
  reaction: 'reaction',
  echo: 'owner_message',
  edit: null,
  unknown: null,
} as const satisfies Record<InstagramWebhookEventKind, ChannelInboundEventKind | null>;

/**
 * The normalized inbound kind of a saved event kind (WH27), or `null` for a kind that never crosses
 * the seam (`edit`, `unknown`, or a value outside the list).
 */
export function toInboundEventKind(eventKind: string): ChannelInboundEventKind | null {
  return Object.hasOwn(INSTAGRAM_INBOUND_EVENT_KIND_OF, eventKind)
    ? INSTAGRAM_INBOUND_EVENT_KIND_OF[eventKind as InstagramWebhookEventKind]
    : null;
}

/** The fields a comment or a Live comment hands the run engine (WH27). */
interface CommentDispatchFields {
  contactInstagramUserId: string;
  /** `from.username`, when Meta sent it. */
  username: string | null;
  instagramCommentId: string;
  instagramMediaId: string;
  /** `parent_id` — the comment this one replies under (D64); `null` for a top-level comment. */
  parentCommentId: string | null;
  /** `media.ad_id` — the ad the commented post belongs to (an ad comment); `null` otherwise. */
  adId: string | null;
  text: string | null;
}

/**
 * What intake hands contacts and the run engine for one saved event (routes-final § 5.A.10 "What
 * each kind group does", WH27): the normalized kind (`inboundKind`), the person on the other side
 * and the item's own ids — never Instagram's body.
 *
 * @remarks
 * - `comment`, `live_comment` — `startCommentRun` (an ad's comment carries its `adId`);
 * - `message`, `story_reply`, `story_mention`, `shared_post` — `handleDirectMessage` with the text,
 *   the quick reply's payload, an attachment's email, the story or the shared post;
 * - `postback` — `handleButtonClick` with our payload's two public ids (`button: null` for a
 *   payload this engine never sent) and the message the button was on (`messagePublicId`, when
 *   the payload names it); a broadcast message's button (`<brc_…>::<igm_…>`, § 7.A.10) carries
 *   `broadcastPublicId` and its message instead;
 * - `starter_question` — `handleButtonClick` with the question's text;
 * - `referral` — `handleButtonClick` with the link's `ref` code or the ad's id;
 * - `reaction` — her window only;
 * - `owner_message` — the owner's hand-typed echo to her (the quiet time, WH10).
 *
 * Personal data (text, usernames, emails) is passed on, never logged (WH6).
 */
export type InstagramWebhookEventDispatch =
  | ({ inboundKind: 'comment' | 'live_comment' } & CommentDispatchFields)
  | {
      inboundKind: 'message' | 'story_reply' | 'story_mention' | 'shared_post';
      contactInstagramUserId: string;
      text: string | null;
      quickReplyPayload: string | null;
      attachmentEmail: string | null;
      /** The story replied to or mentioned in, when Meta named it. */
      storyId: string | null;
      /** The shared post, when Meta named it. */
      sharedMediaId: string | null;
    }
  | {
      inboundKind: 'postback';
      contactInstagramUserId: string;
      button: AutomationButtonPayload | null;
      /** `igm_…` — the message whose button was tapped (the payload's third part), when present. */
      messagePublicId: string | null;
      /** `brc_…` — a broadcast message's button (§ 7.A.10); `null` for any other payload. */
      broadcastPublicId: string | null;
    }
  | {
      inboundKind: 'starter_question';
      contactInstagramUserId: string;
      starterQuestion: string | null;
    }
  | {
      inboundKind: 'referral';
      contactInstagramUserId: string;
      refCode: string | null;
      adId: string | null;
    }
  | { inboundKind: 'reaction'; contactInstagramUserId: string }
  | { inboundKind: 'owner_message'; contactInstagramUserId: string; instagramMessageId: string };

/** The stored event fields the dispatch is read from (`app.instagram_webhook_events` columns). */
export interface InstagramWebhookStoredEvent {
  /** `event_kind` — one of `InstagramWebhookEventKind`. */
  eventKind: string;
  /** The event item as received: a `changes[]` item or a `messaging[]` item. */
  payload: unknown;
  /** The sender the receiver stored (`contact_instagram_user_id`), digits; `null` when none. */
  contactInstagramUserId: string | null;
}

/** `value` as a JSON object, or `null`. */
function asMetaObject(value: unknown): MetaObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as MetaObject)
    : null;
}

/** A string as Meta sent it, or `null` for anything else. */
function readText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A non-empty string or number id as text, or `null`. */
function readOptionalId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The permanent failure of a payload missing what its kind needs — a code, never its text. */
function invalidPayload(reason: string): InstagramWebhookEventPermanentError {
  return new InstagramWebhookEventPermanentError(`event_payload_invalid:${reason}`);
}

/** The digits-only Instagram id at `value`, or the permanent failure named `reason`. */
function requireInstagramId({ value, reason }: { value: unknown; reason: string }): string {
  const instagramId = readInstagramWebhookUserId(value);
  if (instagramId === null) throw invalidPayload(reason);
  return instagramId;
}

/**
 * The messaging item: the payload itself, or the `value` of a `messages` change, which the
 * receiver stores whole (D18, 5.A.10).
 */
function readMessagingItem(payload: MetaObject): MetaObject {
  const changeValue = payload.field === 'messages' ? asMetaObject(payload.value) : null;
  return changeValue ?? payload;
}

/** A message's attachments as objects. */
function readAttachments(message: MetaObject): MetaObject[] {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  return attachments.flatMap((attachment) => {
    const object = asMetaObject(attachment);
    return object === null ? [] : [object];
  });
}

/** The first attachment's email (`attachments[].payload.email`, D18), or `null`. */
function readAttachmentEmail(message: MetaObject): string | null {
  for (const attachment of readAttachments(message)) {
    const email = readText(asMetaObject(attachment.payload)?.email);
    if (email !== null && email.length > 0) return email;
  }
  return null;
}

/** The id in the first attachment of one of `types` (`payload.id`, `payload.ig_post_media_id`). */
function readAttachmentId({
  message,
  types,
}: {
  message: MetaObject;
  types: readonly string[];
}): string | null {
  for (const attachment of readAttachments(message)) {
    if (typeof attachment.type !== 'string' || !types.includes(attachment.type)) continue;
    const payload = asMetaObject(attachment.payload);
    return readOptionalId(payload?.ig_post_media_id) ?? readOptionalId(payload?.id);
  }
  return null;
}

/** A stored comment or Live comment: its id, post, parent, ad, text and the commenter's username. */
function readComment({
  inboundKind,
  payload,
  contactInstagramUserId,
}: {
  inboundKind: 'comment' | 'live_comment';
  payload: MetaObject;
  contactInstagramUserId: string;
}): InstagramWebhookEventDispatch {
  const value = asMetaObject(payload.value);
  if (value === null) throw invalidPayload('comment_value_missing');
  const media = asMetaObject(value.media);
  return {
    inboundKind,
    contactInstagramUserId,
    username: readText(asMetaObject(value.from)?.username),
    instagramCommentId: requireInstagramId({ value: value.id, reason: 'comment_id_missing' }),
    instagramMediaId: requireInstagramId({ value: media?.id, reason: 'comment_media_missing' }),
    parentCommentId: readInstagramWebhookUserId(value.parent_id),
    adId: readOptionalId(media?.ad_id),
    text: readText(value.text),
  };
}

/** A stored message, story reply or mention, or shared post. */
function readMessage({
  inboundKind,
  payload,
  contactInstagramUserId,
}: {
  inboundKind: 'message' | 'story_reply' | 'story_mention' | 'shared_post';
  payload: MetaObject;
  contactInstagramUserId: string;
}): InstagramWebhookEventDispatch {
  const message = asMetaObject(readMessagingItem(payload).message);
  if (message === null) throw invalidPayload('message_missing');
  let storyId: string | null = null;
  if (inboundKind === 'story_reply') {
    storyId = requireInstagramId({
      value: asMetaObject(asMetaObject(message.reply_to)?.story)?.id,
      reason: 'story_id_missing',
    });
  } else if (inboundKind === 'story_mention') {
    storyId = readAttachmentId({ message, types: ['story_mention'] });
  }
  return {
    inboundKind,
    contactInstagramUserId,
    text: readText(message.text),
    quickReplyPayload: readText(asMetaObject(message.quick_reply)?.payload),
    attachmentEmail: readAttachmentEmail(message),
    storyId,
    sharedMediaId:
      inboundKind === 'shared_post'
        ? readAttachmentId({ message, types: ['share', 'ig_post'] })
        : null,
  };
}

/** The separator of our button payload's parts (`<aut_…>::<run_…>::<igm_…>`, WH8). */
const BUTTON_PAYLOAD_SEPARATOR = '::';

/** The prefix of a starter-question payload (`starter:<question>`, WH8). */
const STARTER_QUESTION_PAYLOAD_PREFIX = 'starter:';

/**
 * A stored postback: our payload `<aut_…>::<run_…>` (optionally `::<igm_…>`, WH8) split into the
 * run engine's two ids and the message's, or a broadcast message's `<brc_…>::<igm_…>` (§ 7.A.10)
 * into the broadcast's and the message's — `button: null` when the payload is not an automation's.
 */
function readPostback({
  payload,
  contactInstagramUserId,
}: {
  payload: MetaObject;
  contactInstagramUserId: string;
}): InstagramWebhookEventDispatch {
  const postback = asMetaObject(readMessagingItem(payload).postback);
  if (postback === null) throw invalidPayload('postback_missing');
  const buttonPayload = readText(postback.payload);
  if (buttonPayload === null) {
    return {
      inboundKind: 'postback',
      contactInstagramUserId,
      button: null,
      messagePublicId: null,
      broadcastPublicId: null,
    };
  }
  const broadcastButton = parseBroadcastButtonPayload(buttonPayload);
  if (broadcastButton !== null) {
    return {
      inboundKind: 'postback',
      contactInstagramUserId,
      button: null,
      messagePublicId: broadcastButton.messagePublicId,
      broadcastPublicId: broadcastButton.broadcastPublicId,
    };
  }
  const parts = buttonPayload.split(BUTTON_PAYLOAD_SEPARATOR);
  const messagePublicId = parts.length === 3 ? (parts[2] ?? null) : null;
  const button = parseAutomationButtonPayload(
    parts.length === 3 ? parts.slice(0, 2).join(BUTTON_PAYLOAD_SEPARATOR) : buttonPayload,
  );
  return {
    inboundKind: 'postback',
    contactInstagramUserId,
    button,
    messagePublicId: button === null ? null : messagePublicId,
    broadcastPublicId: null,
  };
}

/**
 * A stored starter-question tap: the question's text — the postback's `title`, else the payload
 * after `starter:` — which the run engine matches against each automation's starter questions.
 */
function readStarterQuestion({
  payload,
  contactInstagramUserId,
}: {
  payload: MetaObject;
  contactInstagramUserId: string;
}): InstagramWebhookEventDispatch {
  const postback = asMetaObject(readMessagingItem(payload).postback);
  if (postback === null) throw invalidPayload('postback_missing');
  const buttonPayload = readText(postback.payload);
  const fromPayload = buttonPayload?.startsWith(STARTER_QUESTION_PAYLOAD_PREFIX)
    ? buttonPayload.slice(STARTER_QUESTION_PAYLOAD_PREFIX.length)
    : null;
  const title = readText(postback.title);
  return {
    inboundKind: 'starter_question',
    contactInstagramUserId,
    starterQuestion: title !== null && title.trim() !== '' ? title : fromPayload,
  };
}

/** A stored referral (`messaging_referral`, or one carried by her message): the ref or the ad. */
function readReferral({
  payload,
  contactInstagramUserId,
}: {
  payload: MetaObject;
  contactInstagramUserId: string;
}): InstagramWebhookEventDispatch {
  const item = readMessagingItem(payload);
  const message = asMetaObject(item.message);
  const referral = asMetaObject(item.referral) ?? asMetaObject(message?.referral);
  if (referral === null) throw invalidPayload('referral_missing');
  const adId = readOptionalId(referral.ad_id);
  return {
    inboundKind: 'referral',
    contactInstagramUserId,
    refCode: adId === null ? readText(referral.ref) : null,
    adId,
  };
}

/** A stored echo: her side is the recipient; its `mid` is the message the owner typed. */
function readOwnerMessage({
  payload,
  contactInstagramUserId,
}: {
  payload: MetaObject;
  contactInstagramUserId: string;
}): InstagramWebhookEventDispatch {
  const message = asMetaObject(readMessagingItem(payload).message);
  const instagramMessageId = readOptionalId(message?.mid);
  if (instagramMessageId === null) throw invalidPayload('echo_mid_missing');
  return { inboundKind: 'owner_message', contactInstagramUserId, instagramMessageId };
}

/**
 * Reads one saved event into what intake calls (routes-final § 5.A.10, WH27): the normalized kind,
 * the person and the item's ids.
 *
 * @remarks
 * - **Algorithm:** the person is the stored `contact_instagram_user_id` (the classifier's — an
 *   echo's recipient); the kind maps through {@link INSTAGRAM_INBOUND_EVENT_KIND_OF}; each reader
 *   takes the change's `value` (comments) or the messaging item (a `messages` change's `value`,
 *   D18) and reads only ids, the text, the quick reply's payload and an attachment's email.
 * - **Failure modes:** throws {@link InstagramWebhookEventPermanentError}
 *   (`event_payload_invalid:<reason>`) for an event no retry can handle: no person, a comment
 *   without its digits-only id or post, a message without `message`, a story reply without its
 *   story id, a postback without `postback`, a referral without `referral`, an echo without `mid`,
 *   or a kind that never crosses the seam (`edit`, `unknown`).
 * - **Side effects:** none; pure. Never logs — the payload holds personal data (WH6).
 * - **Notes:** an Instagram id must be digits, as the run and comment-log columns require.
 */
export function readInstagramWebhookEventDispatch({
  eventKind,
  payload,
  contactInstagramUserId,
}: InstagramWebhookStoredEvent): InstagramWebhookEventDispatch {
  const person = requireInstagramId({ value: contactInstagramUserId, reason: 'contact_missing' });
  const item = asMetaObject(payload);
  if (item === null) throw invalidPayload('payload_not_object');
  const inboundKind = toInboundEventKind(eventKind);
  const read = { payload: item, contactInstagramUserId: person };
  switch (inboundKind) {
    case 'comment':
    case 'live_comment':
      return readComment({ ...read, inboundKind });
    case 'message':
    case 'story_reply':
    case 'story_mention':
    case 'shared_post':
      return readMessage({ ...read, inboundKind });
    case 'postback':
      return readPostback(read);
    case 'starter_question':
      return readStarterQuestion(read);
    case 'referral':
      return readReferral(read);
    case 'reaction':
      return { inboundKind: 'reaction', contactInstagramUserId: person };
    case 'owner_message':
      return readOwnerMessage(read);
    default:
      throw invalidPayload(`unhandled_kind:${eventKind}`);
  }
}
