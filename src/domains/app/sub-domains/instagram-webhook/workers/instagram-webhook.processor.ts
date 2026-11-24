import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { withSavepoint } from '@/infrastructure/database/transaction.js';
import { toProviderOutageError } from '@/infrastructure/queue/worker-runtime/provider-outage-pause.util.js';
import { runOrganizationScopedWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { CircuitBreakerOpenError } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  type InstagramMediaGraphItem,
  type InstagramUserProfile,
  readInstagramMediaItem,
  readInstagramUserProfile,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import {
  INSTAGRAM_WEBHOOK_EVENTS_PER_JOB,
  INSTAGRAM_WEBHOOK_EVENT_MAX_PROCESSING_ATTEMPTS,
  INSTAGRAM_WEBHOOK_EVENT_STUCK_AFTER_MINUTES,
} from '@/shared/constants/instagram.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { InstagramWebhookProcessingAccount } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import type { InstagramMediaService } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.service.js';
import type { InstagramMediaRow } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.repository.js';
import type { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import type { ContactRow } from '@/domains/app/sub-domains/contact/contact.repository.js';
import type { ContactProfileInput } from '@/domains/app/sub-domains/contact/contact.types.js';
import type { AutomationService } from '@/domains/app/sub-domains/automation/automation.service.js';
import type { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import type {
  AutomationRunEvent,
  AutomationRunHandlingOutcome,
  AutomationRunHandlingResult,
  AutomationRunTriggerInput,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run.types.js';
import type {
  InstagramWebhookEventKind,
  InstagramWebhookEventSkipReason,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.constants.js';
import {
  INSTAGRAM_WEBHOOK_EVENT_ATTEMPTS_EXHAUSTED_ERROR,
  type InstagramWebhookEventClaimKey,
  type InstagramWebhookEventClaimResult,
  type InstagramWebhookEventRow,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import type { InstagramWebhookEventService } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.service.js';
import {
  type InstagramWebhookEventDispatch,
  readInstagramWebhookEventDispatch,
  toContactInteractionKind,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event-dispatch.util.js';
import {
  type InstagramWebhookAccountProcessingEnqueue,
  InstagramWebhookEventPermanentError,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';
import {
  type InstagramWebhookAccountJobData,
  enqueueInstagramWebhookAccountProcessing,
} from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';

/**
 * The services event processing drives (routes-final § 4 header's call table, WH13) — each through
 * its owner's service, never a repository.
 *
 * @remarks
 * - **Algorithm:** structural `Pick`s, so the processor depends only on what it calls: sub-domain
 *   1's processing account read and guarded status change, 4.B's claim and marks, sub-domain 2's
 *   contact upsert and profile save, sub-domain 1's stored posts, sub-domain 3's "next post" link,
 *   the run engine's four entry points and its hook for an event that ended `failed` or `skipped`.
 * - **Failure modes:** none — a type.
 * - **Side effects:** none.
 * - **Notes:** satisfied by the app container's services from the worker composition root
 *   (`createWorkerContainers` → `appDomain`); unit tests pass fakes.
 */
export interface InstagramWebhookProcessingServices {
  instagramAccountService: Pick<
    InstagramAccountService,
    'findWebhookProcessingAccount' | 'markConnectionBroken'
  >;
  instagramWebhookEventService: Pick<
    InstagramWebhookEventService,
    | 'claimNextEvent'
    | 'markEventProcessed'
    | 'markEventSkipped'
    | 'markEventFailed'
    | 'releaseEventClaim'
  >;
  contactService: Pick<ContactService, 'recordContactInteraction' | 'recordContactProfile'>;
  instagramMediaService: Pick<InstagramMediaService, 'findStoredMedia' | 'upsertFromInstagram'>;
  automationService: Pick<AutomationService, 'linkNextPostAutomations'>;
  automationRunService: Pick<
    AutomationRunService,
    | 'startCommentRun'
    | 'handleDirectMessage'
    | 'startStoryReplyRun'
    | 'handleButtonClick'
    | 'failRunsOfFailedEvent'
  >;
}

/**
 * The two Instagram reads processing makes itself (WH13): a new contact's profile and a commented
 * post that is not stored yet. The real client's functions by default; tests pass fakes.
 *
 * @remarks
 * - **Algorithm:** the client's own signatures.
 * - **Failure modes:** `MetaGraphApiError`, an open circuit — classified by the processor.
 * - **Side effects:** none on the type.
 * - **Notes:** every send goes through the run engine's own client (sub-domain 3); these are reads.
 */
export interface InstagramWebhookProcessingInstagramClient {
  readInstagramUserProfile: typeof readInstagramUserProfile;
  readInstagramMediaItem: typeof readInstagramMediaItem;
}

/** The real Instagram client's two reads. */
const INSTAGRAM_CLIENT: InstagramWebhookProcessingInstagramClient = {
  readInstagramUserProfile,
  readInstagramMediaItem,
};

/**
 * What one account's processing job did (WH12), returned as the job's result (Bull Board).
 *
 * @remarks
 * - **Algorithm:** `account_not_found` — the organization holds no account with the job's public id
 *   (nothing claimed); `drained` — nothing waits any more (or the head is held by another run's
 *   lease); `yielded` — {@link INSTAGRAM_WEBHOOK_EVENTS_PER_JOB} events were handled and one
 *   follow-up job was added. The counts are per final status (an exhausted head counts as failed).
 * - **Failure modes:** none — a return shape. A job that throws (a temporary failure before the
 *   event's last attempt, an Instagram outage) returns nothing; BullMQ retries or parks it.
 * - **Side effects:** none.
 * - **Notes:** logged as `app.instagram_webhook.account_job_completed`.
 */
export interface InstagramWebhookAccountJobResult {
  outcome: 'account_not_found' | 'drained' | 'yielded';
  processedEventCount: number;
  skippedEventCount: number;
  failedEventCount: number;
}

/** What handling one claimed event came to, before its mark. */
type HandledEvent =
  | {
      kind: 'processed';
      outcome: AutomationRunHandlingOutcome | 'button_not_ours' | 'not_taken_in_yet';
      runPublicIds: string[];
    }
  | { kind: 'skipped'; skipReason: InstagramWebhookEventSkipReason }
  | { kind: 'failed'; errorMessage: string };

/** One event's final status as this run marked it (`claim_lost`: another run's claim replaced ours). */
type EventOutcome = 'processed' | 'skipped' | 'failed' | 'claim_lost';

/** Everything one claimed event's handling needs. */
interface ClaimedEventContext {
  scope: OrganizationPrincipalDatabaseScope;
  organizationPublicId: string;
  /** `cha_…` — the job's account (WHC4). */
  channelAccountPublicId: string;
  /** `cha_…` (P47, R6) — the run engine's account until intake moves to the inbound seam (ROUTE row R38). */
  instagramAccountPublicId: string;
  services: InstagramWebhookProcessingServices;
  instagramClient: InstagramWebhookProcessingInstagramClient;
  event: InstagramWebhookEventRow;
  claim: InstagramWebhookEventClaimKey;
  /** The claim's attempt is the event's last (WH14): the engine fails a run instead of rethrowing. */
  isLastAttempt: boolean;
  /** The processing job's id — the request id of Instagram calls and the engine (`X-Request-Id`). */
  requestId: string;
}

/** The ids every processing log line carries (WH6) — never the payload, text, email or phone. */
function eventLogFields(context: ClaimedEventContext): Record<string, unknown> {
  return {
    jobId: context.requestId,
    organizationPublicId: context.organizationPublicId,
    channelAccountPublicId: context.channelAccountPublicId,
    instagramWebhookEventPublicId: context.event.public_id,
    eventKind: context.event.event_kind,
    eventKey: context.event.event_key,
    attemptCount: context.event.attempt_count,
    deliveryRequestId: context.event.request_id,
  };
}

/** `instagram_api:<code>/<subcode>` (WH14) — or the error's class when Instagram sent no code. */
function describeMetaGraphApiError(error: MetaGraphApiError): string {
  if (error.instagramErrorCode === null) return `instagram_api:${error.errorClass}`;
  return error.instagramErrorSubcode === null
    ? `instagram_api:${error.instagramErrorCode}`
    : `instagram_api:${error.instagramErrorCode}/${error.instagramErrorSubcode}`;
}

/**
 * An event's `error_message` (WH14): a code and a short reason — never payload text, never the
 * error's own message (a database error can quote a value).
 *
 * @remarks
 * - **Algorithm:** a {@link InstagramWebhookEventPermanentError} → its message (already a code);
 *   an `MetaGraphApiError` → `instagram_api:<code>/<subcode>` (`instagram_api:<class>` without a
 *   code); an open circuit → `instagram_api:circuit_open`; anything else →
 *   `processing_error:<error name>`, plus Postgres's SQLSTATE when it has one.
 * - **Failure modes:** none — pure.
 * - **Side effects:** none.
 * - **Notes:** exported for the unit test; the repository cuts it to the column's 2000 characters.
 */
export function describeInstagramWebhookProcessingError(error: unknown): string {
  if (error instanceof InstagramWebhookEventPermanentError) return error.message;
  if (error instanceof MetaGraphApiError) return describeMetaGraphApiError(error);
  if (error instanceof CircuitBreakerOpenError) return 'instagram_api:circuit_open';
  const name = error instanceof Error ? error.name : typeof error;
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
    ? `processing_error:${name}:${code}`
    : `processing_error:${name}`;
}

/**
 * Whether a failure fails the event at once, without a retry (WH14): a
 * {@link InstagramWebhookEventPermanentError}, or Instagram refusing the request or the token — a
 * retry would only be refused again. Everything else is temporary.
 */
function isPermanentFailure(error: unknown): boolean {
  if (error instanceof InstagramWebhookEventPermanentError) return true;
  return (
    error instanceof MetaGraphApiError &&
    (error.errorClass === 'refused' || error.errorClass === 'auth')
  );
}

/**
 * Why an event is skipped when it is processed (WH12 step 2), or `null` to handle it: the switch
 * off → `automation_disabled`; the account gone or not `connected` → `account_disconnected`
 * (either can change while an event waits). The order is the receiver's (WH10).
 */
function processingSkipReason(
  account: InstagramWebhookProcessingAccount | null,
): InstagramWebhookEventSkipReason | null {
  if (account === null) return 'account_disconnected';
  if (!account.isAutomationEnabled) return 'automation_disabled';
  if (account.connectionStatus !== 'connected') return 'account_disconnected';
  return null;
}

/**
 * Instagram refused the account's token on one of processing's own reads: the guarded status change
 * (IA9 — the reconnect notice follows its commit), then the event fails at once (WH14). Any other
 * failure returns, for the caller to fail open.
 */
async function failOnTokenRefusal({
  context,
  account,
  error,
}: {
  context: ClaimedEventContext;
  account: InstagramWebhookProcessingAccount;
  error: unknown;
}): Promise<void> {
  if (!(error instanceof MetaGraphApiError) || error.errorClass !== 'auth') return;
  await context.services.instagramAccountService.markConnectionBroken({
    scope: context.scope,
    instagramAccount: account.instagramAccount,
    connectionStatus: error.connectionStatus ?? 'error',
    requestId: context.requestId,
  });
  throw new InstagramWebhookEventPermanentError(describeMetaGraphApiError(error), { cause: error });
}

/** The profile fields Instagram answered, as the contact service takes them (absent ones untouched). */
function toContactProfile(profile: InstagramUserProfile): ContactProfileInput {
  return {
    ...(profile.username === null ? {} : { username: profile.username }),
    ...(profile.name === null ? {} : { fullName: profile.name }),
    ...(profile.profilePictureUrl === null ? {} : { profilePictureUrl: profile.profilePictureUrl }),
    ...(profile.followerCount === null ? {} : { followersCount: profile.followerCount }),
  };
}

/**
 * WH13's first step — the contact first: sub-domain 2's upsert in a short unit; for a contact this
 * event created, its Instagram profile (name, username, picture, followers) read outside any unit
 * and saved in another (CQ3). A failed profile read is logged and the contact kept without it
 * (failing open) — unless Instagram refused the token.
 */
async function recordContact({
  context,
  account,
  dispatch,
  occurredAt,
}: {
  context: ClaimedEventContext;
  account: InstagramWebhookProcessingAccount;
  dispatch: InstagramWebhookEventDispatch;
  occurredAt: Date;
}): Promise<ContactRow> {
  const { services, organizationPublicId } = context;
  const { organizationId, instagramAccountId } = account.instagramAccount;
  const recorded = await runOrganizationScopedWorkerJob({
    job: { organizationPublicId },
    processor: (databaseHandle) =>
      services.contactService.recordContactInteraction({
        databaseHandle,
        organizationId,
        instagramAccountId,
        instagramUserId: dispatch.contactInstagramUserId,
        username: dispatch.kind === 'comment' ? dispatch.username : null,
        occurredAt,
        interactionKind: toContactInteractionKind(dispatch.kind),
      }),
  });
  if (!recorded.isNewContact || account.encryptedAccessToken === null) return recorded.contact;

  let profile: InstagramUserProfile;
  try {
    profile = await context.instagramClient.readInstagramUserProfile({
      encryptedAccessToken: account.encryptedAccessToken,
      instagramScopedUserId: dispatch.contactInstagramUserId,
      requestId: context.requestId,
    });
  } catch (error) {
    await failOnTokenRefusal({ context, account, error });
    logger.warn(
      { ...eventLogFields(context), failure: describeInstagramWebhookProcessingError(error) },
      'app.instagram_webhook.contact_profile_read_failed',
    );
    return recorded.contact;
  }
  const saved = await runOrganizationScopedWorkerJob({
    job: { organizationPublicId },
    processor: (databaseHandle) =>
      services.contactService.recordContactProfile({
        databaseHandle,
        organizationId,
        contactId: recorded.contact.id,
        profile: toContactProfile(profile),
        checkedAt: new Date(),
      }),
  });
  return saved ?? recorded.contact;
}

/** A commented post not stored yet, read from Instagram outside any unit; `null` when the read failed. */
async function readCommentedPost({
  context,
  account,
  instagramMediaId,
}: {
  context: ClaimedEventContext;
  account: InstagramWebhookProcessingAccount;
  instagramMediaId: string;
}): Promise<InstagramMediaGraphItem | null> {
  if (account.encryptedAccessToken === null) return null;
  try {
    return await context.instagramClient.readInstagramMediaItem({
      encryptedAccessToken: account.encryptedAccessToken,
      instagramMediaId,
      requestId: context.requestId,
    });
  } catch (error) {
    await failOnTokenRefusal({ context, account, error });
    logger.warn(
      { ...eventLogFields(context), failure: describeInstagramWebhookProcessingError(error) },
      'app.instagram_webhook.post_read_failed',
    );
    return null;
  }
}

/**
 * WH13 for a comment, before it is matched: its post is stored (read from Instagram the first time,
 * IA17), then "next post" linking runs in a savepoint (AU15) — so a just-linked automation counts as
 * linked to this post for this same comment. A failed post read, store or link is logged and the
 * comment is still matched (D18).
 */
async function storePostAndLinkNextPost({
  context,
  account,
  instagramMediaId,
}: {
  context: ClaimedEventContext;
  account: InstagramWebhookProcessingAccount;
  instagramMediaId: string;
}): Promise<void> {
  const { scope, services } = context;
  const { instagramAccount } = account;
  let storedPost: InstagramMediaRow | null = await services.instagramMediaService.findStoredMedia({
    scope,
    instagramAccount,
    instagramMediaId,
  });
  const mediaItem =
    storedPost === null ? await readCommentedPost({ context, account, instagramMediaId }) : null;

  await withAppDatabaseContext({
    scope,
    callback: async () => {
      if (mediaItem !== null) {
        try {
          storedPost =
            (await withSavepoint(() =>
              services.instagramMediaService.upsertFromInstagram({
                scope,
                instagramAccount,
                mediaItem,
              }),
            )) ?? storedPost;
        } catch (error) {
          // An answer the media service cannot map (no id, no readable time) is Instagram's fault —
          // logged, and the comment still matched; a database error stays a temporary failure.
          if (!(error instanceof MetaGraphApiError)) throw error;
          logger.warn(
            { ...eventLogFields(context), failure: describeInstagramWebhookProcessingError(error) },
            'app.instagram_webhook.post_store_failed',
          );
        }
      }
      if (storedPost === null) {
        logger.info(eventLogFields(context), 'app.instagram_webhook.next_post_link_skipped');
        return;
      }
      const publishedAt = storedPost.published_at;
      try {
        await withSavepoint(() =>
          services.automationService.linkNextPostAutomations({
            scope,
            instagramAccountPublicId: context.instagramAccountPublicId,
            instagramMediaId,
            publishedAt,
          }),
        );
      } catch (error) {
        logger.warn(
          { ...eventLogFields(context), failure: describeInstagramWebhookProcessingError(error) },
          'app.instagram_webhook.next_post_link_failed',
        );
      }
    },
  });
}

/** Calls the run engine's entry point for the dispatched kind (4.A.10 "What each event does"). */
async function runEngine({
  context,
  account,
  dispatch,
  trigger,
}: {
  context: ClaimedEventContext;
  account: InstagramWebhookProcessingAccount;
  dispatch: InstagramWebhookEventDispatch;
  trigger: AutomationRunTriggerInput;
}): Promise<AutomationRunHandlingResult | null> {
  const { automationRunService } = context.services;
  switch (dispatch.kind) {
    case 'comment':
      await storePostAndLinkNextPost({
        context,
        account,
        instagramMediaId: dispatch.instagramMediaId,
      });
      return automationRunService.startCommentRun({
        ...trigger,
        instagramCommentId: dispatch.instagramCommentId,
        instagramMediaId: dispatch.instagramMediaId,
        text: dispatch.text,
        commenterUsername: dispatch.username,
      });
    case 'direct_message':
      return automationRunService.handleDirectMessage({
        ...trigger,
        text: dispatch.text,
        quickReplyPayload: dispatch.quickReplyPayload,
        attachmentEmail: dispatch.attachmentEmail,
      });
    case 'story_reply':
      return automationRunService.startStoryReplyRun({
        ...trigger,
        instagramStoryId: dispatch.instagramStoryId,
        text: dispatch.text,
      });
    case 'button_click':
      // A payload this engine never sent names no run: nothing continues (D18).
      if (dispatch.button === null) return null;
      return automationRunService.handleButtonClick({ ...trigger, ...dispatch.button });
  }
}

/**
 * The kinds the receiver saves `received` since its classifier's rev (feat-instagram-dm-sending
 * WHC5, ROUTE row R17) that this launch processor has no way to start yet — a Live comment, a
 * starter-question tap, a link or ad referral, a reaction, the owner's hand-typed echo. It marks
 * them `processed` with nothing done (`not_taken_in_yet`) until intake per kind takes them in
 * (WH11–WH14, ROUTE row R38), so they never fail or hold back the account's other events.
 */
const KINDS_TAKEN_IN_FROM_INTAKE_PER_KIND: ReadonlySet<string> = new Set<InstagramWebhookEventKind>(
  ['live_comment', 'ice_breaker', 'referral', 'reaction', 'echo'],
);

/**
 * WH13 for one event: read its dispatch, record the contact first, then the kind's operation in
 * the run engine — called outside any database context with the job's scope, the event's account
 * and the last-attempt flag (AU5, AU19, AU27).
 */
async function handleEvent({
  context,
  account,
}: {
  context: ClaimedEventContext;
  account: InstagramWebhookProcessingAccount;
}): Promise<HandledEvent> {
  const { event } = context;
  if (KINDS_TAKEN_IN_FROM_INTAKE_PER_KIND.has(event.event_kind)) {
    return { kind: 'processed', outcome: 'not_taken_in_yet', runPublicIds: [] };
  }
  const dispatch = readInstagramWebhookEventDispatch({
    eventKind: event.event_kind,
    payload: event.payload,
    contactInstagramUserId: event.contact_instagram_user_id,
  });
  const occurredAt = event.occurred_at ?? event.created_at;
  const contact = await recordContact({ context, account, dispatch, occurredAt });
  const runEvent: AutomationRunEvent = {
    eventKey: event.event_key,
    occurredAt,
    isLastAttempt: context.isLastAttempt,
    requestId: context.requestId,
  };
  const result = await runEngine({
    context,
    account,
    dispatch,
    trigger: {
      scope: context.scope,
      instagramAccountPublicId: context.instagramAccountPublicId,
      contact,
      event: runEvent,
    },
  });
  if (result === null) return { kind: 'processed', outcome: 'button_not_ours', runPublicIds: [] };
  // A dead token marked the account broken (IA9): the event fails at once (WH14).
  if (result.failedErrorType === 'token') {
    return { kind: 'failed', errorMessage: 'instagram_api:token' };
  }
  // The account stopped being this organization's connected account since the check (AU27).
  if (result.outcome === 'account_unavailable') {
    return { kind: 'skipped', skipReason: 'account_disconnected' };
  }
  return { kind: 'processed', outcome: result.outcome, runPublicIds: result.runPublicIds };
}

/**
 * Ends a claimed event that is not `processed` — `mark` writes its final status — and has the engine
 * fail the runs it left `running` with `errorCode`, in the same unit of work (AU19, D47, D51): an event
 * is never over while its run still runs, whatever fails in between. Not when the claim is lost: the
 * event is another run's by then.
 */
async function endEventWithItsRuns({
  context,
  errorCode,
  mark,
}: {
  context: ClaimedEventContext;
  /** The failed event's code, or the skipped one's reason — never payload text. */
  errorCode: string;
  mark: () => Promise<boolean>;
}): Promise<{ isMarked: boolean; failedRunPublicIds: string[] }> {
  const { services, scope, claim, event } = context;
  return withAppDatabaseContext({
    scope,
    callback: async () => {
      if (!(await mark())) return { isMarked: false, failedRunPublicIds: [] };
      const failedRunPublicIds = await services.automationRunService.failRunsOfFailedEvent({
        scope,
        organizationId: claim.organizationId,
        eventKey: event.event_key,
        errorCode,
      });
      return { isMarked: true, failedRunPublicIds };
    },
  });
}

/** Marks a claimed event `failed` with its code (WH14), its runs with it (D47), and logs it. */
async function markEventFailed({
  context,
  errorMessage,
}: {
  context: ClaimedEventContext;
  errorMessage: string;
}): Promise<EventOutcome> {
  const { services, scope, claim } = context;
  const { isMarked, failedRunPublicIds } = await endEventWithItsRuns({
    context,
    errorCode: errorMessage,
    mark: () =>
      services.instagramWebhookEventService.markEventFailed({ scope, claim, errorMessage }),
  });
  logger.warn(
    { ...eventLogFields(context), errorMessage, isMarked, failedRunPublicIds },
    'app.instagram_webhook.event_failed',
  );
  return isMarked ? 'failed' : 'claim_lost';
}

/**
 * Claims the account's oldest waiting event (WH12 step 1). A head whose attempts ran out is marked
 * `failed` (`processing_attempts_exhausted`) by the claim itself — the runs it left `running` are then
 * failed in the same unit of work, as for every other failed event (AU19, D47).
 */
function claimNextEvent({
  scope,
  services,
  instagramAccount,
  channelAccountId,
}: {
  scope: OrganizationPrincipalDatabaseScope;
  services: InstagramWebhookProcessingServices;
  instagramAccount: InstagramWebhookProcessingAccount['instagramAccount'];
  /** `app.channel_accounts.id` the events are claimed under (R16). */
  channelAccountId: number;
}): Promise<{ claimed: InstagramWebhookEventClaimResult | null; failedRunPublicIds: string[] }> {
  return withAppDatabaseContext({
    scope,
    callback: async () => {
      const claimed = await services.instagramWebhookEventService.claimNextEvent({
        scope,
        channelAccount: { organizationId: instagramAccount.organizationId, channelAccountId },
        maxProcessingAttempts: INSTAGRAM_WEBHOOK_EVENT_MAX_PROCESSING_ATTEMPTS,
        claimLeaseMinutes: INSTAGRAM_WEBHOOK_EVENT_STUCK_AFTER_MINUTES,
      });
      if (claimed?.outcome !== 'exhausted') return { claimed, failedRunPublicIds: [] };
      const failedRunPublicIds = await services.automationRunService.failRunsOfFailedEvent({
        scope,
        organizationId: instagramAccount.organizationId,
        eventKey: claimed.event.event_key,
        errorCode: claimed.event.error_message ?? INSTAGRAM_WEBHOOK_EVENT_ATTEMPTS_EXHAUSTED_ERROR,
      });
      return { claimed, failedRunPublicIds };
    },
  });
}

/**
 * Marks a claimed event `skipped` with its reason (WH12 step 2) and logs it. A run an earlier attempt
 * of it left `running` — the account was switched off or disconnected between two tries — is failed
 * with the reason (D51); on a first try there is none.
 */
async function markEventSkipped({
  context,
  skipReason,
}: {
  context: ClaimedEventContext;
  skipReason: InstagramWebhookEventSkipReason;
}): Promise<EventOutcome> {
  const { services, scope, claim } = context;
  const { isMarked, failedRunPublicIds } = await endEventWithItsRuns({
    context,
    errorCode: skipReason,
    mark: () =>
      services.instagramWebhookEventService.markEventSkipped({ scope, claim, skipReason }),
  });
  logger.info(
    { ...eventLogFields(context), skipReason, isMarked, failedRunPublicIds },
    'app.instagram_webhook.event_skipped',
  );
  return isMarked ? 'skipped' : 'claim_lost';
}

/**
 * A failure of one claimed event (WH14): an Instagram outage gives the claim back without spending
 * its attempt and rethrows, so the provider-pausable worker pauses the queue; a permanent failure,
 * or any failure on the event's last attempt, marks it `failed` and the job moves on; a temporary
 * failure before that ends the lease (the attempt kept) and rethrows, so the job retries with
 * backoff while the account's later events wait (WQ3).
 */
async function settleFailedEvent({
  context,
  error,
}: {
  context: ClaimedEventContext;
  error: unknown;
}): Promise<EventOutcome> {
  const { services, scope, claim } = context;
  const outage = await toProviderOutageError({ error, provider: 'meta' });
  if (outage !== null) {
    await services.instagramWebhookEventService.releaseEventClaim({ scope, claim });
    logger.warn(eventLogFields(context), 'app.instagram_webhook.event_released_for_outage');
    throw outage;
  }
  const errorMessage = describeInstagramWebhookProcessingError(error);
  if (isPermanentFailure(error) || context.isLastAttempt) {
    return markEventFailed({ context, errorMessage });
  }
  await services.instagramWebhookEventService.releaseEventClaim({
    scope,
    claim,
    isAttemptSpent: true,
  });
  logger.warn(
    { ...eventLogFields(context), errorMessage },
    'app.instagram_webhook.event_retry_scheduled',
  );
  throw error;
}

/** WH12 steps 2–4 for one claimed event: the account check, the handling, the mark. */
async function processClaimedEvent(context: ClaimedEventContext): Promise<EventOutcome> {
  const { services, scope, claim } = context;
  try {
    const account = await services.instagramAccountService.findWebhookProcessingAccount({
      scope,
      instagramAccountPublicId: context.channelAccountPublicId,
    });
    const skipReason = processingSkipReason(account);
    if (account === null || skipReason !== null) {
      return markEventSkipped({ context, skipReason: skipReason ?? 'account_disconnected' });
    }
    const handled = await handleEvent({ context, account });
    if (handled.kind === 'skipped') {
      return markEventSkipped({ context, skipReason: handled.skipReason });
    }
    if (handled.kind === 'failed') {
      return markEventFailed({ context, errorMessage: handled.errorMessage });
    }
    const marked = await services.instagramWebhookEventService.markEventProcessed({ scope, claim });
    logger.info(
      {
        ...eventLogFields(context),
        outcome: handled.outcome,
        runPublicIds: handled.runPublicIds,
        isMarked: marked,
      },
      'app.instagram_webhook.event_processed',
    );
    return marked ? 'processed' : 'claim_lost';
  } catch (error) {
    return settleFailedEvent({ context, error });
  }
}

/**
 * One Instagram account's event-processing job (routes-final § 4.A WH12–WH14, worker-changes WC-1):
 * works through the account's waiting events strictly one at a time, oldest stored first.
 *
 * @remarks
 * - **Algorithm:** under the job's organization scope (`PRINCIPAL_SCOPE.JOB` from the job's
 *   `organizationPublicId`, K8, WH3): sub-domain 1's processing account read gives the account's
 *   key (`null` → nothing to do). Then, up to {@link INSTAGRAM_WEBHOOK_EVENTS_PER_JOB} times:
 *   (1) claim the oldest `received` / `queued` event in a short unit — one more attempt, a
 *   {@link INSTAGRAM_WEBHOOK_EVENT_STUCK_AFTER_MINUTES}-minute lease; a head held by another run's
 *   lease, or nothing waiting, ends the job; a head that already used
 *   {@link INSTAGRAM_WEBHOOK_EVENT_MAX_PROCESSING_ATTEMPTS} attempts is `failed`
 *   (`processing_attempts_exhausted`) by the claim instead, its runs with it; (2) read the account again — the switch
 *   off → `skipped` `automation_disabled`, not `connected` → `skipped` `account_disconnected`;
 *   (3) the contact first (sub-domain 2; a new contact's profile read, CQ3), then the kind — a
 *   comment stores its post and runs "next post" linking in a savepoint before `startCommentRun`
 *   (D18, D26); a DM (or a `messages` change) `handleDirectMessage`; a story reply
 *   `startStoryReplyRun`; a button click `handleButtonClick` with `parseAutomationButtonPayload`'s
 *   ids — every call outside any database context with the job's scope and `isLastAttempt` (the
 *   claim's attempt is the last); (4) mark it `processed` while the claim holds. After the last
 *   event of the batch the job adds one follow-up job, so a busy account yields its slot.
 * - **Failure modes:** an Instagram outage (open circuit) gives the claim back with its attempt and
 *   rethrows — the provider-pausable worker pauses the queue and parks the job; a permanent
 *   failure (an unreadable payload, a refused request or token — the account then marked broken,
 *   IA9 — or the engine's `failedErrorType: 'token'`) marks the event `failed` at once; any failure
 *   on the event's last attempt marks it `failed` with its code; any other failure ends the lease
 *   (the attempt kept) and rethrows, so the job retries with backoff (5 attempts, from 5 s) while
 *   the account's later events wait (WQ3). Every `failed` mark, and every `skipped` one, also fails the
 *   runs the event left `running` (the engine's `failRunsOfFailedEvent`, AU19, D51), in the mark's own
 *   unit: when that unit fails, neither is kept, the job throws and the event is taken up again. A
 *   failed follow-up add is logged — the stuck-event pick-up adds the job again.
 * - **Side effects:** event status, attempts and lease (through 4.B's service); the contact, the
 *   stored post, "next post" links, runs, run events, comment logs and Instagram sends (through
 *   sub-domains 1–3); Instagram reads (profile, post); at most one follow-up job.
 * - **Notes:** one job per account at a time (the queue's deduplication), so two runs never work
 *   one account; the claim's lease is the backstop. Every operation is safe to repeat for the same
 *   event (D16) — the engine resumes from its last saved step. Logs carry ids, kinds, keys,
 *   statuses and counts only, never the payload or any text (WH6). A skipped event is never
 *   processed later, even when the switch is turned back on.
 */
export async function processInstagramWebhookAccountJob({
  jobData,
  services,
  jobId,
  instagramClient = INSTAGRAM_CLIENT,
  enqueueFollowUp = enqueueInstagramWebhookAccountProcessing,
}: {
  jobData: Pick<InstagramWebhookAccountJobData, 'organizationPublicId' | 'channelAccountPublicId'>;
  services: InstagramWebhookProcessingServices;
  /** The job's id — the request id of Instagram calls and log lines. */
  jobId: string;
  instagramClient?: InstagramWebhookProcessingInstagramClient | undefined;
  enqueueFollowUp?: InstagramWebhookAccountProcessingEnqueue | undefined;
}): Promise<InstagramWebhookAccountJobResult> {
  const { organizationPublicId, channelAccountPublicId } = jobData;
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
  const result: InstagramWebhookAccountJobResult = {
    outcome: 'drained',
    processedEventCount: 0,
    skippedEventCount: 0,
    failedEventCount: 0,
  };
  const logFields = { jobId, organizationPublicId, channelAccountPublicId };

  const account = await services.instagramAccountService.findWebhookProcessingAccount({
    scope,
    instagramAccountPublicId: channelAccountPublicId,
  });
  if (account === null) {
    logger.warn(logFields, 'app.instagram_webhook.account_not_found');
    return { ...result, outcome: 'account_not_found' };
  }

  for (let handledCount = 0; handledCount < INSTAGRAM_WEBHOOK_EVENTS_PER_JOB; handledCount += 1) {
    const { claimed, failedRunPublicIds } = await claimNextEvent({
      scope,
      services,
      instagramAccount: account.instagramAccount,
      channelAccountId: account.channelAccountId,
    });
    if (claimed === null) {
      logger.info({ ...logFields, ...result }, 'app.instagram_webhook.account_job_completed');
      return result;
    }
    if (claimed.outcome === 'exhausted') {
      result.failedEventCount += 1;
      logger.warn(
        {
          ...logFields,
          instagramWebhookEventPublicId: claimed.event.public_id,
          eventKind: claimed.event.event_kind,
          eventKey: claimed.event.event_key,
          attemptCount: claimed.event.attempt_count,
          failedRunPublicIds,
        },
        'app.instagram_webhook.event_attempts_exhausted',
      );
      continue;
    }
    const { event } = claimed;
    const outcome = await processClaimedEvent({
      scope,
      organizationPublicId,
      channelAccountPublicId,
      instagramAccountPublicId: account.instagramAccountPublicId,
      services,
      instagramClient,
      event,
      claim: {
        organizationId: account.instagramAccount.organizationId,
        channelAccountId: account.channelAccountId,
        eventId: event.id,
        claimedAttemptCount: event.attempt_count,
      },
      isLastAttempt: event.attempt_count >= INSTAGRAM_WEBHOOK_EVENT_MAX_PROCESSING_ATTEMPTS,
      requestId: jobId,
    });
    if (outcome === 'processed') result.processedEventCount += 1;
    else if (outcome === 'skipped') result.skippedEventCount += 1;
    else if (outcome === 'failed') result.failedEventCount += 1;
  }

  // WH12: the batch is done — yield the slot, and let one follow-up job go on with the account.
  result.outcome = 'yielded';
  try {
    await enqueueFollowUp({ organizationPublicId, channelAccountPublicId, requestId: jobId });
  } catch (error) {
    logger.warn(
      { ...logFields, failure: describeInstagramWebhookProcessingError(error) },
      'app.instagram_webhook.follow_up_enqueue_failed',
    );
  }
  logger.info({ ...logFields, ...result }, 'app.instagram_webhook.account_job_completed');
  return result;
}
