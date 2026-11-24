import {
  type AutomationButtonPayload,
  parseAutomationButtonPayload,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run-message.util.js';
import {
  CONTACT_INTERACTION_KIND,
  type ContactInteractionKind,
} from '@/domains/app/sub-domains/contact/contact.constants.js';
import type { InstagramWebhookEventKind } from './instagram-webhook-event/instagram-webhook-event.constants.js';
import { readInstagramWebhookUserId } from './instagram-webhook-event-classifier.util.js';
import { InstagramWebhookEventPermanentError } from './instagram-webhook.types.js';

/** A JSON object as Meta sent it. */
type MetaObject = Record<string, unknown>;

/**
 * What processing hands sub-domains 2 and 3 for one stored event (4.A.10 "What each event does"),
 * read from its payload: the person on the other side and the kind's own fields.
 *
 * @remarks
 * - `comment` — `startCommentRun` after the post is stored and "next post" linking ran (WH13);
 * - `direct_message` — a DM or a `messages` change (D18), `handleDirectMessage`: the typed text,
 *   the quick reply's payload (the email or phone Instagram's own quick reply sends) and an
 *   attachment's email;
 * - `story_reply` — `startStoryReplyRun` with the story's id;
 * - `button_click` — `handleButtonClick` with the payload's two public ids, or `button: null` for a
 *   payload this engine never sent (nothing runs; the click is handled).
 *
 * Personal data (text, usernames, emails) is passed on, never logged (WH6).
 */
export type InstagramWebhookEventDispatch =
  | {
      kind: 'comment';
      contactInstagramUserId: string;
      /** `from.username`, when Meta sent it. */
      username: string | null;
      instagramCommentId: string;
      instagramMediaId: string;
      text: string | null;
    }
  | {
      kind: 'direct_message';
      contactInstagramUserId: string;
      text: string | null;
      quickReplyPayload: string | null;
      attachmentEmail: string | null;
    }
  | {
      kind: 'story_reply';
      contactInstagramUserId: string;
      instagramStoryId: string;
      text: string | null;
    }
  | {
      kind: 'button_click';
      contactInstagramUserId: string;
      button: AutomationButtonPayload | null;
    };

/** The stored event fields the dispatch is read from (`app.instagram_webhook_events` columns). */
export interface InstagramWebhookStoredEvent {
  /** `event_kind` — one of `InstagramWebhookEventKind`. */
  eventKind: string;
  /** The event item as received (WH16): a `changes[]` item or a `messaging[]` item. */
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
 * The messaging item of a message, story reply or postback: the payload itself, or the `value` of
 * a `messages` change, which the receiver stores whole (D18, 4.A.10).
 */
function readMessagingItem(payload: MetaObject): MetaObject {
  const changeValue = payload.field === 'messages' ? asMetaObject(payload.value) : null;
  return changeValue ?? payload;
}

/** The first attachment's email (`attachments[].payload.email`, D18), or `null`. */
function readAttachmentEmail(message: MetaObject): string | null {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  for (const attachment of attachments) {
    const email = readText(asMetaObject(asMetaObject(attachment)?.payload)?.email);
    if (email !== null && email.length > 0) return email;
  }
  return null;
}

/** A stored comment: `value.id`, `value.media.id`, `value.text`, `value.from.username`. */
function readComment({
  payload,
  contactInstagramUserId,
}: {
  payload: MetaObject;
  contactInstagramUserId: string;
}): InstagramWebhookEventDispatch {
  const value = asMetaObject(payload.value);
  if (value === null) throw invalidPayload('comment_value_missing');
  return {
    kind: 'comment',
    contactInstagramUserId,
    username: readText(asMetaObject(value.from)?.username),
    instagramCommentId: requireInstagramId({ value: value.id, reason: 'comment_id_missing' }),
    instagramMediaId: requireInstagramId({
      value: asMetaObject(value.media)?.id,
      reason: 'comment_media_missing',
    }),
    text: readText(value.text),
  };
}

/** A stored message or story reply: `message.text`, its quick reply, attachments and story. */
function readMessage({
  eventKind,
  payload,
  contactInstagramUserId,
}: {
  eventKind: 'message' | 'story_reply';
  payload: MetaObject;
  contactInstagramUserId: string;
}): InstagramWebhookEventDispatch {
  const message = asMetaObject(readMessagingItem(payload).message);
  if (message === null) throw invalidPayload('message_missing');
  const text = readText(message.text);
  if (eventKind === 'story_reply') {
    const story = asMetaObject(asMetaObject(message.reply_to)?.story);
    return {
      kind: 'story_reply',
      contactInstagramUserId,
      instagramStoryId: requireInstagramId({ value: story?.id, reason: 'story_id_missing' }),
      text,
    };
  }
  return {
    kind: 'direct_message',
    contactInstagramUserId,
    text,
    quickReplyPayload: readText(asMetaObject(message.quick_reply)?.payload),
    attachmentEmail: readAttachmentEmail(message),
  };
}

/** A stored button click: `postback.payload` split as `<aut_…>::<run_…>`, or `null` when not ours. */
function readButtonClick({
  payload,
  contactInstagramUserId,
}: {
  payload: MetaObject;
  contactInstagramUserId: string;
}): InstagramWebhookEventDispatch {
  const postback = asMetaObject(readMessagingItem(payload).postback);
  if (postback === null) throw invalidPayload('postback_missing');
  const buttonPayload = readText(postback.payload);
  return {
    kind: 'button_click',
    contactInstagramUserId,
    button: buttonPayload === null ? null : parseAutomationButtonPayload(buttonPayload),
  };
}

/**
 * Reads one stored event into what its handling calls (routes-final § 4.A.10, WH13): the contact
 * and the kind's fields for the run engine's entry point.
 *
 * @remarks
 * - **Algorithm:** the sender is the stored `contact_instagram_user_id` (the classifier's, WH9). A
 *   `comment` reads the change's `value` (its id, post, text and the commenter's username); a
 *   `message` (and, until ROUTE row R38, a `story_mention` or `shared_post` as a DM) or a
 *   `story_reply` reads the messaging item (a `messages` change's `value`, D18) — the
 *   text, the quick reply's payload, the first attachment's email, the replied story's id; a
 *   `postback` splits its payload with `parseAutomationButtonPayload`.
 * - **Failure modes:** throws {@link InstagramWebhookEventPermanentError}
 *   (`event_payload_invalid:<reason>`) for an event no retry can handle: no sender, a comment
 *   without its digits-only id or post, a message without `message`, a story reply without its
 *   story id, a postback without `postback`, or a kind the processor does not dispatch (it sets the
 *   kinds intake takes in from ROUTE row R38 aside before calling this).
 * - **Side effects:** none; pure. Never logs — the payload holds personal data (WH6).
 * - **Notes:** an Instagram id must be digits, as the run and comment-log columns require.
 */
export function readInstagramWebhookEventDispatch({
  eventKind,
  payload,
  contactInstagramUserId,
}: InstagramWebhookStoredEvent): InstagramWebhookEventDispatch {
  const sender = requireInstagramId({ value: contactInstagramUserId, reason: 'contact_missing' });
  const item = asMetaObject(payload);
  if (item === null) throw invalidPayload('payload_not_object');
  const kind = eventKind as InstagramWebhookEventKind;
  switch (kind) {
    case 'comment':
      return readComment({ payload: item, contactInstagramUserId: sender });
    case 'message':
    case 'story_mention':
    case 'shared_post':
      // A story mention and a shared post are DMs to the launch's engine until intake per kind
      // (ROUTE row R38) gives them their own way to start (WH27).
      return readMessage({ eventKind: 'message', payload: item, contactInstagramUserId: sender });
    case 'story_reply':
      return readMessage({ eventKind: kind, payload: item, contactInstagramUserId: sender });
    case 'postback':
      return readButtonClick({ payload: item, contactInstagramUserId: sender });
    default:
      throw invalidPayload(`unhandled_kind:${kind}`);
  }
}

/**
 * The contact interaction one dispatched event records (sub-domain 2, CT10): a comment moves only
 * the last message time; a DM, a story reply and a button click also open the messaging window
 * (`last_direct_message_received_at`).
 */
export function toContactInteractionKind(
  kind: InstagramWebhookEventDispatch['kind'],
): ContactInteractionKind {
  switch (kind) {
    case 'comment':
      return CONTACT_INTERACTION_KIND.COMMENT;
    case 'direct_message':
      return CONTACT_INTERACTION_KIND.DIRECT_MESSAGE;
    case 'story_reply':
      return CONTACT_INTERACTION_KIND.STORY_REPLY;
    case 'button_click':
      return CONTACT_INTERACTION_KIND.BUTTON_CLICK;
  }
}
