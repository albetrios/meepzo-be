/**
 * Meta's subscription check as route 16 hands it to the service (WH7): the three `hub.*` values.
 */
export interface InstagramWebhookSubscriptionCheck {
  /** `hub.mode` — must be `subscribe`. */
  mode: string;
  /** `hub.verify_token` — compared in constant time with `META_WEBHOOK_VERIFY_TOKEN`. */
  verifyToken: string;
  /** `hub.challenge` — echoed as received when the check passes. */
  challenge: string;
}

/** A signed delivery as route 17 hands it to the service (WH10). */
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
  /** Events already stored by an earlier delivery of the same key (WH10). */
  duplicateEventCount: number;
}

/** What {@link InstagramWebhookAccountProcessingEnqueue} is asked to start: one account's processing. */
export interface InstagramWebhookAccountProcessingRequest {
  /** The account's organization — the processing job's `organizationPublicId` (K8). */
  organizationPublicId: string;
  /** `cha_…` — processing works through this account's waiting events, oldest first (WH5). */
  instagramAccountPublicId: string;
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

/**
 * A stored event no retry can handle (WH14, WHC10) — its payload lacks what its kind needs (a
 * comment without its post, a message without its sender), or Instagram refused the account's
 * token while processing read a post or a profile. Processing marks the event `failed` at once with
 * the error's message as `error_message`, and the account's next event runs.
 *
 * @remarks
 * Like `StripeWebhookPermanentError`. The message is a code and a short reason
 * (`event_payload_invalid:comment_media_missing`, `instagram_api:190/463`) — never payload text,
 * since it is stored and listed (route 18).
 */
export class InstagramWebhookEventPermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InstagramWebhookEventPermanentError';
  }
}
