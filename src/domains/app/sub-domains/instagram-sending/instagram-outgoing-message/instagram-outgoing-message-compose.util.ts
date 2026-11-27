import type {
  AutomationMessage,
  AutomationSteps,
} from '@/domains/app/sub-domains/automation/automation-steps.dto.js';
import { AUTOMATION_MESSAGE_KEYS } from '@/domains/app/sub-domains/automation/automation-run/automation-run.constants.js';
import {
  AUTOMATION_BUTTON_TEXT_MAX_LENGTH,
  AUTOMATION_CARD_TEXT_MAX_LENGTH,
  AUTOMATION_MESSAGE_TEXT_MAX_BYTES,
} from '@/domains/app/sub-domains/automation/automation.constants.js';
import type { InstagramOutgoingMessage } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type { InstagramOutgoingMessageRow } from './instagram-outgoing-message.repository.js';

/** The account's profile address a follow ask's first button opens. */
const INSTAGRAM_PROFILE_URL = 'https://www.instagram.com/';

/** The `{name}` placeholder of a text (plan §5.6, D30). */
const NAME_PLACEHOLDER = /\{name\}/g;

/** What one waiting message is composed from, read at the last moment (plan §24.4). */
export interface InstagramComposeInput {
  message: Pick<
    InstagramOutgoingMessageRow,
    'message_type' | 'message_number' | 'message_kind' | 'version_number' | 'wording_number'
  >;
  /** The automation's `steps` now (a live edit is sent as edited); a broadcast's `{ messages }`. */
  steps: AutomationSteps;
  /** Her name, else her username, else `null` (`{name}` is then left out). */
  contactName: string | null;
  /** The account's username (the follow ask's profile button). */
  accountUsername: string | null;
  /** The "sends your next step" postback (`<aut_…>::<run_…>`; a broadcast's `<brc_…>::<igm_…>`). */
  buttonPayload: string;
  /** The account's newest post id, for a `post` message of `newest`; `null` when unknown. */
  newestMediaId: string | null;
  /** The English default texts (`AUTOMATION_MESSAGE_KEYS`) — `i18next` in the worker. */
  translate: (key: string) => string;
}

/**
 * A composed message: `skip` (its step is gone from the automation — the reason), or the call's
 * `message` built for the file's Meta id when it has one (`uploadPublicId`).
 */
export type InstagramComposedMessage =
  | { kind: 'skip'; reason: 'cancelled_by_owner' }
  | {
      kind: 'send';
      uploadPublicId: string | null;
      build: (attachmentId: string | null) => InstagramOutgoingMessage;
    };

/**
 * The most a filled text may hold where Meta refuses more: UTF-8 bytes (a plain text, 1,000) and
 * UTF-16 characters (a button template's text, 640; a card's title or line, 80).
 */
export interface InstagramTextLimit {
  maxBytes?: number;
  maxLength?: number;
}

/** Fills `{name}` in one text, cut to `limit` (a plain text's by default). */
type FillText = (input: { text: string; limit?: InstagramTextLimit }) => string;

/** A plain text's limit (`AUTOMATION_MESSAGE_TEXT_MAX_BYTES`). */
const PLAIN_TEXT_LIMIT: InstagramTextLimit = { maxBytes: AUTOMATION_MESSAGE_TEXT_MAX_BYTES };

/** A button template's text limit — both, as a hello without buttons is checked by length too. */
const BUTTON_TEXT_LIMIT: InstagramTextLimit = {
  maxBytes: AUTOMATION_MESSAGE_TEXT_MAX_BYTES,
  maxLength: AUTOMATION_BUTTON_TEXT_MAX_LENGTH,
};

/** A card's title or line limit. */
const CARD_TEXT_LIMIT: InstagramTextLimit = { maxLength: AUTOMATION_CARD_TEXT_MAX_LENGTH };

/** User-perceived characters, so a cut never splits an emoji or a letter and its marks. */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The longest start of `name` — whole graphemes — of at most `maxBytes` and `maxLength`. */
function cutName({
  name,
  maxBytes,
  maxLength,
}: {
  name: string;
  maxBytes: number;
  maxLength: number;
}): string {
  let cut = '';
  for (const { segment } of GRAPHEME_SEGMENTER.segment(name)) {
    const next = cut + segment;
    if (Buffer.byteLength(next, 'utf8') > maxBytes || next.length > maxLength) break;
    cut = next;
  }
  return cut.trimEnd();
}

/**
 * Fills `{name}` (plan §5.6 table: her name, else her username; neither — the word is left out,
 * with the space or punctuation around it tidied), cut to fit `limit`.
 *
 * @remarks
 * Pure. The go-live check counts `{name}` as its 6 written characters, so a saved text at the limit
 * plus a long name would be refused by Meta (`bad_text` — 5 in a row stop the automation): with a
 * `limit`, each `{name}` gets an equal share of the room left and her name is cut to it at a
 * grapheme boundary; a name with no whole grapheme in the room is left out as for no name.
 */
