import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import type { InstagramMessageRecipient } from '@/infrastructure/social/instagram.client.js';
import { InstagramApiError } from '@/infrastructure/social/instagram-error.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { InstagramAutomationAccountAccess } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import type { ContactRow } from '@/domains/app/sub-domains/contact/contact.repository.js';
import type { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import type { ContactErasureStepInput } from '@/domains/app/sub-domains/contact/contact.types.js';
import {
  AutomationRepository,
  type AutomationRow,
  createWorkerAutomationRepository,
} from '@/domains/app/sub-domains/automation/automation.repository.js';
import type { AutomationOpenRunCancelInput } from '@/domains/app/sub-domains/automation/automation.types.js';
import {
  AUTOMATION_RUN_ERROR_MESSAGE_MAX_LENGTH,
  AUTOMATION_RUN_QUEUED_AUTOMATIONS_MAX_COUNT,
  AUTOMATION_RUN_WAITING_FOR,
  type AutomationCommentLogErrorType,
  type AutomationCommentLogIgnoredReason,
  type AutomationCommentLogStep,
  type AutomationRunSendingMessageKind,
  type AutomationRunStatus,
  type AutomationRunStep,
  type AutomationRunWaitingFor,
} from './automation-run.constants.js';
import {
  AutomationRunRepository,
  type AutomationRunRow,
  createWorkerAutomationRunRepository,
} from './automation-run.repository.js';
import {
  AutomationRunEventRepository,
  createWorkerAutomationRunEventRepository,
} from './automation-run-event.repository.js';
import {
  type AutomationCommentLogChanges,
  AutomationCommentLogRepository,
  type AutomationCommentLogInsertValues,
  type AutomationCommentLogRow,
  createWorkerAutomationCommentLogRepository,
} from './automation-comment-log.repository.js';
import {
  chooseCommentAutomation,
  chooseDirectMessageAutomation,
  chooseStoryReplyAutomation,
  decideExistingRunConflict,
  pickEmailAnswer,
  pickPhoneAnswer,
} from './automation-run-matching.util.js';
import {
  type ComposedAutomationMessage,
  resolveAutomationMessageRecipient,
} from './automation-run-message.util.js';
import {
  planAutomationRunStep,
  planWaitedStepNowOff,
  toCommentLogStep,
} from './automation-run-step.util.js';
import { assertQueuedAutomations, readQueuedAutomations } from './automation-run.validator.js';
import type {
  AutomationRunMessageService,
  AutomationSendResult,
} from './automation-run-message.service.js';
import type { AutomationPublicReplySafetyService } from './automation-public-reply-safety.service.js';
import type {
  AutomationButtonClickInput,
  AutomationCommentRunInput,
  AutomationDirectMessageInput,
  AutomationFailedEventInput,
  AutomationQueuedTrigger,
  AutomationRunEvent,
  AutomationRunHandlingResult,
  AutomationRunStepPlan,
  AutomationRunTriggerInput,
  AutomationStoryReplyRunInput,
  AutomationWaitedStepOff,
} from './automation-run.types.js';

/** The most actions one advance takes before it stops — a backstop against a planning loop. */
const ADVANCE_MAX_ACTIONS = 24;

/** The organization a unit of work writes in, and its scope for the log lines. */
interface AutomationRunOrganization {
  scope: OrganizationPrincipalDatabaseScope;
  organizationId: number;
}

/** One engine call: the event's account as read once, and the event (AU5, AU27). */
interface AutomationRunCall extends AutomationRunOrganization {
  access: InstagramAutomationAccountAccess;
  instagramAccountId: number;
  contactId: number;
  instagramUserId: string;
  event: AutomationRunEvent;
}

/** The repositories of one short unit of work, all bound to its handle (AU19). */
interface AutomationRunRepositories {
  databaseHandle: WorkerDatabaseHandle;
  runs: AutomationRunRepository;
  runEvents: AutomationRunEventRepository;
  commentLogs: AutomationCommentLogRepository;
  automations: AutomationRepository;
}

/** One short unit of work of a call, its contact and its open runs' automations locked (AU12, CT8). */
interface AutomationRunUnit extends AutomationRunRepositories {
  /** The call's contact, its row locked until the unit ends — `null` once erased (CT8, CT9). */
  contact: ContactRow | null;
}

/** A locked `waiting` run, its automation as it is now (AU14), and the step it waits for if now off. */
interface WaitingRun {
  run: AutomationRunRow;
  automation: AutomationRow | null;
  /** Where the run goes on to when the step it waits for is now off; `null` while it is still on. */
  stepOff: AutomationWaitedStepOff | null;
}

/** The run state one prepared action works on. */
interface PreparedRunState {
  run: AutomationRunRow;
  automation: AutomationRow;
  commentLog: AutomationCommentLogRow | null;
}

/** What the prepare unit of an advance decided (AU19 step a). */
type PreparedAction =
  | { kind: 'stop' }
  | { kind: 'failed'; errorType: AutomationCommentLogErrorType }
  | (PreparedRunState & { kind: 'public_reply'; text: string })
  | (PreparedRunState & {
      kind: 'send';
      plan: Extract<AutomationRunStepPlan, { action: 'send' }>;
      recipient: InstagramMessageRecipient;
      composed: ComposedAutomationMessage;
    })
  | (PreparedRunState & { kind: 'read_follow' });

/** What a record unit leaves the advance to do next. */
type RecordedAction =
  | { kind: 'continue'; isFollowNotConfirmed?: boolean }
  | { kind: 'stop' }
  | { kind: 'failed'; errorType: AutomationCommentLogErrorType; tokenError?: InstagramApiError }
  | { kind: 'rethrow'; error: unknown };

/** Why a step failed, as the run and its comment log record it. */
interface AutomationRunFailure {
  errorType: AutomationCommentLogErrorType;
  /** A short reason slug (`refused`, `send_outcome_unknown`, `outside_messaging_window`, …). */
  reason: string;
  /** Instagram's error, when it answered. */
  error: unknown;
  /** Leave the send claim set — its outcome is unknown, so it is never sent again (AQ5). */
  isClaimKept: boolean;
}

/** The empty result of an entry point. */
function handlingResult({
  outcome,
  runPublicIds = [],
  failedErrorType = null,
}: {
  outcome: AutomationRunHandlingResult['outcome'];
  runPublicIds?: string[];
  failedErrorType?: AutomationCommentLogErrorType | null;
}): AutomationRunHandlingResult {
  return { outcome, runPublicIds, failedErrorType };
}

/** The run sub-domain's repositories (and the automations') on one unit's handle. */
function bindRepositories(databaseHandle: WorkerDatabaseHandle): AutomationRunRepositories {
  return {
    databaseHandle,
    runs: createWorkerAutomationRunRepository(databaseHandle),
    runEvents: createWorkerAutomationRunEventRepository(databaseHandle),
    commentLogs: createWorkerAutomationCommentLogRepository(databaseHandle),
    automations: createWorkerAutomationRepository(databaseHandle),
  };
}

/** The comment-log step a message belongs to (D19). */
function commentLogStepOfMessage(
  messageKind: AutomationRunSendingMessageKind,
): AutomationCommentLogStep {
  switch (messageKind) {
    case 'public_reply':
      return 'public_reply';
    case 'opening_message':
      return 'opening_dm';
    case 'follow_request':
      return 'follow_check';
    case 'email_question':
    case 'invalid_email':
      return 'email_collect';
    case 'phone_question':
      return 'phone_collect';
    case 'final_message':
      return 'final_dm';
  }
}

/** The run step a comment-log step belongs to — where a failure is recorded. */
function failedCommentLogStep({
  run,
  commentLog,
}: {
  run: AutomationRunRow;
  commentLog: AutomationCommentLogRow | null;
}): AutomationCommentLogStep | null {
  if (run.sending_message_kind !== null) {
    return commentLogStepOfMessage(run.sending_message_kind as AutomationRunSendingMessageKind);
  }
  return toCommentLogStep({
    runStep: run.current_step as AutomationRunStep,
    // A log already at the opening message has no public reply to come: it was never on (D19).
    isPublicReplyPending:
      commentLog?.public_reply_status === 'off' && commentLog.current_step !== 'opening_dm',
  });
}

/** A short, text-free error message: `instagram_api:<code>/<subcode>` or the reason. */
function describeFailure(failure: AutomationRunFailure): string {
  const { error } = failure;
  const message =
    error instanceof InstagramApiError && error.instagramErrorCode !== null
      ? `${failure.errorType}:${error.instagramErrorCode}/${error.instagramErrorSubcode ?? '-'}`
      : `${failure.errorType}:${failure.reason}`;
  return message.slice(0, AUTOMATION_RUN_ERROR_MESSAGE_MAX_LENGTH);
}

/**
 * The comment log's error columns for a failure (schema-routes § 8.12): Instagram's class, codes,
 * type, trace id and HTTP status — never its text, which can name a person or quote a token (D53).
 */
function failureColumns(failure: AutomationRunFailure): AutomationCommentLogChanges {
  const { error } = failure;
  const isInstagramAnswer = error instanceof InstagramApiError;
  return {
    error_type: failure.errorType,
    http_status: isInstagramAnswer ? (error.status ?? null) : null,
    error_code: isInstagramAnswer ? error.instagramErrorCode : null,
    error_subcode: isInstagramAnswer ? error.instagramErrorSubcode : null,
    error_message: describeFailure(failure),
    error_reason: failure.reason,
    fbtrace_id: isInstagramAnswer ? error.fbtraceId : null,
    error_response: isInstagramAnswer
      ? {
          error_class: error.errorClass,
          http_status: error.status ?? null,
          code: error.instagramErrorCode,
          error_subcode: error.instagramErrorSubcode,
          type: error.instagramErrorType,
          fbtrace_id: error.fbtraceId,
        }
      : null,
    error_at: new Date(),
  };
}

/** The columns a comment log has no value for yet — an error already logged is kept (D47). */
function unsetColumns({
  commentLog,
  columns,
}: {
  commentLog: AutomationCommentLogRow | null;
  columns: AutomationCommentLogChanges;
}): AutomationCommentLogChanges {
  if (commentLog === null) return columns;
  return Object.fromEntries(
    Object.entries(columns).filter(
      ([column]) => commentLog[column as keyof AutomationCommentLogRow] === null,
    ),
  );
}

/** The reason slug of a send that did not deliver. */
function failureReasonOf(result: Exclude<AutomationSendResult, { outcome: 'delivered' }>): string {
  if (result.outcome === 'unknown') return 'send_outcome_unknown';
  if (result.error instanceof InstagramApiError) return result.error.errorClass;
  return result.outcome;
}

/** The comment-log status columns of a step whose message went (AU18). */
function deliveredCommentLogChanges({
  messageKind,
  isWaiting,
  now,
}: {
  messageKind: AutomationRunSendingMessageKind;
  isWaiting: boolean;
  now: Date;
}): AutomationCommentLogChanges {
  const status = isWaiting ? 'waiting' : 'sent';
  switch (messageKind) {
    case 'opening_message':
      return { opening_dm_status: status, opening_dm_at: now };
    case 'follow_request':
      return { follow_status: 'waiting', follow_at: now };
    case 'email_question':
      return { email_status: 'waiting' };
    case 'phone_question':
      return { phone_status: 'waiting' };
    case 'final_message':
      return { final_dm_status: 'sent', final_dm_at: now };
    case 'invalid_email':
    case 'public_reply':
      return {};
  }
}

/**
 * The run engine (routes-final § 3.B, AU16–AU26): what starts a run and which automation answers,
 * the steps, every send claimed before and recorded after, reply safety, the queued automations,
 * the three hooks other sub-domains run inside their own transactions — the contact erase's step
 * (AU26), the automation delete's open-run cancel (AU12) and the runs of an event that ended `failed`
 * or was skipped on a retry (AU19, D51) — and the 7-day wait's cancel (AU25).
 *
 * @remarks
 * Algorithm:
 * - **Entry points** (3.B.8 — `startCommentRun`, `handleDirectMessage`, `startStoryReplyRun`,
 *   `handleButtonClick`): sub-domain 4 calls them per event, **outside** any database context,
 *   with its job's organization scope (relayed, never minted here), the event's Instagram account
 *   and the contact it recorded. Each opens its own short units of work (`withAppDatabaseContext`)
 *   and makes every Instagram call between them (AU5, AU19).
 * - **One account** (AU27): the account must be this organization's connected account; only its
 *   automations are matched.
 * - **Choice** (AU16, D26): a comment is answered by one automation — the post-linked ones first,
 *   the oldest match — written with every other match's `comment_already_answered` log in one
 *   unit; a DM is first an answer to a run waiting for an email or a phone; a story reply and a
 *   click follow their own rules. AU17 then decides whether the chosen automation starts a run.
 * - **Steps** (AU18): a pure planner ({@link planAutomationRunStep}) reads the run, the automation
 *   as it is now (AU14) and the contact; each send is claimed (`sending_message_kind`) in a short
 *   unit, sent outside it, and recorded in another (AU19).
 * - **A step turned off while a run waits for it** (AU14, D48): the run no longer takes an answer,
 *   holds a trigger back or asks again, and once the event's own handling is done it goes on from its
 *   next step, the automations queued behind its email with it — inside the messaging window, where a
 *   DM reaches the contact (3.B.10); a comment outside it moves no waiting run on (D50).
 * - **Safe to run twice:** an event whose key is a run's `last_instagram_event_key` resumes that
 *   run instead of being applied again; a comment whose logs exist resumes its chosen run; a claim
 *   still set fails the step (AQ5).
 * - **An erase wins** (CT8, CT9): every unit locks the contact first, as the erase does, and reads it
 *   live before it starts a run, logs a comment or takes a step — an erased person's event writes
 *   and sends nothing.
 * - **One lock order** (AU12, CT8, D47): the contact, then the automation, then its runs — every unit
 *   of the engine and the contact erase lock the automations of the contact's open runs
 *   `FOR KEY SHARE` before they touch a run, and a unit that starts a run locks its automation and
 *   reads it live again first; the delete (route 15) holds the automation `FOR UPDATE` and then
 *   cancels its runs. So whoever holds a run holds its automation too: the delete, once it has the
 *   automation, waits for nobody, and leaves no open run behind. (The other order — the delete taking
 *   the runs first — cannot stop a unit from adding one, and the automation's row is what both
 *   sides need in the end.) The 7-day cancel, which holds many runs, skips those another transaction
 *   holds and so waits for none.
 *
 * Failure modes:
 * - A temporary Instagram error (a throttle, a 5xx other than 502 and 504, an open circuit, a
 *   connection refused) is rethrown after its claim is cleared — sub-domain 4 retries the event —
 *   except on the event's last attempt, when the run fails instead. A permanent refusal, a dead token (the account then
 *   marked broken, IA9) or an unknown outcome fails the run with its error; the call returns.
 * - A database error propagates (a temporary failure for sub-domain 4).
 *
 * Side effects:
 * - Writes `app.automation_runs`, `app.automation_run_events`, `app.automation_comment_logs`, the
 *   automation's counters (AU10, through the automation repository — the same sub-domain) and the
 *   contact through sub-domain 2's service; sends through Instagram. No audit entry — runs are
 *   their own history (AU4).
 *
 * Notes:
 * - Events of one account are processed in order (D15), so two events never move one run at once;
 *   the run row lock and the one-open-run index are the backstop. Log lines carry public ids and
 *   counts only, never message or comment text (K7).
 */
export class AutomationRunService {
  constructor(
    private readonly instagramAccountService: InstagramAccountService,
    private readonly contactService: ContactService,
    private readonly messageService: AutomationRunMessageService,
    private readonly replySafetyService: AutomationPublicReplySafetyService,
  ) {}

  /**
   * A comment on one of the account's posts (3.B.8, AU16, AU17, AU24): one automation answers it —
   * its run started (or its AU17 reason logged), every other match logged
   * `comment_already_answered`.
   *
   * @remarks
   * Algorithm: one unit — the contact erased meanwhile → nothing written (CT9); the comment's logs
   * exist, or it moved a run (AU14) → a retry: resume the runs this event moved (or ask the email
   * question again when it has not gone for this comment yet); else the account's live comment
   * automations, the choice ({@link chooseCommentAutomation}) — deleted or turned off before its lock
   * → ignored, nothing written (AU12) — AU17 for the chosen one (another automation's run waiting for
   * the contact's email → the trigger queued on it and the question asked again, as a private reply
   * to this comment or a DM), a new run and every log of the comment. Then the new run is advanced;
   * last, a run of the contact waiting for a step now off goes on (AU14). Called after sub-domain 4
   * saved the contact and the post and ran `linkNextPostAutomations`. Failure modes and side effects:
   * as the class.
   */
  async startCommentRun(input: AutomationCommentRunInput): Promise<AutomationRunHandlingResult> {
    return this.handleEvent({
      input,
      handle: (call) => this.handleComment({ call, input }),
    });
  }

  /** A comment's own handling ({@link startCommentRun}). */
  private async handleComment({
    call,
    input,
  }: {
    call: AutomationRunCall;
    input: AutomationCommentRunInput;
  }): Promise<AutomationRunHandlingResult> {
    const now = new Date();
    const choice = await this.unit({
      call: call,
      work: async (unit) => {
        if (unit.contact === null) return { kind: 'ignored' as const };
        const retry = await this.findCommentRetry({
          unit,
          call,
          instagramCommentId: input.instagramCommentId,
        });
        if (retry !== null) return { kind: 'retry' as const, ...retry };
        const candidates = await unit.automations.listLiveAutomationsOfAccount({
          organizationId: call.organizationId,
          instagramAccountId: call.instagramAccountId,
          triggerType: 'comment',
          isDmKeywordTriggerRequired: false,
        });
        const { chosen: match, otherMatches } = chooseCommentAutomation({
          candidates,
          instagramMediaId: input.instagramMediaId,
          text: input.text,
        });
        if (match === null) return { kind: 'nothing' as const };
        const chosen = await this.lockLiveAutomation({ unit, call, automationId: match.id });
        if (chosen === null) return { kind: 'ignored' as const };
        const trigger: AutomationQueuedTrigger = {
          type: 'comment',
          instagram_media_id: input.instagramMediaId,
          instagram_comment_id: input.instagramCommentId,
          text: input.text,
        };
        const conflict = await this.findConflict({ unit, call, automationId: chosen.id });
        let runId: number | null = null;
        if (conflict.reason === null) {
          runId = (await this.startRun({ unit, call, automation: chosen, trigger })).id;
        } else if (conflict.emailWaitingRun !== null) {
          await this.queueTrigger({
            unit,
            call,
            waitingRun: conflict.emailWaitingRun,
            automation: chosen,
            trigger,
            now,
          });
        }
        const logOf = ({
          automation,
          automationRunId,
          ignoredReason,
        }: {
          automation: AutomationRow;
          automationRunId: number | null;
          ignoredReason: AutomationCommentLogIgnoredReason | null;
        }): AutomationCommentLogInsertValues => ({
          organizationId: call.organizationId,
          automationId: automation.id,
          automationName: automation.name,
          automationRunId,
          contactId: call.contactId,
          instagramMediaId: input.instagramMediaId,
          instagramCommentId: input.instagramCommentId,
          commentText: input.text,
          commenterUsername: input.commenterUsername,
          commenterInstagramUserId: call.instagramUserId,
          overallStatus: ignoredReason === null ? 'started' : 'ignored',
          ignoredReason,
        });
        await unit.commentLogs.insertMany([
          logOf({ automation: chosen, automationRunId: runId, ignoredReason: conflict.reason }),
          ...otherMatches.map((automation) =>
            logOf({
              automation: automation,
              automationRunId: null,
              ignoredReason: 'comment_already_answered',
            }),
          ),
        ]);
        return {
          kind: 'chosen' as const,
          runId,
          reason: conflict.reason,
          emailWaitingRunId: conflict.emailWaitingRun?.id ?? null,
          ignoredCount: otherMatches.length,
        };
      },
    });
    if (choice.kind === 'ignored') return handlingResult({ outcome: 'ignored' });
    const privateReply = {
      instagramCommentId: input.instagramCommentId,
      commentedAt: input.event.occurredAt,
    };
    if (choice.kind === 'retry') {
      return choice.emailWaitingRunId === null
        ? this.resumeRunsMovedByEvent(call)
        : this.askEmailAgain({ call, runId: choice.emailWaitingRunId, privateReply });
    }
    if (choice.kind === 'nothing') return handlingResult({ outcome: 'nothing_matched' });
    logger.info(
      {
        organizationPublicId: call.scope.organizationPublicId,
        instagramAccountPublicId: call.access.instagramAccountPublicId,
        isRunStarted: choice.runId !== null,
        ignoredReason: choice.reason,
        alreadyAnsweredCount: choice.ignoredCount,
      },
      'app.automation_run.comment_matched',
    );
    if (choice.runId !== null) {
      return this.advanceRuns({ call, runIds: [choice.runId], outcome: 'run_started' });
    }
    if (choice.emailWaitingRunId !== null) {
      return this.askEmailAgain({ call, runId: choice.emailWaitingRunId, privateReply });
    }
    return handlingResult({ outcome: 'comment_logged' });
  }

  /**
   * A DM, or a `messages` change (3.B.8, AU16, D18): first an answer to the contact's run waiting
   * for an email (first) or a phone number; otherwise the first live automation of the account
   * with the DM keyword trigger on and a matching keyword starts a run.
   *
   * @remarks
   * Algorithm: a retried event resumes the runs it moved. An email answer — the quick reply, an
   * attachment's email or the typed text (D18) — goes to `recordContactEmail`: invalid → the
   * wrong-email text with the question again; saved → an `email_received` event, the run moves on
   * and every queued automation starts as its own run (AU21). A phone answer: invalid → nothing
   * sent, the run keeps waiting; saved → `phone_received`, the run moves on. A run waiting for a
   * step turned off meanwhile takes no answer: the DM goes to the next run that waits, or starts an
   * automation, and that run goes on after it (AU14). Failure modes and side effects: as the class.
   */
  async handleDirectMessage(
    input: AutomationDirectMessageInput,
  ): Promise<AutomationRunHandlingResult> {
    return this.handleEvent({
      input,
      handle: (call) => this.handleMessage({ call, input }),
    });
  }

  /** A DM's own handling ({@link handleDirectMessage}). */
  private async handleMessage({
    call,
    input,
  }: {
    call: AutomationRunCall;
    input: AutomationDirectMessageInput;
  }): Promise<AutomationRunHandlingResult> {
    const retried = await this.findRunsMovedByEvent(call);
    if (retried.length > 0) return this.resumeRunsMovedByEvent(call);
    const answer = await this.unit({
      call: call,
      work: (unit) => this.takeAnswer({ unit, call, input }),
    });
    switch (answer.kind) {
      case 'continued':
        return this.advanceRuns({ call, runIds: answer.runIds, outcome: 'run_continued' });
      case 'invalid_email':
        return this.sendToWaitingRun({
          call,
          runId: answer.runId,
          messageKind: 'invalid_email',
          privateReply: null,
          outcome: 'answer_invalid',
        });
      case 'invalid_phone':
        return handlingResult({ outcome: 'answer_invalid' });
      case 'erased':
        return handlingResult({ outcome: 'ignored' });
      case 'none':
        break;
    }
    const started = await this.unit({
      call: call,
      work: async (unit) => {
        if (unit.contact === null) return { kind: 'held' as const };
        const candidates = await unit.automations.listLiveAutomationsOfAccount({
          organizationId: call.organizationId,
          instagramAccountId: call.instagramAccountId,
          triggerType: null,
          isDmKeywordTriggerRequired: true,
        });
        const match = chooseDirectMessageAutomation({ candidates, text: input.text });
        if (match === null) return { kind: 'nothing' as const };
        const chosen = await this.lockLiveAutomation({ unit, call, automationId: match.id });
        if (chosen === null) return { kind: 'held' as const };
        const conflict = await this.findConflict({ unit, call, automationId: chosen.id });
        if (conflict.reason !== null) return { kind: 'held' as const };
        const run = await this.startRun({
          unit,
          call,
          automation: chosen,
          trigger: { type: 'dm', text: input.text },
        });
        return { kind: 'started' as const, runId: run.id };
      },
    });
    if (started.kind === 'nothing') return handlingResult({ outcome: 'nothing_matched' });
    if (started.kind === 'held') return handlingResult({ outcome: 'ignored' });
    return this.advanceRuns({ call, runIds: [started.runId], outcome: 'run_started' });
  }

  /**
   * A reply to one of the account's stories (3.B.8, AU16): the account's first live `story_reply`
   * automation — any story, or this one — whose keywords match starts a run (AU17 first: another
   * automation's run waiting for the contact's email takes the trigger into its queue and asks
   * again).
   *
   * @remarks
   * Algorithm: a retried event resumes the runs it moved; else one unit for the choice — deleted or
   * turned off before its lock → ignored (AU12) — and AU17, then the new run is advanced; last, a run
   * of the contact waiting for a step now off goes on (AU14). An expired story simply stops matching
   * (D18). Failure modes and side effects: as the class.
   */
  async startStoryReplyRun(
    input: AutomationStoryReplyRunInput,
  ): Promise<AutomationRunHandlingResult> {
    return this.handleEvent({
      input,
      handle: (call) => this.handleStoryReply({ call, input }),
    });
  }

  /** A story reply's own handling ({@link startStoryReplyRun}). */
  private async handleStoryReply({
    call,
    input,
  }: {
    call: AutomationRunCall;
    input: AutomationStoryReplyRunInput;
  }): Promise<AutomationRunHandlingResult> {
    const retried = await this.findRunsMovedByEvent(call);
    if (retried.length > 0) return this.resumeRunsMovedByEvent(call);
    const now = new Date();
    const choice = await this.unit({
      call: call,
      work: async (unit) => {
        if (unit.contact === null) return { kind: 'held' as const };
        const candidates = await unit.automations.listLiveAutomationsOfAccount({
          organizationId: call.organizationId,
          instagramAccountId: call.instagramAccountId,
          triggerType: 'story_reply',
          isDmKeywordTriggerRequired: false,
        });
        const match = chooseStoryReplyAutomation({
          candidates,
          instagramStoryId: input.instagramStoryId,
          text: input.text,
        });
        if (match === null) return { kind: 'nothing' as const };
        const chosen = await this.lockLiveAutomation({ unit, call, automationId: match.id });
        if (chosen === null) return { kind: 'held' as const };
        const trigger: AutomationQueuedTrigger = {
          type: 'story_reply',
          instagram_story_id: input.instagramStoryId,
          text: input.text,
        };
        const conflict = await this.findConflict({ unit, call, automationId: chosen.id });
        if (conflict.emailWaitingRun !== null) {
          await this.queueTrigger({
            unit,
            call,
            waitingRun: conflict.emailWaitingRun,
            automation: chosen,
            trigger,
            now,
          });
          return { kind: 'ask_again' as const, runId: conflict.emailWaitingRun.id };
        }
        if (conflict.reason !== null) return { kind: 'held' as const };
        const run = await this.startRun({ unit, call, automation: chosen, trigger });
        return { kind: 'started' as const, runId: run.id };
      },
    });
    switch (choice.kind) {
      case 'nothing':
        return handlingResult({ outcome: 'nothing_matched' });
      case 'held':
        return handlingResult({ outcome: 'ignored' });
      case 'ask_again':
        return this.askEmailAgain({ call, runId: choice.runId, privateReply: null });
      case 'started':
        return this.advanceRuns({ call, runIds: [choice.runId], outcome: 'run_started' });
    }
  }

  /**
   * A postback `<aut_…>::<run_…>` (3.B.8, AU16, D18): continues that run when it waits for the
   * opening button or the "I'm following" button, belongs to this contact and its automation to
   * the event's account; a run waiting for the contact's email (its email step still on) comes
   * first — the click is not continued and the question is asked again (AU17 (1)).
   *
   * @remarks
   * Algorithm: a retried event resumes the runs it moved; else one unit: the email wait, then the
   * clicked run locked — a `completed`, `failed`, `cancelled` or running run, one of a deleted
   * automation or another account's ignores the click. The opening button moves the run to the
   * follow check; the "I'm following" button reads the follow status again (following continues,
   * not following sends the request again). Last, a run of the contact waiting for a step now off
   * goes on (AU14). Failure modes and side effects: as the class.
   */
  async handleButtonClick(input: AutomationButtonClickInput): Promise<AutomationRunHandlingResult> {
    return this.handleEvent({
      input,
      handle: (call) => this.handleClick({ call, input }),
    });
  }

  /** A button click's own handling ({@link handleButtonClick}). */
  private async handleClick({
    call,
    input,
  }: {
    call: AutomationRunCall;
    input: AutomationButtonClickInput;
  }): Promise<AutomationRunHandlingResult> {
    const retried = await this.findRunsMovedByEvent(call);
    if (retried.length > 0) return this.resumeRunsMovedByEvent(call);
    const now = new Date();
    const click = await this.unit({
      call: call,
      work: async (unit) => {
        const emailWaitingRun = await this.lockEmailWaitingRun({ unit, call });
        if (emailWaitingRun !== null && emailWaitingRun.public_id !== input.runPublicId) {
          return { kind: 'ask_again' as const, runId: emailWaitingRun.id };
        }
        const run = await unit.runs.lockContactRunByPublicId({
          organizationId: call.organizationId,
          contactId: call.contactId,
          runPublicId: input.runPublicId,
        });
        if (run === null || run.status !== 'waiting') return { kind: 'ignored' as const };
        const automation = await unit.automations.findByIdIncludingDeleted({
          organizationId: call.organizationId,
          automationId: run.automation_id,
        });
        if (
          automation === null ||
          automation.deleted_at !== null ||
          automation.public_id !== input.automationPublicId ||
          automation.instagram_account_id !== call.instagramAccountId
        ) {
          return { kind: 'ignored' as const };
        }
        if (run.waiting_for !== 'opening_message_button' && run.waiting_for !== 'follow') {
          return { kind: 'ignored' as const };
        }
        const isOpeningButton = run.waiting_for === 'opening_message_button';
        await this.resumeWaitingRun({
          unit,
          call,
          run,
          toStep: 'follow_check',
          commentLogChanges: isOpeningButton
            ? { opening_dm_status: 'done', button_clicked_at: now }
            : {},
        });
        return { kind: 'continued' as const, runId: run.id };
      },
    });
    switch (click.kind) {
      case 'ask_again':
        return this.askEmailAgain({ call, runId: click.runId, privateReply: null });
      case 'ignored':
        return handlingResult({ outcome: 'ignored' });
      case 'continued':
        return this.advanceRuns({ call, runIds: [click.runId], outcome: 'run_continued' });
    }
  }

  /**
   * The automation delete's open-run cancel (AU12, `cancelAutomationOpenRuns`) — registered with
   * the automation service by the app container; runs inside route 15's unit of work. Cancels the
   * automation's `running` and `waiting` runs (`automation_deleted`, one `status_changed` event
   * each, their comment logs `cancelled`) and answers how many.
   *
   * @remarks
   * Algorithm: one conditional update of the open runs, their events and logs — joining the
   * route's transaction (no handle of its own), which already holds the automation `FOR UPDATE`: no
   * unit can be starting or moving a run of it, so the update finds every open run and waits for
   * none (D47). Failure modes: a database error rolls the delete back. Side effects: the cancelled
   * runs, their events and logs; runs and logs stay.
   */
  async cancelAutomationOpenRuns({
    organizationId,
    automationId,
  }: AutomationOpenRunCancelInput): Promise<number> {
    const runs = new AutomationRunRepository();
    const cancelledRunIds = await runs.cancelOpenRunsOfAutomation({ organizationId, automationId });
    await this.recordCancelledRuns({ organizationId, runIds: cancelledRunIds });
    return cancelledRunIds.length;
  }

  /**
   * This sub-domain's contact erasure step (AU26, CT8) — registered with the contact service by
   * the app container; runs inside route 10's unit of work, before the contact is anonymised.
   *
   * @remarks
   * Algorithm: the automations of the contact's open runs locked `FOR KEY SHARE` — the erase holds
   * the contact, and the writes below change those runs and logs twice, which makes Postgres reach
   * for their automation (the engine's lock order, D47); the contact's `running` and `waiting` runs
   * cancelled (`contact_deleted`, one `status_changed` event each, their logs `cancelled`, queued
   * automations emptied); then on all its runs `trigger_text` and the queued automations cleared, and
   * on all its comment logs the comment text, the commenter's username and Instagram id, the email
   * and the phone received — matched by `contact_id` alone (every log carries it, AU24). The
   * Instagram ids of posts, stories and comments stay. Failure modes: a database error rolls the
   * erase back. Side effects: the writes above.
   */
  async eraseContactRunCopies({
    organizationId,
    contactId,
  }: ContactErasureStepInput): Promise<void> {
    const runs = new AutomationRunRepository();
    await new AutomationRepository().lockForRunChanges({
      organizationId,
      automationIds: await runs.listOpenRunAutomationIds({ organizationId, contactId }),
    });
    const cancelledRunIds = await runs.cancelOpenRunsOfContact({ organizationId, contactId });
    await this.recordCancelledRuns({ organizationId, runIds: cancelledRunIds });
    await runs.eraseContactCopies({ organizationId, contactId });
    await new AutomationCommentLogRepository().eraseContactCopies({ organizationId, contactId });
  }

  /**
   * The 7-day wait's cancel (AU25, WC-13) — the hourly worker calls it for one organization's runs
   * its cross-organization scan found, inside that organization's job context
   * (`runOrganizationScopedWorkerJob`), and answers how many it cancelled.
   *
   * @remarks
   * Algorithm: the same cancel as an automation delete or a contact erase — one conditional update
   * that re-checks each run still waits since before `waitingSinceBefore` (a run that got its
   * answer, moved on or was cancelled since the scan is left as it is, and so is one another
   * transaction holds right now — still due the next hour, D47), `cancelled` ·
   * `wait_expired`, the wait, the claim and the queued automations cleared (AU21 — none of them
   * starts); then one `status_changed` event each and their comment logs `cancelled` — all on the
   * job's handle, in its one unit of work. Failure modes: a database error rolls the organization's
   * cancel back; the worker counts it and the runs stay due for the next hour. Side effects: the
   * cancelled runs, their events and logs. Safe to repeat — a cancelled run no longer waits.
   */
  async cancelExpiredWaitingRuns({
    databaseHandle,
    organizationId,
    runIds,
    waitingSinceBefore,
  }: {
    databaseHandle: WorkerDatabaseHandle;
    organizationId: number;
    runIds: readonly number[];
    waitingSinceBefore: Date;
  }): Promise<number> {
    const cancelledRunIds = await createWorkerAutomationRunRepository(
      databaseHandle,
    ).cancelExpiredWaitingRuns({ organizationId, runIds, waitingSinceBefore });
    await this.recordCancelledRuns({ organizationId, runIds: cancelledRunIds, databaseHandle });
    return cancelledRunIds.length;
  }

  /**
   * The runs a webhook event that ended `failed` left `running` (AU19, WH14, D47) — sub-domain 4
   * calls it whenever it marks an event `failed` (the 5th failed attempt, attempts that ran out, a
   * permanent or token failure), or `skipped` after a claim (the account switched off or disconnected
   * between two tries, D51), in the unit of work of that mark. Fails each and answers their `run_…`
   * ids.
   *
   * @remarks
   * Algorithm: one short unit, joining the caller's when one is open for the organization — every
   * `running` run whose `last_instagram_event_key` is the event's: the contact, then the automations,
   * then each run locked (the engine's order) and read again; still `running` under that key →
   * `failed` with `code:<errorCode>`, the claim cleared, a `status_changed` event, and its comment
   * log `failed` (`error_type` `code`, the failed step, `error_at`) — a value the log already holds is
   * kept. A DM or story-reply run keeps its error on the run (D16). Runs that wait, or ended, are left
   * as they are. Failure modes: a database error rolls the unit back, the caller's mark included — the
   * event stays to be picked up again. Side effects: the failed runs, their events and logs; nothing
   * is sent. Idempotent: a second call finds none left running.
   */
  async failRunsOfFailedEvent({
    scope,
    organizationId,
    eventKey,
    errorCode,
  }: AutomationFailedEventInput): Promise<string[]> {
    return withAppDatabaseContext({
      scope,
      callback: async (databaseHandle) => {
        const unit = bindRepositories(databaseHandle);
        const leftRunning = await unit.runs.listRunningMovedByEvent({ organizationId, eventKey });
        const contactIds = [...new Set(leftRunning.map((run) => run.contact_id))];
        contactIds.sort((left, right) => left - right);
        for (const contactId of contactIds) {
          await this.contactService.lockLiveContact({ databaseHandle, organizationId, contactId });
        }
        await unit.automations.lockForRunChanges({
          organizationId,
          automationIds: [...new Set(leftRunning.map((run) => run.automation_id))],
        });
        const failedRunPublicIds: string[] = [];
        for (const { id } of leftRunning) {
          const run = await unit.runs.lockById({ organizationId, runId: id });
          if (run?.status !== 'running' || run.last_instagram_event_key !== eventKey) continue;
          await this.failRun({
            unit,
            call: { scope, organizationId },
            run,
            commentLog:
              run.trigger_type === 'comment'
                ? await unit.commentLogs.findForRun({ organizationId, runId: run.id })
                : null,
            failure: { errorType: 'code', reason: errorCode, error: null, isClaimKept: false },
            isLoggedErrorKept: true,
          });
          failedRunPublicIds.push(run.public_id);
        }
        return failedRunPublicIds;
      },
    });
  }

  /**
   * The `status_changed` events and `cancelled` logs of runs just cancelled (AU12, AU25, AU26) — on
   * the job's handle when given, else in the route's own unit of work.
   */
  private async recordCancelledRuns({
    organizationId,
    runIds,
    databaseHandle,
  }: {
    organizationId: number;
    runIds: readonly number[];
    databaseHandle?: WorkerDatabaseHandle | undefined;
  }): Promise<void> {
    if (runIds.length === 0) return;
    const runEvents =
      databaseHandle === undefined
        ? new AutomationRunEventRepository()
        : createWorkerAutomationRunEventRepository(databaseHandle);
    const commentLogs =
      databaseHandle === undefined
        ? new AutomationCommentLogRepository()
        : createWorkerAutomationCommentLogRepository(databaseHandle);
    await runEvents.insertMany(
      runIds.map((runId) => ({
        organizationId,
        runId,
        eventType: 'status_changed' as const,
        status: 'cancelled' as const,
      })),
    );
    await commentLogs.markRunsCancelled({ organizationId, runIds });
  }

  /**
   * One event of the account (3.B.8): its own handling, then the contact's runs that wait for a step
   * now off (AU14, {@link continueRunsWithStepOff}) — in that order, so that a run this event moved
   * means its own handling is done and a retry only has to resume (AU19).
   */
  private async handleEvent({
    input,
    handle,
  }: {
    input: AutomationRunTriggerInput;
    handle: (call: AutomationRunCall) => Promise<AutomationRunHandlingResult>;
  }): Promise<AutomationRunHandlingResult> {
    const call = await this.openCall(input);
    if (call === null) return handlingResult({ outcome: 'account_unavailable' });
    return this.continueRunsWithStepOff({ call, handled: await handle(call) });
  }

  /**
   * The contact's runs that wait for a step now off (AU14, D48), after the event's own handling: each
   * goes on as if it had no such step, and the automations queued behind its email start as when the
   * email arrives (AU21). Nothing goes on after a dead token — every send would only fail on it — the
   * runs wait for a later event. Answers the two results as one, the event's own outcome first.
   */
  private async continueRunsWithStepOff({
    call,
    handled,
  }: {
    call: AutomationRunCall;
    handled: AutomationRunHandlingResult;
  }): Promise<AutomationRunHandlingResult> {
    if (handled.failedErrorType === 'token') return handled;
    const runIds = await this.unit({
      call: call,
      work: (unit) => this.skipStepsNowOff({ unit, call }),
    });
    if (runIds.length === 0) return handled;
    const continued = await this.advanceRuns({ call, runIds, outcome: 'run_continued' });
    const isNothingElseMoved =
      handled.runPublicIds.length === 0 || handled.outcome === 'already_handled';
    return handlingResult({
      outcome: isNothingElseMoved ? continued.outcome : handled.outcome,
      runPublicIds: [...new Set([...handled.runPublicIds, ...continued.runPublicIds])],
      failedErrorType:
        continued.failedErrorType === 'token'
          ? 'token'
          : (handled.failedErrorType ?? continued.failedErrorType),
    });
  }

  /**
   * Inside one unit: every waiting run of the contact whose step is now off ({@link
   * planWaitedStepNowOff}) is `running` again at its next step, the waited one closed on its comment
   * log, and the automations queued behind an email wait start (AU21). Answers the runs to advance,
   * each followed by the ones its queue started. Only inside the messaging window (D50): a comment
   * does not open it, Instagram takes one private reply per comment and the run's has gone, so outside
   * it nothing could be sent and the run waits on (3.B.10). A run of a deleted automation, or another
   * account's, is left alone.
   */
  private async skipStepsNowOff({
    unit,
    call,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
  }): Promise<number[]> {
    if (unit.contact === null) return [];
    const recipient = resolveAutomationMessageRecipient({
      instagramUserId: call.instagramUserId,
      lastDirectMessageReceivedAt: unit.contact.last_direct_message_received_at,
      privateReply: null,
      now: new Date(),
    });
    if (recipient === null) return [];
    const waitingRuns = await this.lockWaitingRuns({
      unit,
      call,
      waitingFor: AUTOMATION_RUN_WAITING_FOR,
    });
    const runIds: number[] = [];
    for (const { run, automation, stepOff } of waitingRuns) {
      if (
        stepOff === null ||
        automation === null ||
        automation.deleted_at !== null ||
        automation.instagram_account_id !== call.instagramAccountId
      ) {
        continue;
      }
      await this.resumeWaitingRun({ unit, call, run, ...stepOff });
      runIds.push(run.id);
      if (run.waiting_for === 'email') {
        runIds.push(...(await this.startQueuedAutomations({ unit, call, answeredRun: run })));
      }
    }
    return runIds;
  }

  /**
   * Reads the event's account once (AU27): this organization's connected account with a token,
   * and the contact of that account; `null` otherwise — nothing runs.
   */
  private async openCall(input: AutomationRunTriggerInput): Promise<AutomationRunCall | null> {
    const access = await this.instagramAccountService.findAutomationAccountAccess({
      scope: input.scope,
      instagramAccountPublicId: input.instagramAccountPublicId,
    });
    const { contact } = input;
    if (
      access === null ||
      access.connectionStatus !== 'connected' ||
      access.encryptedAccessToken === null ||
      contact.instagram_account_id !== access.instagramAccount.instagramAccountId ||
      contact.instagram_user_id === null
    ) {
      logger.info(
        {
          organizationPublicId: input.scope.organizationPublicId,
          instagramAccountPublicId: input.instagramAccountPublicId,
          connectionStatus: access?.connectionStatus ?? null,
        },
        'app.automation_run.account_unavailable',
      );
      return null;
    }
    return {
      scope: input.scope,
      access,
      organizationId: access.instagramAccount.organizationId,
      instagramAccountId: access.instagramAccount.instagramAccountId,
      contactId: contact.id,
      instagramUserId: contact.instagram_user_id,
      event: input.event,
    };
  }

  /**
   * One short unit of work in the call's organization scope, its repositories bound to it (AU19).
   *
   * @remarks
   * Locks the call's contact first (`lockLiveContact`, `FOR KEY SHARE`) — the order of a contact
   * erase, which locks the contact and then its runs (CT8). Otherwise a unit that holds a run and
   * then needs the contact (its message time, or the reference check of a run changed twice in one
   * transaction) and an erase that holds the contact and waits for the run block each other. So an
   * erase waits for the unit and clears what it wrote, and a unit that comes after an erase finds no
   * `contact` and writes nothing of the erased person.
   *
   * Then the automations of the contact's open runs (`lockForRunChanges`, `FOR KEY SHARE`) — the only
   * runs a unit moves — before any of those runs: a unit that holds a run and then needs its
   * automation (the counters, the same reference check) and a delete (route 15) that holds the
   * automation and waits for the run block each other (AU12, D47). A delete waits for the unit and
   * cancels what it left open; a unit that comes after a delete finds the run cancelled.
   */
  private unit<T>({
    call,
    work,
  }: {
    call: AutomationRunCall;
    work: (unit: AutomationRunUnit) => Promise<T>;
  }): Promise<T> {
    return withAppDatabaseContext({
      scope: call.scope,
      callback: async (databaseHandle) => {
        const { organizationId, contactId } = call;
        const contact = await this.contactService.lockLiveContact({
          databaseHandle,
          organizationId,
          contactId,
        });
        const repositories = bindRepositories(databaseHandle);
        await repositories.automations.lockForRunChanges({
          organizationId,
          automationIds: await repositories.runs.listOpenRunAutomationIds({
            organizationId,
            contactId,
          }),
        });
        return work({ ...repositories, contact });
      },
    });
  }

  /**
   * The automation a run is about to start on, proven live under its lock (AU12, D47) — `null` when
   * it was deleted or turned off since it was matched: nothing starts. Taken before AU17 locks a run.
   */
  private lockLiveAutomation({
    unit,
    call,
    automationId,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    automationId: number;
  }): Promise<AutomationRow | null> {
    return unit.automations.lockLiveForRunStart({
      organizationId: call.organizationId,
      automationId,
    });
  }

  /**
   * The contact's runs that wait for one of `waitingFor`, locked (email waits first, then the oldest
   * wait), each with its automation as it is now and what AU14 says of the step it waits for.
   */
  private async lockWaitingRuns({
    unit,
    call,
    waitingFor,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    waitingFor: readonly AutomationRunWaitingFor[];
  }): Promise<WaitingRun[]> {
    const runs = await unit.runs.lockWaitingRunsOfContact({
      organizationId: call.organizationId,
      contactId: call.contactId,
      waitingFor,
    });
    const waitingRuns: WaitingRun[] = [];
    for (const run of runs) {
      const automation = await unit.automations.findByIdIncludingDeleted({
        organizationId: call.organizationId,
        automationId: run.automation_id,
      });
      const stepOff =
        automation === null
          ? null
          : planWaitedStepNowOff({
              waitingFor: run.waiting_for as AutomationRunWaitingFor,
              automation,
            });
      waitingRuns.push({ run, automation, stepOff });
    }
    return waitingRuns;
  }

  /**
   * The contact's run that waits for the email (locked), its automation's email step still on — a
   * wait whose step is now off asks nobody and holds nothing back (AU14); `null` when there is none.
   */
  private async lockEmailWaitingRun({
    unit,
    call,
    otherThanAutomationId,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    /** Leave this automation's own wait out (AU17 — never asked again, D14). */
    otherThanAutomationId?: number;
  }): Promise<AutomationRunRow | null> {
    const waitingRuns = await this.lockWaitingRuns({ unit, call, waitingFor: ['email'] });
    const waiting = waitingRuns.find(
      ({ run, stepOff }) => stepOff === null && run.automation_id !== otherThanAutomationId,
    );
    return waiting?.run ?? null;
  }

  /** The contact's runs this event last moved (AU19). */
  private findRunsMovedByEvent(call: AutomationRunCall): Promise<AutomationRunRow[]> {
    return this.unit({
      call: call,
      work: (unit) =>
        unit.runs.findRunsMovedByEvent({
          organizationId: call.organizationId,
          contactId: call.contactId,
          eventKey: call.event.eventKey,
        }),
    });
  }

  /**
   * A retried event (AU19, 3.B.10): every run it last moved — `running` ones resume from their
   * saved step; a `waiting` one with a claim still set (a question asked again, its outcome
   * unknown) has the claim cleared, never re-sent. Nothing else is applied again.
   */
  private async resumeRunsMovedByEvent(
    call: AutomationRunCall,
  ): Promise<AutomationRunHandlingResult> {
    const moved = await this.findRunsMovedByEvent(call);
    const runningIds: number[] = [];
    for (const run of moved) {
      if (run.status === 'running') {
        runningIds.push(run.id);
      } else if (run.status === 'waiting' && run.sending_message_kind !== null) {
        await this.unit({
          call: call,
          work: (unit) =>
            unit.runs.update({
              organizationId: call.organizationId,
              runId: run.id,
              changes: { sending_message_kind: null, sending_started_at: null },
            }),
        });
      }
    }
    if (runningIds.length === 0) {
      return handlingResult({
        outcome: 'already_handled',
        runPublicIds: moved.map((run) => run.public_id),
      });
    }
    return this.advanceRuns({ call, runIds: runningIds, outcome: 'run_resumed' });
  }

  /**
   * Whether the comment was handled before (AU16, AU19): its logs exist — or, when it matched nothing
   * and so has none, it moved a run on (AU14). `null` for a new comment; for a retried one, the run
   * its email question still has to be asked on, if any.
   */
  private async findCommentRetry({
    unit,
    call,
    instagramCommentId,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    instagramCommentId: string;
  }): Promise<{ emailWaitingRunId: number | null } | null> {
    const existingLogs = await unit.commentLogs.listForComment({
      organizationId: call.organizationId,
      instagramCommentId,
    });
    if (existingLogs.length > 0) {
      return {
        emailWaitingRunId: await this.findRunStillToAskAgain({ unit, call, existingLogs }),
      };
    }
    const moved = await unit.runs.findRunsMovedByEvent({
      organizationId: call.organizationId,
      contactId: call.contactId,
      eventKey: call.event.eventKey,
    });
    return moved.length > 0 ? { emailWaitingRunId: null } : null;
  }

  /**
   * The run a retried comment still has to ask for the email (AU17 (1), AU19): the comment was held
   * back (`waiting_for_other_email`) and the run waiting for the contact's email was not moved by
   * this event — its question was never claimed, or Instagram could not take it for now. `null`
   * when there is nothing to ask.
   */
  private async findRunStillToAskAgain({
    unit,
    call,
    existingLogs,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    existingLogs: readonly AutomationCommentLogRow[];
  }): Promise<number | null> {
    if (!existingLogs.some((log) => log.ignored_reason === 'waiting_for_other_email')) return null;
    const emailWaitingRun = await this.lockEmailWaitingRun({ unit, call });
    return emailWaitingRun === null ||
      emailWaitingRun.last_instagram_event_key === call.event.eventKey
      ? null
      : emailWaitingRun.id;
  }

  /**
   * AU17 for the chosen automation and the contact: **another** automation's run waiting for the
   * contact's email (locked, its email step still on — AU14) — the chosen automation's own wait is
   * `already_waiting`, never asked again (D14) — and the decision ({@link decideExistingRunConflict}).
   */
  private async findConflict({
    unit,
    call,
    automationId,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    automationId: number;
  }): Promise<{
    reason: AutomationCommentLogIgnoredReason | null;
    emailWaitingRun: AutomationRunRow | null;
  }> {
    const emailWaitingRun = await this.lockEmailWaitingRun({
      unit,
      call,
      otherThanAutomationId: automationId,
    });
    const latest = await unit.runs.findLatestRunOfAutomationForContact({
      organizationId: call.organizationId,
      automationId,
      contactId: call.contactId,
    });
    return {
      reason: decideExistingRunConflict({
        hasEmailWaitingRun: emailWaitingRun !== null,
        latestRunStatus: (latest?.status ?? null) as AutomationRunStatus | null,
      }),
      emailWaitingRun,
    };
  }

  /**
   * Starts a run (AU18 step 1): `running` at `keyword_match`, keyed by the event, the automation's
   * `last_triggered_at` stamped (AU10) and a `status_changed` event. Every caller has the automation
   * from {@link lockLiveAutomation}: live, and locked until the unit ends (AU12).
   */
  private async startRun({
    unit,
    call,
    automation,
    trigger,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    automation: AutomationRow;
    trigger: AutomationQueuedTrigger;
  }): Promise<AutomationRunRow> {
    const run = await unit.runs.insert({
      organizationId: call.organizationId,
      automationId: automation.id,
      contactId: call.contactId,
      triggerType: trigger.type,
      triggerInstagramMediaId: trigger.instagram_media_id ?? null,
      triggerInstagramCommentId: trigger.instagram_comment_id ?? null,
      triggerInstagramStoryId: trigger.instagram_story_id ?? null,
      triggerText: trigger.text,
      lastInstagramEventKey: call.event.eventKey,
    });
    await unit.automations.markRunStarted({
      organizationId: call.organizationId,
      automationId: automation.id,
    });
    await unit.runEvents.insertMany([
      {
        organizationId: call.organizationId,
        runId: run.id,
        eventType: 'status_changed',
        status: 'running',
      },
    ]);
    return run;
  }

  /**
   * Queues a trigger behind another automation's run waiting for the contact's email (AU21): one
   * entry per automation (a second trigger is logged, not added), at most 100.
   */
  private async queueTrigger({
    unit,
    call,
    waitingRun,
    automation,
    trigger,
    now,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    waitingRun: AutomationRunRow;
    automation: AutomationRow;
    trigger: AutomationQueuedTrigger;
    now: Date;
  }): Promise<void> {
    const { entries } = readQueuedAutomations(waitingRun.queued_automations);
    if (
      entries.some((entry) => entry.automation_id === automation.public_id) ||
      entries.length >= AUTOMATION_RUN_QUEUED_AUTOMATIONS_MAX_COUNT
    ) {
      return;
    }
    const queued = assertQueuedAutomations([
      ...entries,
      { automation_id: automation.public_id, queued_at: now.toISOString(), trigger },
    ]);
    await unit.runs.replaceQueuedAutomations({
      organizationId: call.organizationId,
      runId: waitingRun.id,
      entries: queued,
    });
  }

  /**
   * A waiting run takes its event (a click, an answer, AU14): `running` again at `toStep`, keyed
   * by the event, a `status_changed` event, its comment log back to `started`. A claim still on it —
   * a question asked again by an event that died — is over and cleared: nothing of it is re-sent, and
   * it is not a message of the step the run goes on to.
   */
  private async resumeWaitingRun({
    unit,
    call,
    run,
    toStep,
    commentLogChanges,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    run: AutomationRunRow;
    toStep: AutomationRunStep;
    commentLogChanges: AutomationCommentLogChanges;
  }): Promise<void> {
    await unit.runs.update({
      organizationId: call.organizationId,
      runId: run.id,
      changes: {
        status: 'running',
        current_step: toStep,
        waiting_for: null,
        waiting_since_at: null,
        sending_message_kind: null,
        sending_started_at: null,
        last_instagram_event_key: call.event.eventKey,
        last_step_at: new Date(),
      },
    });
    await unit.runEvents.insertMany([
      {
        organizationId: call.organizationId,
        runId: run.id,
        eventType: 'status_changed',
        status: 'running',
      },
    ]);
    await this.updateCommentLogOfRun({
      unit,
      call,
      runId: run.id,
      changes: { ...commentLogChanges, overall_status: 'started', waiting_for: null },
    });
  }

  /** Writes `changes` to the run's comment log, when it has one. */
  private async updateCommentLogOfRun({
    unit,
    call,
    runId,
    changes,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    runId: number;
    changes: AutomationCommentLogChanges;
  }): Promise<void> {
    const commentLog = await unit.commentLogs.findForRun({
      organizationId: call.organizationId,
      runId,
    });
    if (commentLog === null) return;
    await unit.commentLogs.update({
      organizationId: call.organizationId,
      commentLogId: commentLog.id,
      changes,
    });
  }

  /**
   * The DM's answer to the contact's waiting run (AU16, AU18 steps 4–5, AU21) — inside one unit:
   * `continued` with the runs to advance (the answered one, then the queued ones it started),
   * `invalid_email` / `invalid_phone`, `erased`, or `none` (no run waits for an answer). A run whose
   * step is now off takes none (AU14).
   */
  private async takeAnswer({
    unit,
    call,
    input,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    input: AutomationDirectMessageInput;
  }): Promise<
    | { kind: 'continued'; runIds: number[] }
    | { kind: 'invalid_email'; runId: number }
    | { kind: 'invalid_phone' }
    | { kind: 'erased' }
    | { kind: 'none' }
  > {
    const waitingRuns = await this.lockWaitingRuns({
      unit,
      call,
      waitingFor: ['email', 'phone'],
    });
    const asked = waitingRuns.find(
      ({ automation, stepOff }) => automation !== null && stepOff === null,
    );
    if (asked === undefined) return { kind: 'none' };
    const { run } = asked;
    const contactKey = {
      databaseHandle: unit.databaseHandle,
      organizationId: call.organizationId,
      contactId: call.contactId,
    };
    const isEmail = run.waiting_for === 'email';
    const nextStep: AutomationRunStep = isEmail ? 'phone_collect' : 'final_dm';
    const collectedAt = input.event.occurredAt;
    const saved = isEmail
      ? await this.contactService.recordContactEmail({
          ...contactKey,
          email: pickEmailAnswer(input) ?? '',
          collectedAt,
        })
      : await this.contactService.recordContactPhone({
          ...contactKey,
          phone: pickPhoneAnswer(input) ?? '',
          collectedAt,
        });
    if (saved === null) return { kind: 'erased' };
    if (saved.outcome === 'invalid') {
      return isEmail ? { kind: 'invalid_email', runId: run.id } : { kind: 'invalid_phone' };
    }
    await this.resumeWaitingRun({
      unit,
      call,
      run,
      toStep: nextStep,
      commentLogChanges: isEmail
        ? { email_status: 'done', email_at: collectedAt, email_received: saved.contact.email }
        : { phone_status: 'done', phone_at: collectedAt, phone_received: saved.contact.phone },
    });
    await unit.runEvents.insertMany([
      {
        organizationId: call.organizationId,
        runId: run.id,
        eventType: isEmail ? 'email_received' : 'phone_received',
      },
    ]);
    if (!isEmail) return { kind: 'continued', runIds: [run.id] };
    const queuedRunIds = await this.startQueuedAutomations({ unit, call, answeredRun: run });
    return { kind: 'continued', runIds: [run.id, ...queuedRunIds] };
  }

  /**
   * The automations queued behind the email question, answered or now off (AU21, AU14): each starts
   * as its own run, in order — skipped when the automation is no longer live or was deleted (read
   * under its lock, AU12), belongs to another account, or AU17 holds it back — and its comment log
   * moves from `ignored` to `started` with the new run. A malformed entry is skipped and logged
   * (3.B.9). The queue is emptied.
   */
  private async startQueuedAutomations({
    unit,
    call,
    answeredRun,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    answeredRun: AutomationRunRow;
  }): Promise<number[]> {
    const { entries, malformedCount } = readQueuedAutomations(answeredRun.queued_automations);
    if (malformedCount > 0) {
      logger.warn(
        { runPublicId: answeredRun.public_id, malformedCount },
        'app.automation_run.queued_entry_malformed',
      );
    }
    await unit.runs.replaceQueuedAutomations({
      organizationId: call.organizationId,
      runId: answeredRun.id,
      entries: [],
    });
    const startedRunIds: number[] = [];
    for (const entry of entries) {
      const queued = await unit.automations.findByPublicIdIncludingDeleted({
        organizationId: call.organizationId,
        automationPublicId: entry.automation_id,
      });
      if (queued === null || queued.instagram_account_id !== call.instagramAccountId) continue;
      const automation = await this.lockLiveAutomation({ unit, call, automationId: queued.id });
      if (automation === null) continue;
      const latest = await unit.runs.findLatestRunOfAutomationForContact({
        organizationId: call.organizationId,
        automationId: automation.id,
        contactId: call.contactId,
      });
      const conflict = decideExistingRunConflict({
        hasEmailWaitingRun: false,
        latestRunStatus: (latest?.status ?? null) as AutomationRunStatus | null,
      });
      if (conflict !== null) continue;
      const run = await this.startRun({ unit, call, automation, trigger: entry.trigger });
      const commentId = entry.trigger.instagram_comment_id;
      if (entry.trigger.type === 'comment' && commentId !== undefined) {
        const commentLog = await unit.commentLogs.findForAutomationComment({
          organizationId: call.organizationId,
          automationId: automation.id,
          instagramCommentId: commentId,
        });
        if (commentLog !== null) {
          await unit.commentLogs.update({
            organizationId: call.organizationId,
            commentLogId: commentLog.id,
            changes: { overall_status: 'started', ignored_reason: null, automation_run_id: run.id },
          });
        }
      }
      startedRunIds.push(run.id);
    }
    return startedRunIds;
  }

  /** Advances each run in order and sums up the call's result. */
  private async advanceRuns({
    call,
    runIds,
    outcome,
  }: {
    call: AutomationRunCall;
    runIds: readonly number[];
    outcome: AutomationRunHandlingResult['outcome'];
  }): Promise<AutomationRunHandlingResult> {
    let failedErrorType: AutomationCommentLogErrorType | null = null;
    const runPublicIds: string[] = [];
    for (const runId of runIds) {
      const result = await this.advanceRun({ call, runId });
      failedErrorType ??= result.failedErrorType;
      if (result.runPublicId !== null) runPublicIds.push(result.runPublicId);
    }
    return handlingResult({ outcome, runPublicIds, failedErrorType });
  }

  /**
   * Moves one `running` run as far as it goes (AU18, AU19): plan → (claim) → Instagram → record,
   * each unit short, until the run waits, completes, fails or stops.
   */
  private async advanceRun({ call, runId }: { call: AutomationRunCall; runId: number }): Promise<{
    failedErrorType: AutomationCommentLogErrorType | null;
    runPublicId: string | null;
  }> {
    let isFollowNotConfirmed = false;
    let runPublicId: string | null = null;
    for (let actionCount = 0; actionCount < ADVANCE_MAX_ACTIONS; actionCount += 1) {
      const prepared = await this.unit({
        call: call,
        work: (unit) => this.prepareAction({ unit, call, runId, isFollowNotConfirmed }),
      });
      isFollowNotConfirmed = false;
      if (prepared.kind === 'stop') return { failedErrorType: null, runPublicId };
      if (prepared.kind === 'failed') return { failedErrorType: prepared.errorType, runPublicId };
      runPublicId = prepared.run.public_id;
      const recorded = await this.performAction({ call, prepared });
      if (recorded.kind === 'rethrow') throw recorded.error;
      if (recorded.kind === 'failed') {
        if (recorded.tokenError !== undefined)
          await this.markTokenBroken({ call: call, error: recorded.tokenError });
        return { failedErrorType: recorded.errorType, runPublicId };
      }
      if (recorded.kind === 'stop') return { failedErrorType: null, runPublicId };
      isFollowNotConfirmed = recorded.isFollowNotConfirmed === true;
    }
    logger.warn({ runId }, 'app.automation_run.advance_limit_reached');
    return { failedErrorType: null, runPublicId };
  }

  /** The Instagram half of one prepared action and its record unit (AU19 steps b and c). */
  private async performAction({
    call,
    prepared,
  }: {
    call: AutomationRunCall;
    prepared: Exclude<PreparedAction, { kind: 'stop' } | { kind: 'failed' }>;
  }): Promise<RecordedAction> {
    const requestId = call.event.requestId;
    switch (prepared.kind) {
      case 'public_reply': {
        const result = await this.messageService.sendPublicReply({
          access: call.access,
          instagramCommentId: prepared.run.trigger_instagram_comment_id ?? '',
          text: prepared.text,
          requestId,
        });
        return this.unit({
          call: call,
          work: (unit) => this.recordPublicReply({ unit, call, prepared, result }),
        });
      }
      case 'send': {
        const result = await this.messageService.sendDirectMessage({
          access: call.access,
          recipient: prepared.recipient,
          composed: prepared.composed,
          requestId,
        });
        return this.unit({
          call: call,
          work: (unit) => this.recordSend({ unit, call, prepared, result }),
        });
      }
      case 'read_follow': {
        const result = await this.messageService.readFollowStatus({
          access: call.access,
          instagramUserId: call.instagramUserId,
          requestId,
        });
        return this.unit({
          call: call,
          work: (unit) => this.recordFollowRead({ unit, call, prepared, result }),
        });
      }
    }
  }

  /**
   * AU19 step a — in one unit: the run locked; stopped when it is not `running`, its contact was
   * erased or its automation deleted; a claim still set fails the step (AQ5 — a public reply is
   * marked failed and the flow goes on); then the planner, moving through every step that sends
   * nothing, until a send is claimed, a public reply decided or a follow read is due.
   */
  private async prepareAction({
    unit,
    call,
    runId,
    isFollowNotConfirmed,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    runId: number;
    /** The follow read just said "not following": send the request now. */
    isFollowNotConfirmed: boolean;
  }): Promise<PreparedAction> {
    const organizationId = call.organizationId;
    let run = await unit.runs.lockById({ organizationId, runId });
    if (run === null || run.status !== 'running') return { kind: 'stop' };
    const contact = await this.contactService.findLiveContact({
      databaseHandle: unit.databaseHandle,
      organizationId,
      contactId: run.contact_id,
    });
    const automation = await unit.automations.findByIdIncludingDeleted({
      organizationId,
      automationId: run.automation_id,
    });
    if (contact === null || automation === null || automation.deleted_at !== null) {
      return { kind: 'stop' };
    }
    let commentLog =
      run.trigger_type === 'comment'
        ? await unit.commentLogs.findForRun({ organizationId, runId })
        : null;
    if (run.sending_message_kind !== null) {
      const failure: AutomationRunFailure = {
        errorType: 'network',
        reason: 'send_outcome_unknown',
        error: null,
        isClaimKept: true,
      };
      if (run.sending_message_kind !== 'public_reply') {
        await this.failRun({ unit, call, run, commentLog, failure });
        return { kind: 'failed', errorType: 'network' };
      }
      run = await this.clearClaim({ unit, call, run });
      commentLog = await this.updateCommentLog({
        unit,
        call,
        commentLog,
        changes: { public_reply_status: 'failed', ...failureColumns(failure) },
      });
    }
    const now = new Date();
    // The comment log's step name for a step: the public reply while it is still to come (D19).
    const logStepOf = (runStep: AutomationRunStep) =>
      toCommentLogStep({
        runStep,
        isPublicReplyPending:
          automation.is_public_reply_enabled && commentLog?.public_reply_status === 'off',
      });
    for (let moveCount = 0; moveCount < ADVANCE_MAX_ACTIONS; moveCount += 1) {
      let plan = planAutomationRunStep({
        currentStep: run.current_step as AutomationRunStep,
        isCommentTrigger: run.trigger_type === 'comment',
        isPublicReplyPending: commentLog?.public_reply_status === 'off',
        automation,
        contact,
        now,
      });
      if (plan.action === 'read_follow' && isFollowNotConfirmed) {
        plan = {
          action: 'send',
          messageKind: 'follow_request',
          waitFor: 'follow',
          nextStep: 'email_collect',
        };
      }
      switch (plan.action) {
        case 'move': {
          run = await this.moveRun({ unit, call, run, toStep: plan.toStep });
          commentLog = await this.updateCommentLog({
            unit,
            call,
            commentLog,
            changes: { ...plan.commentLogChanges, current_step: logStepOf(plan.toStep) },
          });
          continue;
        }
        case 'public_reply': {
          const prepared = await this.preparePublicReply({
            unit,
            call,
            state: { run, automation, commentLog },
            now,
          });
          if (prepared.kind !== 'skipped') return prepared;
          commentLog = prepared.commentLog;
          continue;
        }
        case 'read_follow':
          return { kind: 'read_follow', run, automation, commentLog };
        case 'send':
          return this.prepareSend({
            unit,
            call,
            state: { run, automation, commentLog },
            contact,
            plan,
            now,
          });
      }
    }
    return { kind: 'stop' };
  }

  /**
   * The public reply's turn (AU20): reply safety decides; a skip is logged with its reason and the
   * flow goes on (`skipped`), a reply is claimed with its text.
   */
  private async preparePublicReply({
    unit,
    call,
    state,
    now,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    state: PreparedRunState;
    now: Date;
  }): Promise<
    | Extract<PreparedAction, { kind: 'public_reply' }>
    | { kind: 'skipped'; commentLog: AutomationCommentLogRow | null }
  > {
    const { run, automation, commentLog } = state;
    const decision = await this.replySafetyService.decide({
      commentLogRepository: unit.commentLogs,
      settings: call.access.settings,
      organizationId: call.organizationId,
      automationId: automation.id,
      instagramCommentId: run.trigger_instagram_comment_id ?? '',
      replyTexts: automation.public_reply_texts,
      now,
    });
    if (decision.kind === 'skip') {
      return {
        kind: 'skipped',
        commentLog: await this.updateCommentLog({
          unit,
          call,
          commentLog,
          changes: {
            public_reply_status: 'skipped',
            public_reply_skip_reason: decision.skipReason,
            current_step: 'opening_dm',
          },
        }),
      };
    }
    const claimed = await this.claim({ unit, call, run, messageKind: 'public_reply' });
    return { kind: 'public_reply', run: claimed, automation, commentLog, text: decision.text };
  }

  /**
   * A DM's turn (AU18, 3.B.10): the channel — none open fails the step without a call
   * (`outside_messaging_window`) — then the message composed and the send claimed.
   */
  private async prepareSend({
    unit,
    call,
    state,
    contact,
    plan,
    now,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    state: PreparedRunState;
    contact: { last_direct_message_received_at: Date | null };
    plan: Extract<AutomationRunStepPlan, { action: 'send' }>;
    now: Date;
  }): Promise<PreparedAction> {
    const { run, automation, commentLog } = state;
    const recipient = resolveAutomationMessageRecipient({
      instagramUserId: call.instagramUserId,
      lastDirectMessageReceivedAt: contact.last_direct_message_received_at,
      privateReply: this.privateReplyOf(run),
      now,
    });
    if (recipient === null) {
      await this.failRun({
        unit,
        call,
        run: { ...run, sending_message_kind: plan.messageKind },
        commentLog,
        failure: {
          errorType: 'instagram_api',
          reason: 'outside_messaging_window',
          error: null,
          isClaimKept: false,
        },
      });
      return { kind: 'failed', errorType: 'instagram_api' };
    }
    const composed = this.messageService.composeMessage({
      messageKind: plan.messageKind,
      automation,
      automationPublicId: automation.public_id,
      runPublicId: run.public_id,
      accountUsername: call.access.username,
    });
    const claimed = await this.claim({ unit, call, run, messageKind: plan.messageKind });
    return { kind: 'send', run: claimed, automation, commentLog, plan, recipient, composed };
  }

  /** The comment a private reply answers: the run's own comment, within its window (3.B.10). */
  private privateReplyOf(
    run: AutomationRunRow,
  ): { instagramCommentId: string; commentedAt: Date } | null {
    if (run.trigger_type !== 'comment' || run.trigger_instagram_comment_id === null) return null;
    return { instagramCommentId: run.trigger_instagram_comment_id, commentedAt: run.started_at };
  }

  /** Moves a running run to `toStep` with nothing sent. */
  private async moveRun({
    unit,
    call,
    run,
    toStep,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    run: AutomationRunRow;
    toStep: AutomationRunStep;
  }): Promise<AutomationRunRow> {
    const moved = await unit.runs.update({
      organizationId: call.organizationId,
      runId: run.id,
      changes: { current_step: toStep, last_step_at: new Date() },
    });
    return moved ?? run;
  }

  /** Claims a send on the locked run (AU19 step a): the kind, its time, the event. */
  private async claim({
    unit,
    call,
    run,
    messageKind,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    run: AutomationRunRow;
    messageKind: AutomationRunSendingMessageKind;
  }): Promise<AutomationRunRow> {
    const claimed = await unit.runs.update({
      organizationId: call.organizationId,
      runId: run.id,
      changes: {
        sending_message_kind: messageKind,
        sending_started_at: new Date(),
        last_instagram_event_key: call.event.eventKey,
      },
    });
    return claimed ?? run;
  }

  /** Clears the run's send claim. */
  private async clearClaim({
    unit,
    call,
    run,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    run: AutomationRunRow;
  }): Promise<AutomationRunRow> {
    const cleared = await unit.runs.update({
      organizationId: call.organizationId,
      runId: run.id,
      changes: { sending_message_kind: null, sending_started_at: null },
    });
    return cleared ?? run;
  }

  /** Writes `changes` to a comment log and returns it; nothing without one. */
  private async updateCommentLog({
    unit,
    call,
    commentLog,
    changes,
  }: {
    unit: AutomationRunRepositories;
    call: AutomationRunOrganization;
    commentLog: AutomationCommentLogRow | null;
    changes: AutomationCommentLogChanges;
  }): Promise<AutomationCommentLogRow | null> {
    if (commentLog === null) return null;
    return (
      (await unit.commentLogs.update({
        organizationId: call.organizationId,
        commentLogId: commentLog.id,
        changes,
      })) ?? commentLog
    );
  }

  /**
   * Fails the run (AU19, 3.B.9): `failed` with a text-free error message, the wait cleared, the
   * claim cleared unless its outcome is unknown (AQ5), a `status_changed` event, and its comment
   * log `failed` with the step and Instagram's error — in the caller's unit, so a DM or story-reply
   * run keeps its error after any rollback of a later unit (D16).
   */
  private async failRun({
    unit,
    call,
    run,
    commentLog,
    failure,
    isLoggedErrorKept = false,
  }: {
    unit: AutomationRunRepositories;
    call: AutomationRunOrganization;
    run: AutomationRunRow;
    commentLog: AutomationCommentLogRow | null;
    failure: AutomationRunFailure;
    /** Keep what the comment log already says went wrong; fill in the rest only (D47). */
    isLoggedErrorKept?: boolean;
  }): Promise<void> {
    const errorColumns: AutomationCommentLogChanges = {
      failed_step: failedCommentLogStep({ run, commentLog }),
      ...failureColumns(failure),
    };
    await unit.runs.update({
      organizationId: call.organizationId,
      runId: run.id,
      changes: {
        status: 'failed',
        failed_at: new Date(),
        error_message: describeFailure(failure),
        waiting_for: null,
        waiting_since_at: null,
        last_step_at: new Date(),
        ...(failure.isClaimKept ? {} : { sending_message_kind: null, sending_started_at: null }),
      },
    });
    await unit.runEvents.insertMany([
      {
        organizationId: call.organizationId,
        runId: run.id,
        eventType: 'status_changed',
        status: 'failed',
      },
    ]);
    await this.updateCommentLog({
      unit,
      call,
      commentLog,
      changes: {
        overall_status: 'failed',
        waiting_for: null,
        ...(isLoggedErrorKept ? unsetColumns({ commentLog, columns: errorColumns }) : errorColumns),
      },
    });
    logger.warn(
      {
        organizationPublicId: call.scope.organizationPublicId,
        runPublicId: run.public_id,
        errorType: failure.errorType,
        reason: failure.reason,
      },
      'app.automation_run.failed',
    );
  }

  /**
   * The run's failure for a send that did not deliver (3.B.9), or `null` for a temporary one that
   * is rethrown — on the event's last attempt a temporary error fails the run instead (AU19).
   */
  private failureOf({
    call,
    result,
  }: {
    call: AutomationRunCall;
    result: Exclude<AutomationSendResult, { outcome: 'delivered' }>;
  }): AutomationRunFailure | null {
    switch (result.outcome) {
      case 'temporary':
        return call.event.isLastAttempt
          ? {
              errorType: result.errorType,
              reason: failureReasonOf(result),
              error: result.error,
              isClaimKept: false,
            }
          : null;
      case 'refused':
        return {
          errorType: 'instagram_api',
          reason: failureReasonOf(result),
          error: result.error,
          isClaimKept: false,
        };
      case 'token':
        return {
          errorType: 'token',
          reason: failureReasonOf(result),
          error: result.error,
          isClaimKept: false,
        };
      case 'unknown':
        return {
          errorType: result.errorType,
          reason: failureReasonOf(result),
          error: result.error,
          isClaimKept: true,
        };
    }
  }

  /**
   * AU19 step c of a DM — in one unit, on the re-locked run: delivered → the claim cleared, the
   * contact's `last_message_sent_at`, then the run waits, moves on or completes (AU10: the
   * completed-run count and the contact's tags in the same unit); otherwise the failure, or the
   * claim cleared and a temporary error rethrown.
   */
  private async recordSend({
    unit,
    call,
    prepared,
    result,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    prepared: Extract<PreparedAction, { kind: 'send' }>;
    result: AutomationSendResult;
  }): Promise<RecordedAction> {
    const run = await unit.runs.lockById({
      organizationId: call.organizationId,
      runId: prepared.run.id,
    });
    if (run === null) return { kind: 'stop' };
    const commentLog =
      run.trigger_type === 'comment'
        ? await unit.commentLogs.findForRun({ organizationId: call.organizationId, runId: run.id })
        : null;
    const now = new Date();
    if (result.outcome === 'delivered') {
      await this.contactService.recordContactMessageSent({
        databaseHandle: unit.databaseHandle,
        organizationId: call.organizationId,
        contactId: run.contact_id,
        sentAt: now,
      });
      // A run cancelled while the message went (a delete, an erase) stays cancelled.
      if (run.status !== 'running') return { kind: 'stop' };
      await this.recordDelivered({ unit, call, run, commentLog, plan: prepared.plan, now });
      return prepared.plan.waitFor === null && prepared.plan.nextStep !== null
        ? { kind: 'continue' }
        : { kind: 'stop' };
    }
    return this.recordUndelivered({ unit, call, run, commentLog, result });
  }

  /** The run state after a delivered DM: waiting, the next step, or completed. */
  private async recordDelivered({
    unit,
    call,
    run,
    commentLog,
    plan,
    now,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    run: AutomationRunRow;
    commentLog: AutomationCommentLogRow | null;
    plan: Extract<AutomationRunStepPlan, { action: 'send' }>;
    now: Date;
  }): Promise<void> {
    const organizationId = call.organizationId;
    const logChanges = deliveredCommentLogChanges({
      messageKind: plan.messageKind,
      isWaiting: plan.waitFor !== null,
      now,
    });
    const cleared = { sending_message_kind: null, sending_started_at: null, last_step_at: now };
    if (plan.nextStep === null) {
      await this.completeRun({ unit, call, run, commentLog, logChanges, now });
      return;
    }
    if (plan.waitFor !== null) {
      await unit.runs.update({
        organizationId,
        runId: run.id,
        changes: {
          ...cleared,
          status: 'waiting',
          waiting_for: plan.waitFor,
          waiting_since_at: now,
        },
      });
      await unit.runEvents.insertMany([
        { organizationId, runId: run.id, eventType: 'status_changed', status: 'waiting' },
      ]);
      await this.updateCommentLog({
        unit,
        call,
        commentLog,
        changes: {
          ...logChanges,
          overall_status: 'waiting',
          waiting_for: plan.waitFor,
          current_step: commentLogStepOfMessage(plan.messageKind),
        },
      });
      return;
    }
    await unit.runs.update({
      organizationId,
      runId: run.id,
      changes: { ...cleared, current_step: plan.nextStep },
    });
    await this.updateCommentLog({
      unit,
      call,
      commentLog,
      changes: {
        ...logChanges,
        current_step: toCommentLogStep({ runStep: plan.nextStep, isPublicReplyPending: false }),
      },
    });
  }

  /**
   * Completes the run (AU18 step 6): `completed`, `completed_run_count + 1` in SQL (AU10), the
   * automation's tags — or its name when it has none — on the contact (CT10), a `status_changed`
   * event, the comment log `completed`.
   */
  private async completeRun({
    unit,
    call,
    run,
    commentLog,
    logChanges,
    now,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    run: AutomationRunRow;
    commentLog: AutomationCommentLogRow | null;
    logChanges: AutomationCommentLogChanges;
    now: Date;
  }): Promise<void> {
    const organizationId = call.organizationId;
    await unit.runs.update({
      organizationId,
      runId: run.id,
      changes: {
        status: 'completed',
        completed_at: now,
        current_step: 'final_dm',
        sending_message_kind: null,
        sending_started_at: null,
        waiting_for: null,
        waiting_since_at: null,
        last_step_at: now,
      },
    });
    await unit.automations.incrementCompletedRunCount({
      organizationId,
      automationId: run.automation_id,
    });
    const automation = await unit.automations.findByIdIncludingDeleted({
      organizationId,
      automationId: run.automation_id,
    });
    if (automation !== null) {
      await this.contactService.addContactTags({
        databaseHandle: unit.databaseHandle,
        organizationId,
        contactId: run.contact_id,
        tags: automation.tags.length > 0 ? automation.tags : [automation.name],
      });
    }
    await unit.runEvents.insertMany([
      { organizationId, runId: run.id, eventType: 'status_changed', status: 'completed' },
    ]);
    await this.updateCommentLog({
      unit,
      call,
      commentLog,
      changes: {
        ...logChanges,
        overall_status: 'completed',
        current_step: 'final_dm',
        waiting_for: null,
      },
    });
  }

  /** A DM that did not deliver: fail the run, or clear the claim and rethrow (AU19, 3.B.9). */
  private async recordUndelivered({
    unit,
    call,
    run,
    commentLog,
    result,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    run: AutomationRunRow;
    commentLog: AutomationCommentLogRow | null;
    result: Exclude<AutomationSendResult, { outcome: 'delivered' }>;
  }): Promise<RecordedAction> {
    if (run.status !== 'running') return { kind: 'stop' };
    const failure = this.failureOf({ call, result });
    if (failure === null) {
      await this.clearClaim({ unit, call, run });
      return { kind: 'rethrow', error: result.error };
    }
    await this.failRun({ unit, call, run, commentLog, failure });
    return {
      kind: 'failed',
      errorType: failure.errorType,
      ...(result.outcome === 'token' ? { tokenError: result.error } : {}),
    };
  }

  /**
   * AU19 step c of the public reply — any failure is logged and the flow goes on (3.B.9), except a
   * dead token, which fails the run.
   */
  private async recordPublicReply({
    unit,
    call,
    prepared,
    result,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    prepared: Extract<PreparedAction, { kind: 'public_reply' }>;
    result: AutomationSendResult;
  }): Promise<RecordedAction> {
    const run = await unit.runs.lockById({
      organizationId: call.organizationId,
      runId: prepared.run.id,
    });
    if (run === null) return { kind: 'stop' };
    const commentLog = await unit.commentLogs.findForRun({
      organizationId: call.organizationId,
      runId: run.id,
    });
    const now = new Date();
    if (result.outcome === 'token') {
      const failure: AutomationRunFailure = {
        errorType: 'token',
        reason: failureReasonOf(result),
        error: result.error,
        isClaimKept: false,
      };
      if (run.status === 'running') await this.failRun({ unit, call, run, commentLog, failure });
      return { kind: 'failed', errorType: 'token', tokenError: result.error };
    }
    if (run.status === 'running') await this.clearClaim({ unit, call, run });
    const changes: AutomationCommentLogChanges =
      result.outcome === 'delivered'
        ? { public_reply_status: 'sent', public_reply_text: prepared.text, public_reply_at: now }
        : {
            public_reply_status: 'failed',
            ...failureColumns({
              errorType: result.outcome === 'refused' ? 'instagram_api' : result.errorType,
              reason: failureReasonOf(result),
              error: result.error,
              isClaimKept: false,
            }),
          };
    await this.updateCommentLog({
      unit,
      call,
      commentLog,
      changes: { ...changes, current_step: 'opening_dm' },
    });
    return run.status === 'running' ? { kind: 'continue' } : { kind: 'stop' };
  }

  /**
   * After the follow read (AU18 step 3): following → saved on the contact and the step done;
   * not following (or unknown) → the request goes next; a dead token fails the run; a temporary
   * failure is rethrown, or fails the run on the event's last attempt.
   */
  private async recordFollowRead({
    unit,
    call,
    prepared,
    result,
  }: {
    unit: AutomationRunUnit;
    call: AutomationRunCall;
    prepared: Extract<PreparedAction, { kind: 'read_follow' }>;
    result: Awaited<ReturnType<AutomationRunMessageService['readFollowStatus']>>;
  }): Promise<RecordedAction> {
    const run = await unit.runs.lockById({
      organizationId: call.organizationId,
      runId: prepared.run.id,
    });
    if (run === null || run.status !== 'running') return { kind: 'stop' };
    const commentLog =
      run.trigger_type === 'comment'
        ? await unit.commentLogs.findForRun({ organizationId: call.organizationId, runId: run.id })
        : null;
    if (result.outcome !== 'read') {
      const isFailing = result.outcome === 'token' || call.event.isLastAttempt;
      if (!isFailing) return { kind: 'rethrow', error: result.error };
      const errorType = result.outcome === 'token' ? 'token' : result.errorType;
      await this.failRun({
        unit,
        call,
        run,
        commentLog,
        failure: {
          errorType,
          reason: 'follow_read_failed',
          error: result.error,
          isClaimKept: false,
        },
      });
      return {
        kind: 'failed',
        errorType,
        ...(result.outcome === 'token' ? { tokenError: result.error } : {}),
      };
    }
    const now = new Date();
    if (result.isFollowing !== null) {
      await this.contactService.recordContactProfile({
        databaseHandle: unit.databaseHandle,
        organizationId: call.organizationId,
        contactId: run.contact_id,
        profile: { isFollowingAccount: result.isFollowing },
        checkedAt: now,
      });
    }
    if (result.isFollowing !== true) return { kind: 'continue', isFollowNotConfirmed: true };
    await this.moveRun({ unit, call, run, toStep: 'email_collect' });
    const wasRequested = commentLog?.follow_status === 'waiting';
    await this.updateCommentLog({
      unit,
      call,
      commentLog,
      changes: wasRequested
        ? { follow_status: 'done', follow_confirmed_at: now, current_step: 'email_collect' }
        : { follow_status: 'skipped', current_step: 'email_collect' },
    });
    return { kind: 'continue' };
  }

  /**
   * Asks the email question again on the run waiting for it (AU17 (1), D18) — as a private reply to
   * the new comment, or a DM; the run keeps waiting.
   */
  private askEmailAgain({
    call,
    runId,
    privateReply,
  }: {
    call: AutomationRunCall;
    runId: number;
    privateReply: { instagramCommentId: string; commentedAt: Date } | null;
  }): Promise<AutomationRunHandlingResult> {
    return this.sendToWaitingRun({
      call,
      runId,
      messageKind: 'email_question',
      privateReply,
      outcome: 'question_asked_again',
    });
  }

  /**
   * One message to a waiting run — the question asked again, or the wrong-email text (AU17 (1),
   * AU18 step 4): claimed, sent, recorded; the run keeps waiting whatever happens. The claim is
   * cleared whatever the outcome, and the event key the claim set marks the message done, so it is
   * never re-sent — except after a temporary error (not delivered, 3.B.9), which puts the run's
   * previous event key back and is rethrown before the last attempt: the retry sends it. A dead
   * token marks the account broken.
   */
  private async sendToWaitingRun({
    call,
    runId,
    messageKind,
    privateReply,
    outcome,
  }: {
    call: AutomationRunCall;
    runId: number;
    messageKind: Extract<AutomationRunSendingMessageKind, 'email_question' | 'invalid_email'>;
    privateReply: { instagramCommentId: string; commentedAt: Date } | null;
    outcome: AutomationRunHandlingResult['outcome'];
  }): Promise<AutomationRunHandlingResult> {
    const prepared = await this.unit({
      call: call,
      work: async (unit) => {
        const run = await unit.runs.lockById({ organizationId: call.organizationId, runId });
        if (run === null || run.status !== 'waiting' || run.waiting_for !== 'email') return null;
        if (run.sending_message_kind !== null) return null;
        const contact = await this.contactService.findLiveContact({
          databaseHandle: unit.databaseHandle,
          organizationId: call.organizationId,
          contactId: run.contact_id,
        });
        const automation = await unit.automations.findByIdIncludingDeleted({
          organizationId: call.organizationId,
          automationId: run.automation_id,
        });
        if (contact === null || automation === null) return null;
        // Turned off since: not asked again — the run goes on after this event's handling (AU14).
        if (planWaitedStepNowOff({ waitingFor: 'email', automation }) !== null) return null;
        const recipient = resolveAutomationMessageRecipient({
          instagramUserId: call.instagramUserId,
          lastDirectMessageReceivedAt: contact.last_direct_message_received_at,
          privateReply,
          now: new Date(),
        });
        if (recipient === null) return null;
        const composed = this.messageService.composeMessage({
          messageKind,
          automation,
          automationPublicId: automation.public_id,
          runPublicId: run.public_id,
          accountUsername: call.access.username,
        });
        const claimed = await this.claim({ unit, call, run, messageKind });
        return {
          run: claimed,
          recipient,
          composed,
          previousEventKey: run.last_instagram_event_key,
        };
      },
    });
    if (prepared === null) return handlingResult({ outcome });
    const result = await this.messageService.sendDirectMessage({
      access: call.access,
      recipient: prepared.recipient,
      composed: prepared.composed,
      requestId: call.event.requestId,
    });
    const isRetried = result.outcome === 'temporary' && !call.event.isLastAttempt;
    await this.unit({
      call: call,
      work: async (unit) => {
        const run = await unit.runs.lockById({ organizationId: call.organizationId, runId });
        if (run === null) return;
        await unit.runs.update({
          organizationId: call.organizationId,
          runId,
          changes: {
            sending_message_kind: null,
            sending_started_at: null,
            ...(isRetried ? { last_instagram_event_key: prepared.previousEventKey } : {}),
          },
        });
        if (result.outcome === 'delivered') {
          await this.contactService.recordContactMessageSent({
            databaseHandle: unit.databaseHandle,
            organizationId: call.organizationId,
            contactId: run.contact_id,
            sentAt: new Date(),
          });
        }
      },
    });
    if (isRetried) throw result.error;
    if (result.outcome === 'token') {
      await this.markTokenBroken({ call: call, error: result.error });
      return handlingResult({
        outcome,
        runPublicIds: [prepared.run.public_id],
        failedErrorType: 'token',
      });
    }
    return handlingResult({ outcome, runPublicIds: [prepared.run.public_id] });
  }

  /** A dead token: the account's guarded status change and its reconnect notice (IA9, WC-11). */
  private async markTokenBroken({
    call,
    error,
  }: {
    call: AutomationRunCall;
    error: InstagramApiError;
  }): Promise<void> {
    await this.instagramAccountService.markConnectionBroken({
      scope: call.scope,
      instagramAccount: call.access.instagramAccount,
      connectionStatus: error.connectionStatus ?? 'error',
      requestId: call.event.requestId,
    });
  }
}
