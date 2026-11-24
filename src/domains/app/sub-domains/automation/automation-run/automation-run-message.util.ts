import type {
  InstagramMessageRecipient,
  InstagramOutgoingMessage,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';
import type {
  AutomationFinalMessage,
  AutomationFollowRequestMessage,
  AutomationOpeningMessage,
  AutomationTextMessage,
} from '@/domains/app/sub-domains/automation/automation.types.js';
import {
  AUTOMATION_BUTTON_PAYLOAD_SEPARATOR,
  type AutomationRunSendingMessageKind,
  INSTAGRAM_MESSAGING_WINDOW_MILLISECONDS,
  INSTAGRAM_PRIVATE_REPLY_WINDOW_MILLISECONDS,
  INSTAGRAM_PROFILE_BASE_URL,
} from './automation-run.constants.js';

/** The two public ids a button carries back (schema-routes § 5.6). */
export interface AutomationButtonPayload {
  /** `aut_…`. */
  automationPublicId: string;
  /** `run_…`. */
  runPublicId: string;
}

/** `<aut_…>::<run_…>` — the postback payload of the opening button and the "I'm following" button. */
export function buildAutomationButtonPayload({
  automationPublicId,
  runPublicId,
}: AutomationButtonPayload): string {
  return `${automationPublicId}${AUTOMATION_BUTTON_PAYLOAD_SEPARATOR}${runPublicId}`;
}

/**
 * Reads a postback payload as `<aut_…>::<run_…>` (sub-domain 4 calls it before
 * `handleButtonClick`); `null` when it is anything else — a payload this engine never sent.
 */
export function parseAutomationButtonPayload(payload: string): AutomationButtonPayload | null {
  const parts = payload.split(AUTOMATION_BUTTON_PAYLOAD_SEPARATOR);
  if (parts.length !== 2) return null;
  const [automationPublicId, runPublicId] = parts as [string, string];
  if (!publicIdPatternFor('automation').test(automationPublicId)) return null;
  if (!publicIdPatternFor('automationRun').test(runPublicId)) return null;
  return { automationPublicId, runPublicId };
}

/** The account's Instagram page, the follow request's profile button (schema-routes § 10). */
export function buildInstagramProfileUrl(username: string): string {
  return `${INSTAGRAM_PROFILE_BASE_URL}${encodeURIComponent(username)}`;
}

/**
 * Who a run's DM goes to (3.B.10, Instagram's rules): a normal DM when the person sent the account
 * a DM, a story reply, a quick reply or a button click within the messaging window
 * (`last_direct_message_received_at`, 24 hours); otherwise, on a comment, a private reply to it —
 * one per comment, within 7 days of it; otherwise `null`: it cannot be sent and the step fails.
 *
 * @remarks
 * A comment does not open the messaging window, which is why the contact keeps a time that counts
 * only DMs and clicks (contacts CT10). A second private reply to one comment is refused by
 * Instagram — the comment flows wait for the person between two DMs (AQ2), so it does not happen.
 */
export function resolveAutomationMessageRecipient({
  instagramUserId,
  lastDirectMessageReceivedAt,
  privateReply,
  now,
}: {
  /** The contact's Instagram user id. */
  instagramUserId: string;
  lastDirectMessageReceivedAt: Date | null;
  /** The comment a private reply may answer, and when it was made; `null` off a comment. */
  privateReply: { instagramCommentId: string; commentedAt: Date } | null;
  now: Date;
}): InstagramMessageRecipient | null {
  if (
    lastDirectMessageReceivedAt !== null &&
    now.getTime() - lastDirectMessageReceivedAt.getTime() < INSTAGRAM_MESSAGING_WINDOW_MILLISECONDS
  ) {
    return { id: instagramUserId };
  }
  if (
    privateReply !== null &&
    now.getTime() - privateReply.commentedAt.getTime() < INSTAGRAM_PRIVATE_REPLY_WINDOW_MILLISECONDS
  ) {
    return { comment_id: privateReply.instagramCommentId };
  }
  return null;
}

/** The English default texts a message falls back to (AU22), already translated. */
export interface AutomationDefaultTexts {
  emailQuestion: string;
  phoneQuestion: string;
  invalidEmail: string;
  buttonTemplateText: string;
  linkButtonTitle: string;
}

/** The saved messages of an automation a composed DM reads (schema-routes § 10). */
export interface AutomationMessageSource {
  opening_message: AutomationOpeningMessage | null;
  follow_request_message: AutomationFollowRequestMessage | null;
  email_request_message: AutomationTextMessage | null;
  phone_request_message: AutomationTextMessage | null;
  final_message: AutomationFinalMessage;
}

/**
 * One DM as it is sent (AU18, AU22): `message`, and — for the email and phone questions, which
 * carry Instagram's own quick reply — `plainTextFallback`, the same text without it, sent under
 * the same claim when Instagram refuses the quick reply (code 100, subcode 2534015).
 */
export interface ComposedAutomationMessage {
  message: InstagramOutgoingMessage;
  plainTextFallback: InstagramOutgoingMessage | null;
}

/** A saved text, or the fallback when it is blank. */
function textOr({
  value,
  fallback,
}: {
  value: string | null | undefined;
  fallback: string;
}): string {
  return value !== undefined && value !== null && value.trim() !== '' ? value : fallback;
}

/** Instagram's button template: a text and up to three buttons. */
function buttonTemplate({
  text,
  buttons,
}: {
  text: string;
  buttons: readonly Readonly<Record<string, string>>[];
}): InstagramOutgoingMessage {
  return {
    attachment: {
      type: 'template',
      payload: { template_type: 'button', text, buttons: [...buttons] },
    },
  };
}

/** A question with Instagram's own email or phone quick reply, and its plain-text fallback. */
function questionWithQuickReply({
  text,
  contentType,
}: {
  text: string;
  contentType: 'user_email' | 'user_phone_number';
}): ComposedAutomationMessage {
  return {
    message: { text, quick_replies: [{ content_type: contentType }] },
    plainTextFallback: { text },
  };
}

/**
 * Composes one DM of a run in Instagram's wire shape (AU18, schema-routes § 10, AU22):
 * - `opening_message` — its text; with a button, a button template whose postback carries
 *   `buttonPayload`;
 * - `follow_request` — a button template: the "I'm following" postback and the profile link;
 * - `email_question` / `phone_question` — the saved question or the default, with the `user_email`
 *   / `user_phone_number` quick reply;
 * - `invalid_email` — the wrong-email text with the `user_email` quick reply (the question again);
 * - `final_message` — its text, with up to three link buttons as a button template.
 *
 * @remarks
 * Failure modes: throws for `public_reply` (a comment reply, not a DM) and for a step whose saved
 * message is missing — the flow rules (AU8) and the table's checks keep that from happening.
 */
export function composeAutomationMessage({
  messageKind,
  automation,
  buttonPayload,
  profileUrl,
  defaults,
}: {
  messageKind: AutomationRunSendingMessageKind;
  automation: AutomationMessageSource;
  /** `<aut_…>::<run_…>` of the run. */
  buttonPayload: string;
  /** The account's profile page, for the follow request. */
  profileUrl: string;
  defaults: AutomationDefaultTexts;
}): ComposedAutomationMessage {
  switch (messageKind) {
    case 'opening_message': {
      const opening = automation.opening_message;
      if (opening === null) throw new Error('composeAutomationMessage: no opening message');
      const text = textOr({ value: opening.text, fallback: defaults.buttonTemplateText });
      if (opening.button_title === null) return { message: { text }, plainTextFallback: null };
      return {
        message: buttonTemplate({
          text,
          buttons: [{ type: 'postback', title: opening.button_title, payload: buttonPayload }],
        }),
        plainTextFallback: null,
      };
    }
    case 'follow_request': {
      const follow = automation.follow_request_message;
      if (follow === null) throw new Error('composeAutomationMessage: no follow request message');
      return {
        message: buttonTemplate({
          text: textOr({ value: follow.text, fallback: defaults.buttonTemplateText }),
          buttons: [
            { type: 'postback', title: follow.following_button_title, payload: buttonPayload },
            { type: 'web_url', title: follow.profile_button_title, url: profileUrl },
          ],
        }),
        plainTextFallback: null,
      };
    }
    case 'email_question':
      return questionWithQuickReply({
        text: textOr({
          value: automation.email_request_message?.text,
          fallback: defaults.emailQuestion,
        }),
        contentType: 'user_email',
      });
    case 'invalid_email':
      return questionWithQuickReply({ text: defaults.invalidEmail, contentType: 'user_email' });
    case 'phone_question':
      return questionWithQuickReply({
        text: textOr({
          value: automation.phone_request_message?.text,
          fallback: defaults.phoneQuestion,
        }),
        contentType: 'user_phone_number',
      });
    case 'final_message': {
      const final = automation.final_message;
      const text = textOr({ value: final.text, fallback: defaults.buttonTemplateText });
      if (final.links.length === 0) return { message: { text }, plainTextFallback: null };
      return {
        message: buttonTemplate({
          text,
          buttons: final.links.map((link) => ({
            type: 'web_url',
            title: textOr({ value: link.title, fallback: defaults.linkButtonTitle }),
            url: link.url,
          })),
        }),
        plainTextFallback: null,
      };
    }
    case 'public_reply':
      throw new Error('composeAutomationMessage: a public reply is not a DM');
  }
}