export function fillInstagramName({
  text,
  name,
  limit = {},
}: {
  text: string;
  name: string | null;
  limit?: InstagramTextLimit;
}): string {
  const placeholderCount = text.match(NAME_PLACEHOLDER)?.length ?? 0;
  let filledName = name ?? '';
  if (placeholderCount > 0 && filledName.length > 0) {
    const withoutName = text.replace(NAME_PLACEHOLDER, '');
    const share = ({ max, used }: { max: number | undefined; used: number }) =>
      max === undefined ? Number.POSITIVE_INFINITY : Math.floor((max - used) / placeholderCount);
    filledName = cutName({
      name: filledName,
      maxBytes: share({ max: limit.maxBytes, used: Buffer.byteLength(withoutName, 'utf8') }),
      maxLength: share({ max: limit.maxLength, used: withoutName.length }),
    });
  }
  if (filledName.length > 0) return text.replace(NAME_PLACEHOLDER, filledName);
  return text
    .replace(NAME_PLACEHOLDER, '')
    .replace(/ {2,}/g, ' ')
    .replace(/ ([,!?.])/g, '$1')
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
  return { kind: 'send', uploadPublicId: null, build: () => message };
}

/**
 * The email or phone question as plain text (fix-meta-unified-login F2): Meta disabled the
 * `user_email` / `user_phone_number` quick replies for Instagram messaging on 5 Oct 2026, so the
 * question goes without a button and her typed answer is read as before.
 */
function question(text: string): InstagramComposedMessage {
  return fixed({ text });
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
 * text's picture is its own `image` row), or a post (`MEDIA_SHARE`). `{name}` is filled in, her
 * name cut to keep each text within Meta's limit for it; an empty question wording takes the
 * default text.
 *
 * @remarks
 * Pure. A step or message no longer in the automation → `skip` · `cancelled_by_owner` (a live edit
 * cancels its waiting rows in its commit, AU12 — this is the race after the claim). A broadcast
 * message (R45) is composed as a list message from the broadcast's `messages`.
 */
export function composeInstagramMessage(input: InstagramComposeInput): InstagramComposedMessage {
  const { message, steps } = input;
  const fill: FillText = ({ text, limit = PLAIN_TEXT_LIMIT }) =>
    fillInstagramName({ text, name: input.contactName, limit });
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
          text: fill({ text: version.text, limit: BUTTON_TEXT_LIMIT }),
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
          text: fill({ text: version.text, limit: BUTTON_TEXT_LIMIT }),
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
      return composeQuestionMessage({
        input,
        isEmail: message.message_type === 'email_question',
        fill,
      });
    }
    case 'invalid_email':
      return question(input.translate(AUTOMATION_MESSAGE_KEYS.invalidEmail));
    case 'message':
    case 'broadcast': {
      // A broadcast's messages are the automation's message-list shape (BC8): the caller passes
      // them as `steps.messages` (ROUTE row R45).
      const listMessage = steps.messages?.[indexOf(message.message_number)];
      if (listMessage === undefined) return { kind: 'skip', reason: 'cancelled_by_owner' };
      return composeListMessage({ input, listMessage, fill });
    }
    default:
      return { kind: 'skip', reason: 'cancelled_by_owner' };
  }
}

/** The email or phone question: its wording (filled), else the default text for that question. */
function composeQuestionMessage({
  input,
  isEmail,
  fill,
}: {
  input: InstagramComposeInput;
  isEmail: boolean;
  fill: FillText;
}): InstagramComposedMessage {
  const step = isEmail ? input.steps.email : input.steps.phone;
  const wording = step?.wordings[indexOf(input.message.wording_number)];
  if (wording !== undefined && wording.trim().length > 0) {
    return question(fill({ text: wording }));
  }
  const defaultKey = isEmail
    ? AUTOMATION_MESSAGE_KEYS.emailQuestion
    : AUTOMATION_MESSAGE_KEYS.phoneQuestion;
  return question(input.translate(defaultKey));
}

/** One message of the list by its row's kind (plan §18.5; a text's picture is its `image` row). */
function composeListMessage({
  input,
  listMessage,
  fill,
}: {
  input: InstagramComposeInput;
  listMessage: AutomationMessage;
  fill: FillText;
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
        } as const);
  switch (listMessage.kind) {
    case 'text':
      if (kind === 'image')
        return file({ type: 'image', uploadPublicId: listMessage.image_upload_id });
      return fixed(
        textWithButtons({
          text: fill({
            text: listMessage.text,
            limit: (listMessage.buttons ?? []).length > 0 ? BUTTON_TEXT_LIMIT : PLAIN_TEXT_LIMIT,
          }),
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
        text: fill({ text: listMessage.text }),
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
              title: fill({ text: card.title, limit: CARD_TEXT_LIMIT }),
              ...(card.subtitle === undefined
                ? {}
                : { subtitle: fill({ text: card.subtitle, limit: CARD_TEXT_LIMIT }) }),
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
