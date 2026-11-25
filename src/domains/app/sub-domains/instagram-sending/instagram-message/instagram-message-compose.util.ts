import type {
  AutomationMessage,
  AutomationSteps,
} from '@/domains/app/sub-domains/automation/automation-steps.dto.js';
import { AUTOMATION_MESSAGE_KEYS } from '@/domains/app/sub-domains/automation/automation-run/automation-run.constants.js';
import type {
  InstagramOutgoingMessage,
  InstagramQuickReply,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type { InstagramMessageRow } from './instagram-message.repository.js';

/** The account's profile address a follow ask's first button opens. */
const INSTAGRAM_PROFILE_URL = 'https://www.instagram.com/';

/** The `{name}` placeholder of a text (plan §5.6, D30). */
const NAME_PLACEHOLDER = /\{name\}/g;

/** What one waiting message is composed from, read at the last moment (plan §24.4). */
export interface InstagramComposeInput {
  message: Pick<
    InstagramMessageRow,
    'message_type' | 'message_number' | 'message_kind' | 'version_number' | 'wording_number'
  >;
  /** The automation's `steps` now (a live edit is sent as edited). */
  steps: AutomationSteps;
  /** Her name, else her username, else `null` (`{name}` is then left out). */
  contactName: string | null;
  /** The account's username (the follow ask's profile button). */
  accountUsername: string | null;
  /** The "sends your next step" postback (`<aut_…>::<run_…>`). */
  buttonPayload: string;
  /** The account's newest post id, for a `post` message of `newest`; `null` when unknown. */
  newestMediaId: string | null;
  /** The English default texts (`AUTOMATION_MESSAGE_KEYS`) — `i18next` in the worker. */
  translate: (key: string) => string;
}

/**
 * A composed message: `skip` (its step is gone from the automation — the reason), or the call's
 * `message` built for the file's Meta id when it has one (`uploadPublicId`), and the plain-text
 * form a refused quick reply falls back to (plan §31 "email / phone as plain text").
 */
export type InstagramComposedMessage =
  | { kind: 'skip'; reason: 'cancelled_by_owner' }
  | {
      kind: 'send';
      uploadPublicId: string | null;
      build: (attachmentId: string | null) => InstagramOutgoingMessage;
      plainTextFallback: InstagramOutgoingMessage | null;
    };

/**
 * Fills `{name}` (plan §5.6 table: her name, else her username; neither — the word is left out,
 * with the space or punctuation around it tidied).
 *
 * @remarks
 * Pure.
 */
export function fillInstagramName({ text, name }: { text: string; name: string | null }): string {
  if (name !== null && name.length > 0) return text.replace(NAME_PLACEHOLDER, name);
  return text
    .replace(NAME_PLACEHOLDER, '')
    .replace(/ +([,!?.])/g, '$1')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** A text message, or a button template when it has buttons. */
function textWithButtons({
  text,
  buttons,
}: {
  text: string;
  buttons: readonly Readonly<Record<string, unknown>>[];
}): InstagramOutgoingMessage {
  if (buttons.length === 0) return { text };
  return {
    attachment: {
      type: 'template',
      payload: { template_type: 'button', text, buttons },
    },
  };
}

/** A fixed message (no file). */
function fixed(message: InstagramOutgoingMessage): InstagramComposedMessage {
  return { kind: 'send', uploadPublicId: null, build: () => message, plainTextFallback: null };
}

/** A question with Instagram's email or phone button, and its plain-text fallback. */
function question({
  text,
  contentType,
}: {
  text: string;
  contentType: InstagramQuickReply['content_type'];
}): InstagramComposedMessage {
  return {
    kind: 'send',
    uploadPublicId: null,
    build: () => ({ text, quick_replies: [{ content_type: contentType }] }),
    plainTextFallback: { text },
  };
}

/** The version a message was saved with (1-based; none → the first). */
function indexOf(number: number | null): number {
  return Math.max((number ?? 1) - 1, 0);
}

/**
 * Builds the Meta `message` of one waiting message from its automation's steps (feat-instagram-dm-
 * sending routes-final § 6.B.10 — the text read at the last moment; plan §5.6, §18.5, §28.1 step
 * 10): the hello (and its nudge) as text with up to 3 buttons, the follow ask, the email and phone
 * questions with Instagram's button (and the plain-text fallback), and each message-list kind — a
 * text with link buttons, quick replies, cards, a file by its upload (image, voice note, PDF; a
 * text's picture is its own `image` row), or a post (`MEDIA_SHARE`). `{name}` is filled in; an
 * empty question wording takes the default text.
 *
 * @remarks
 * Pure. A step or message no longer in the automation → `skip` · `cancelled_by_owner` (a live edit
 * cancels its waiting rows in its commit, AU12 — this is the race after the claim). A broadcast is
 * its own lane's (R45).
 */
export function composeInstagramMessage(input: InstagramComposeInput): InstagramComposedMessage {
  const { message, steps } = input;
  const fill = (text: string) => fillInstagramName({ text, name: input.contactName });
  const nextButton = (title: string) => ({
    type: 'postback',
    title,
    payload: input.buttonPayload,
  });
  switch (message.message_type) {
    case 'opening_message':
    case 'nudge': {
      const version = steps.hello?.versions[indexOf(message.version_number)];
      if (version === undefined) return { kind: 'skip', reason: 'cancelled_by_owner' };
      return fixed(
        textWithButtons({
          text: fill(version.text),
          buttons: version.buttons.map((button) =>
            button.action === 'link'
              ? { type: 'web_url', title: button.title, url: button.url ?? '' }
              : nextButton(button.title),
          ),
        }),
      );
    }
    case 'follow_request': {
      const version = steps.follow?.versions[indexOf(message.version_number)];
      if (version === undefined) return { kind: 'skip', reason: 'cancelled_by_owner' };
      return fixed(
        textWithButtons({
          text: fill(version.text),
          buttons: [
            {
              type: 'web_url',
              title: version.profile_button_title,
              url: `${INSTAGRAM_PROFILE_URL}${input.accountUsername ?? ''}`,
            },
            nextButton(version.following_button_title),
          ],
        }),
      );
    }
    case 'email_question':
    case 'phone_question': {
      const isEmail = message.message_type === 'email_question';
      const wording = (isEmail ? steps.email : steps.phone)?.wordings[
        indexOf(message.wording_number)
      ];
      const text =
        wording !== undefined && wording.trim().length > 0
          ? fill(wording)
          : input.translate(
              isEmail
                ? AUTOMATION_MESSAGE_KEYS.emailQuestion
                : AUTOMATION_MESSAGE_KEYS.phoneQuestion,
            );
      return question({ text, contentType: isEmail ? 'user_email' : 'user_phone_number' });
    }
    case 'invalid_email':
      return question({
        text: input.translate(AUTOMATION_MESSAGE_KEYS.invalidEmail),
        contentType: 'user_email',
      });
    case 'message': {
      const listMessage = steps.messages?.[indexOf(message.message_number)];
      if (listMessage === undefined) return { kind: 'skip', reason: 'cancelled_by_owner' };
      return composeListMessage({ input, listMessage, fill });
    }
    default:
      return { kind: 'skip', reason: 'cancelled_by_owner' };
  }
}

/** One message of the list by its row's kind (plan §18.5; a text's picture is its `image` row). */
function composeListMessage({
  input,
  listMessage,
  fill,
}: {
  input: InstagramComposeInput;
  listMessage: AutomationMessage;
  fill: (text: string) => string;
}): InstagramComposedMessage {
  const kind = input.message.message_kind;
  const file = ({
    type,
    uploadPublicId,
  }: {
    type: 'image' | 'audio' | 'file';
    uploadPublicId: string | undefined;
  }) =>
    uploadPublicId === undefined
      ? ({ kind: 'skip', reason: 'cancelled_by_owner' } as const)
      : ({
          kind: 'send',
          uploadPublicId,
          build: (attachmentId: string | null) => ({
            attachment: { type, payload: { attachment_id: attachmentId ?? '' } },
          }),
          plainTextFallback: null,
        } as const);
  switch (listMessage.kind) {
    case 'text':
      if (kind === 'image')
        return file({ type: 'image', uploadPublicId: listMessage.image_upload_id });
      return fixed(
        textWithButtons({
          text: fill(listMessage.text),
          buttons: (listMessage.buttons ?? []).map((button) => ({
            type: 'web_url',
            title:
              button.title.length > 0
                ? button.title
                : input.translate(AUTOMATION_MESSAGE_KEYS.linkButtonTitle),
            url: button.url,
          })),
        }),
      );
    case 'quick_replies':
      return fixed({
        text: fill(listMessage.text),
        quick_replies: listMessage.replies.map((title) => ({
          content_type: 'text',
          title,
          payload: input.buttonPayload,
        })),
      });
    case 'cards':
      return fixed({
        attachment: {
          type: 'template',
          payload: {
            template_type: 'generic',
            elements: listMessage.cards.map((card) => ({
              title: fill(card.title),
              ...(card.subtitle === undefined ? {} : { subtitle: fill(card.subtitle) }),
              ...(card.url === undefined
                ? {}
                : {
                    buttons: [
                      {
                        type: 'web_url',
                        title:
                          card.button_title ??
                          input.translate(AUTOMATION_MESSAGE_KEYS.linkButtonTitle),
                        url: card.url,
                      },
                    ],
                  }),
            })),
          },
        },
      });
    case 'image':
    case 'audio':
    case 'file':
      return file({ type: listMessage.kind, uploadPublicId: listMessage.upload_id });
    case 'post': {
      const mediaId =
        listMessage.media_id === 'newest' ? input.newestMediaId : listMessage.media_id;
      if (mediaId === null) return { kind: 'skip', reason: 'cancelled_by_owner' };
      return fixed({ attachment: { type: 'MEDIA_SHARE', payload: { id: mediaId } } });
    }
    default:
      return { kind: 'skip', reason: 'cancelled_by_owner' };
  }
}
