import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';

/**
 * Meta's subscription check as route 60 hands it to the service (WH4): the three `hub.*` values.
 */
export interface InstagramWebhookSubscriptionCheck {
  /** `hub.mode` — must be `subscribe`. */
  mode: string;
  /** `hub.verify_token` — compared in constant time with `META_WEBHOOK_VERIFY_TOKEN`. */
  verifyToken: string;
  /** `hub.challenge` — echoed as received when the check passes. */
  challenge: string;
}

/** A signed delivery as route 61 hands it to the service (WH9). */
export interface InstagramWebhookDeliveryInput {
  /** The parsed JSON body, or `undefined` when the signed body was not JSON (WH2). */
  body: unknown;
  /** The delivery's request id — stored on each event and carried on every log line. */
  requestId: string;
}

/** What one delivery stored, in counts — for the summary log line and tests (WH6: never the payload). */
export interface InstagramWebhookDeliveryResult {
  /** Why nothing was read: a body that is not a readable delivery, or not about Instagram; else `null`. */
  ignoredBecause: 'unreadable_body' | 'unsupported_object' | null;
  /** Entries in the delivery. */
  entryCount: number;
  /** Entries dropped for want of a digits-only Instagram user id (WH9). */
  droppedEntryCount: number;
  /** Entries for an account no organization holds, or a revoked one — not stored (WH4). */
  unknownAccountEntryCount: number;
  /** Entries that could not be stored — the delivery then fails, so Meta delivers it again (D53). */
  failedEntryCount: number;
  /** Events this delivery inserted (a repeat delivery inserts none). */
  storedEventCount: number;
  /** Events already stored by an earlier delivery of the same key, or over 8 days old (WH9). */
  duplicateEventCount: number;
  /** Read receipts and echoes of our own sent messages — never saved (WH9 step 3). */
  droppedEventCount: number;
}

/** What {@link InstagramWebhookAccountProcessingEnqueue} is asked to start: one account's processing. */
export interface InstagramWebhookAccountProcessingRequest {
  /** The account's organization — the processing job's `organizationPublicId` (K8). */
  organizationPublicId: string;
  /** `cha_…` — the channel account whose waiting events the job works through (WH5, WHC4). */
  channelAccountPublicId: string;
  /** The delivery's request id, for log correlation. */
  requestId: string;
}

/**
 * The receiver's processing hook: adds the account's processing job once the receiver's unit of
 * work committed (WH5, WH10); it throws when the job could not be added.
 *
 * @remarks
 * The app container wires the event-processing queue's enqueue here
 * (`enqueueInstagramWebhookAccountProcessing`). After a successful add the receiver turns the
 * just-stored `received` rows `queued`; a failed add is logged and left to the stuck-event pick-up
 * (WH15) — it never fails Meta's answer (queue rules §4.5).
 */
export type InstagramWebhookAccountProcessingEnqueue = (
  request: InstagramWebhookAccountProcessingRequest,
) => Promise<void>;

/** The account an own-message lookup reads: its organization and channel account (internal ids). */
export interface InstagramOwnSentMessageAccount {
  /** `tenancy.organizations.id`. */
  organizationId: number;
  /** `app.channel_accounts.id`. */
  channelAccountId: number;
}

/**
 * The own-message lookup the receiver drops our own echoes by (feat-instagram-dm-sending § 5.A WH9
 * step 3, WHQ1 / P62): which of these Instagram message ids (`mid`) are messages we sent from this
 * account. Runs inside the receiver's store unit (the caller's organization scope).
 *
 * @remarks
 * Sub-domain 6's `InstagramMessageService.findOwnSentMessageIds` over `app.instagram_messages`
 * implements it at ROUTE row R19 (the message table lands there) and the app container wires it
 * into `InstagramWebhookService`. Until then {@link NO_OWN_SENT_MESSAGES} answers "none", so every
 * echo is saved `received` — the case WH10 already covers for an echo that arrives before its
 * send's result is saved (intake matches it to the message within 10 minutes).
 */
export type InstagramOwnSentMessageLookup = (input: {
  scope: OrganizationPrincipalDatabaseScope;
  channelAccount: InstagramOwnSentMessageAccount;
  messageIds: readonly string[];
}) => Promise<ReadonlySet<string>>;

/**
 * The {@link InstagramOwnSentMessageLookup} until ROUTE row R19 builds the message table: no
 * message is known as ours.
 */
export const NO_OWN_SENT_MESSAGES: InstagramOwnSentMessageLookup = async () => new Set<string>();

/**
 * A stored event no retry can handle (WH14, WHC10) — its payload lacks what its kind needs (a
 * comment without its post, a message without its sender), or Instagram refused the account's
 * token while processing read a post or a profile. Processing marks the event `failed` at once with
 * the error's message as `error_message`, and the account's next event runs.
 *
 * @remarks
 * Like `StripeWebhookPermanentError`. The message is a code and a short reason
 * (`event_payload_invalid:comment_media_missing`, `instagram_api:190/463`) — never payload text,
 * since it is stored and listed (route 62).
 */
export class InstagramWebhookEventPermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InstagramWebhookEventPermanentError';
  }
}
