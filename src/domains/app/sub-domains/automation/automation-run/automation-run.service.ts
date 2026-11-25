import { randomInt } from 'node:crypto';
import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type {
  ChannelActivityCursor,
  ChannelAnswerDelay,
  ChannelMessageResultInput,
  ChannelMessageStep,
  ChannelSendingPort,
  ChannelSendingPorts,
  SaveWaitingMessageResult,
} from '@/domains/app/app.channel-ports.js';
import type { ChannelAccountChannel } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import type {
  ChannelAccountPlanAccessService,
  ChannelAccountService,
} from '@/domains/app/sub-domains/channel-account/channel-account.service.js';
import type { AutomationRunChannelAccount } from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import type { ContactRow } from '@/domains/app/sub-domains/contact/contact.repository.js';
import type { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import type {
  ContactCollectedValueResult,
  ContactErasureStepInput,
  ContactPauseStepInput,
} from '@/domains/app/sub-domains/contact/contact.types.js';
import {
  AUTOMATION_COMMENT_TRIGGER_TYPES,
  type AutomationTriggerType,
} from '@/domains/app/sub-domains/automation/automation.constants.js';
import {
  AutomationRepository,
  type AutomationRow,
  createWorkerAutomationRepository,
} from '@/domains/app/sub-domains/automation/automation.repository.js';
import type { AutomationOpenRunCancelInput } from '@/domains/app/sub-domains/automation/automation.types.js';
import type { AutomationCountService } from '@/domains/app/sub-domains/automation/automation-count.service.js';
import type { AutomationReplyStateService } from '@/domains/app/sub-domains/automation/automation-reply-state.service.js';
import {
  AUTOMATION_PUBLIC_REPLY_CHANCE_PERCENT,
  AUTOMATION_PUBLIC_REPLY_CHANCE_SCALE,
  AUTOMATION_PUBLIC_REPLY_SKIP_REASONS,
  AUTOMATION_RUN_ASK_MAX_COUNT,
  AUTOMATION_RUN_CANCEL_REASONS,
  AUTOMATION_RUN_CHAT_WINDOW_MILLISECONDS,
  AUTOMATION_RUN_ERROR_MESSAGE_MAX_LENGTH,
  AUTOMATION_RUN_NUDGE_AFTER_MILLISECONDS,
  AUTOMATION_RUN_PART_DROP_AFTER_DAYS,
  AUTOMATION_TAG_CHAIN_MAX,
  type AutomationCommentLogIgnoredReason,
  type AutomationCommentLogStepStatus,
  type AutomationPublicReplySkipReason,
  type AutomationRunCancelReason,
  type AutomationRunStep,
  type AutomationRunWaitingFor,
} from './automation-run.constants.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import {
  type AutomationRunChanges,
  AutomationRunRepository,
  type AutomationEndedRun,
  type AutomationRunRow,
  createWorkerAutomationRunRepository,
} from './automation-run.repository.js';
import {
  type AutomationContactRunEventRow,
  AutomationRunEventRepository,
  type AutomationRunEventValues,
  createWorkerAutomationRunEventRepository,
} from './automation-run-event.repository.js';
import {
  type AutomationCommentLogChanges,
  AutomationCommentLogRepository,
  type AutomationCommentLogInsertValues,
  createWorkerAutomationCommentLogRepository,
} from './automation-comment-log.repository.js';
import {
  AutomationRunOpenKeyRepository,
  createRetentionAutomationRunOpenKeyRepository,
  createWorkerAutomationRunOpenKeyRepository,
} from './automation-run-open-key.repository.js';
import {
  type AutomationMatch,
  chooseCommentAutomation,
  chooseExactSourceAutomation,
  chooseMessageAutomation,
  chooseTagAutomation,
  matchesAutomationKeywords,
  pickEmailAnswer,
  pickPhoneAnswer,
} from './automation-run-matching.util.js';
import {
  type AutomationPlanSwitches,
  type AutomationRandomSource,
  buildOnceKey,
  followStepOf,
  helloHasNextButton,
  helloStepOf,
  isPlanSwitchOn,
  isSheMessagedFirst,
  messagesOf,
  organizationDayOf,
  pickVersionNumber,
  pickWordingNumber,
  questionStepOf,
  tagsOf,
  uploadPublicIdsOf,
} from './automation-run-step.util.js';
import type {
  AutomationButtonClickInput,
  AutomationTapKind,
  AutomationCommentRunInput,
  AutomationDirectMessageInput,
  AutomationRunEvent,
  AutomationRunHandlingOutcome,
  AutomationRunHandlingResult,
  AutomationRunTriggerInput,
  AutomationRunVersionNumbers,
  AutomationTagRunInput,
} from './automation-run.types.js';

/**
 * What the run engine is built from (4.B — wired by `app.container.ts`).
 *
 * @remarks
 * Notes: every dependency is channel-neutral (AUC13) — the account through the channel account,
 * the channel's sending through `sendingPorts` (AU35); tests pass a recording port and a fixed draw.
 */
export interface AutomationRunServiceDependencies {
  /** The channel account's run read (AU34) — the engine reaches no channel's own sub-domain. */
  channelAccountService: Pick<ChannelAccountService, 'readAutomationRunAccount'>;
  contactService: ContactService;
  /** The plan read — the PRO switches, read once per job (AU26, D57). */
  planAccessService: ChannelAccountPlanAccessService;
  countService: AutomationCountService;
  replyStateService: AutomationReplyStateService;
  /**
   * The channels' sending ports (AU35) — the container's record, filled per channel as its sending
   * sub-domain lands (Instagram's at ROUTE rows R19–R20); the engine picks one by the account's
   * `channel` at each call.
   */
  sendingPorts: ChannelSendingPorts;
  /** The draw of versions, wordings and the public reply chance; `crypto.randomInt` by default. */
  drawInteger?: AutomationRandomSource;
  /**
   * "When her chat opens" at her run's end (plan §27.15 rule 1, BC17 — ROUTE row R56): called in
   * the commit that ends her run `completed` (or cancelled by its wait, its expiry or the
   * automation's delete), after its open key is gone — the broadcasts' hook makes her waiting
   * recipient row when no other run of hers is open. Absent → nothing (unit tests).
   */
  runEndedHook?: AutomationRunEndedHook;
}

/**
 * The hook {@link AutomationRunServiceDependencies.runEndedHook} names: her contact on the account
 * whose run just ended, in that run's unit of work; answers how many rows it made.
 *
 * @remarks
 * Notes: the app container passes the broadcasts' `handleChatOpened` (ROUTE row R56); it runs in
 * the run's commit, after the open key is deleted, so its own open-run hold sees the run gone.
 */
export type AutomationRunEndedHook = (input: {
  databaseHandle: WorkerDatabaseHandle;
  organizationId: number;
  channelAccountId: number;
  contactId: number;
}) => Promise<number>;

/** The cancel reasons after which her chat may still take a "when her chat opens" broadcast. */
const RUN_END_HOOK_CANCEL_REASONS: ReadonlySet<AutomationRunCancelReason> = new Set([
  'wait_expired',
  'expired',
  'automation_deleted',
]);

/** The repositories of one unit of work, bound to its handle. */
interface AutomationRunRepositories {
  databaseHandle: WorkerDatabaseHandle;
  runs: AutomationRunRepository;
  runEvents: AutomationRunEventRepository;
  commentLogs: AutomationCommentLogRepository;
  openKeys: AutomationRunOpenKeyRepository;
  automations: AutomationRepository;
}

/** One unit of the engine: the organization, the account, the plan, the port and her locked row. */
interface AutomationRunUnit extends AutomationRunRepositories {
  scope: OrganizationPrincipalDatabaseScope;
  organizationId: number;
  channelAccountId: number;
  switches: AutomationPlanSwitches;
  port: ChannelSendingPort;
  /** Her live contact, locked `FOR KEY SHARE` until the unit ends (CT8). */
  contact: ContactRow;
  now: Date;
  /** The wait of the messages this unit saves without a `notBefore` (plan §30.2 step 13); absent → by the unit. */
  answerDelay?: ChannelAnswerDelay | undefined;
}

/**
 * The wait of a message the unit saves without a `notBefore` (plan §30.2 step 13, §30.12): the first
 * answer to her DM, tap or story reply (`answer`, with the PRO extra delay) — never to a comment, which
 * the box times — else the random delay (`next`), unless the unit says otherwise.
 */
function answerDelayOf(unit: AutomationRunUnit | AutomationRunEventUnit): ChannelAnswerDelay {
  if (unit.answerDelay !== undefined) return unit.answerDelay;
  if (!('event' in unit)) return 'next';
  return unit.event.eventKey.includes('comment') ? 'next' : 'answer';
}

/** The unit of an event: the unit plus the account's rules and the event. */
interface AutomationRunEventUnit extends AutomationRunUnit {
  account: AutomationRunChannelAccount;
  event: AutomationRunEvent;
}

/** How a run ends (AU21). */
type AutomationRunEnd =
  | { status: 'completed' }
  | { status: 'failed'; errorMessage: string }
  | { status: 'cancelled'; reason: AutomationRunCancelReason };

/** A message the engine asks its channel to save (AU35): its step and content by reference. */
interface AutomationWaitingMessage {
  step: ChannelMessageStep;
  messageNumber?: number | null;
  versionNumber?: number | null;
  wordingNumber?: number | null;
  messageKind?: string;
  stepPath: string;
  uploadPublicIds?: readonly string[];
  notBefore?: Date | null;
  answersEventId?: string | null;
}

/** The run steps whose message holds the run until its result (the hello and the DM steps). */
type AutomationBlockingStep = Exclude<
  ChannelMessageStep,
  'public_reply' | 'hide_comment' | 'nudge' | 'broadcast'
>;

/** The comment log's step and status column of each run step. */
const COMMENT_LOG_STEP_OF_RUN_STEP = {
  keyword_match: { step: 'opening_dm', status: 'opening_dm_status' },
  comment_reply: { step: 'opening_dm', status: 'opening_dm_status' },
  follow_check: { step: 'follow_check', status: 'follow_status' },
  email_collect: { step: 'email_collect', status: 'email_status' },
  phone_collect: { step: 'phone_collect', status: 'phone_status' },
  messages: { step: 'messages', status: 'messages_status' },
} as const satisfies Record<AutomationRunStep, { step: string; status: string }>;

/** The result a call answers when nothing was moved. */
function handlingResult({
  outcome,
  runPublicIds = [],
}: {
  outcome: AutomationRunHandlingOutcome;
  runPublicIds?: string[];
}): AutomationRunHandlingResult {
  return { outcome, runPublicIds, failedErrorType: null };
}

/** Whether a way to start carries a comment (the public reply, the hide, the comment log). */
function isCommentTrigger(triggerType: string): boolean {
  return AUTOMATION_COMMENT_TRIGGER_TYPES.includes(triggerType as AutomationTriggerType);
}

/** Whether her chat window is open now (plan §9): her last message or tap + 24 h − 15 min. */
function isChatOpen({ contact, now }: { contact: ContactRow; now: Date }): boolean {
  const last = contact.last_direct_message_received_at;
  return last !== null && now.getTime() - last.getTime() < AUTOMATION_RUN_CHAT_WINDOW_MILLISECONDS;
}

/** The start of the comment-log months a comment's logs are read in (AU28: the last two). */
function lastTwoMonthsStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
}

/** A short, text-free error message: `<step>:<reason>`. */
function describeFailure({ step, reason }: { step: string; reason: string | null }): string {
  return `${step}:${reason ?? 'failed'}`.slice(0, AUTOMATION_RUN_ERROR_MESSAGE_MAX_LENGTH);
}

/** The run's key as its statements name it. */
function runKeyOf({ organizationId, run }: { organizationId: number; run: AutomationRunRow }) {
  return { organizationId, runId: run.id, runStartedAt: run.started_at };
}

/** The run's cancel reason for a channel's skip reason, or `null` when the run fails instead. */
function cancelReasonOfSkip(reason: string | null): AutomationRunCancelReason | null {
  if (reason === 'live_ended' || reason === 'reply_too_old') return 'expired';
  if (reason === 'paused_by_owner') return 'contact_excluded';
  return (AUTOMATION_RUN_CANCEL_REASONS as readonly string[]).includes(reason ?? '')
    ? (reason as AutomationRunCancelReason)
    : null;
}

/** The text an exact-source tap carries: the starter question, the ig.me ref code or the ad id. */
function exactSourceValueOf({
  kind,
  input,
}: {
  kind: Exclude<AutomationTapKind, 'postback' | 'broadcast_tap'>;
  input: AutomationButtonClickInput;
}): string | null | undefined {
  if (kind === 'starter_question') return input.starterQuestion;
  if (kind === 'ref_link') return input.refCode;
  return input.adId;
}

/**
 * The run engine (feat-instagram-dm-sending routes-final § 4.B, AU21–AU30, AU35–AU37): which
 * automation an event starts, the once key and the one open run per automation and person, the steps
 * of `steps` saved as **waiting messages** through the channel's `ChannelSendingPort` — it decides,
 * it never sends (WC-9 removed) — the results that come back (`recordMessageResult`), the taps and
 * answers, the counts, and the cancels other sub-domains run (delete, erase, pause, the 7-day wait).
 *
 * @remarks
 * Algorithm:
 * - **Entry points** (4.B.10, the inbound seam): `startCommentRun`, `handleDirectMessage`,
 *   `handleButtonClick`, `startTagRun` — called by the channel's intake (Instagram's 5, intake per
 *   kind at ROUTE row R38) outside any database context, with the job's organization scope, the
 *   account's public id, the contact and a normalized event. Each reads the account and the plan's
 *   PRO switches once, then does **all of its work in one unit of work** — no call to the channel
 *   happens here, so the run, its key, events, comment log, counts, contact changes and the waiting
 *   messages commit together. `recordMessageResult` (the outbound seam's way back) runs inside the
 *   channel's result commit.
 * - **Lock order** (D47): her contact `FOR KEY SHARE` first (`lockLiveContact` — an erased contact
 *   writes nothing, CT9), then the automations of her open runs and the chosen automation
 *   `FOR KEY SHARE`, then the runs `FOR UPDATE`.
 * - **Choice:** a comment — one automation, post-linked first, the oldest; every other match logged
 *   `comment_already_answered`; a message — her waiting run first (a tap, an answer, `any`), then the
 *   exact source, the keyword or kind, her first DM, "no other automation answered" (plan §4.3).
 * - **The once rule** (AU22): the start's once key; a DM already sent for (automation, person, key)
 *   → `ignored` · `once_per_post`. **One open run** (AU23, AU37): the open-key insert is the guard —
 *   an allowed new comment (another post, or "every time") replaces her open run (`replaced`, its
 *   waiting messages skipped through the port) in the same commit; any other start while it is open
 *   is `ignored` · `run_in_progress`.
 * - **Steps** (AU24): hello → (comments: public reply → hide, after the first DM is `sent`) → her tap
 *   or any text (a nudge after 60 min when she messaged first) → follow check → follow ask → email →
 *   phone → messages 1–N (`not_before` = now + its wait) → tags → `completed`. Each step is one waiting
 *   message; its result moves the run on. An `unknown` result is never sent again by itself: the run
 *   waits for `any` (D17, AU25). PRO parts read the plan's switches (AU26): without them the email and
 *   phone steps are skipped, "Reply like a person" works as off, only version 1 is picked.
 * - **Counts** (AU27): `runs_started` at the start, a hello tap `taps`, her first text while the run
 *   waits for the hello's tap `typed_answers` — each with its hello version — in the event's commit.
 *
 * Failure modes: a database error propagates (a temporary failure for the intake, which retries the
 * event; nothing of the event was written). A channel without a wired sending port throws.
 *
 * Side effects: writes `app.automation_runs`, `app.automation_run_events`,
 * `app.automation_comment_logs`, `app.automation_run_open_keys`, `app.automation_counts`, the reply
 * state, the automation's `last_triggered_at` and the contact (sub-domain 3); the channel's waiting
 * messages through its port. No audit entry. Log lines carry public ids and counts only (K7).
 */
export class AutomationRunService {
  private readonly drawInteger: AutomationRandomSource;

  constructor(private readonly dependencies: AutomationRunServiceDependencies) {
    this.drawInteger = dependencies.drawInteger ?? ((maxExclusive) => randomInt(maxExclusive));
  }

  // ── Entry points (4.B.10) ────────────────────────────────────────────────────────────────

  /**
   * A comment, Live comment or ad comment (AU22, AU23, AU28; plan §4.4): one automation answers it —
   * its run started, or its reason logged — and every other match is logged
   * `comment_already_answered`.
   *
   * @remarks
   * Algorithm: one unit — a comment whose logs exist (the last two months) is `already_handled`;
   * else the choice, then the gates in order: the account's own comment (`own_comment`), a reply
   * under another comment with the account's switch off (`thread_reply_off`, D64), her automations
   * paused (`contact_excluded`), her stop word (only a keyword comment restarts her, D49), another
   * automation's run waiting for her email (`waiting_for_other_email`), the once key
   * (`once_per_post`), her open run (the same once key → `once_per_post`; else replaced, P35). Then
   * the run, its key and the logs, and its first step. Failure modes and side effects: as the class.
   */
  async startCommentRun(input: AutomationCommentRunInput): Promise<AutomationRunHandlingResult> {
    return this.withEventUnit({
      input,
      work: (unit) => this.handleComment({ unit, input }),
    });
  }

  /**
   * A message event — a DM, a story reply or mention, a shared post (plan §4.3): first her run that
   * waits for it (an email, a phone, the hello's tap as typed text, `any`), else the one automation
   * it starts.
   *
   * @remarks
   * Algorithm: one unit — an event that already moved a run is `already_handled`; her waiting runs
   * (email first, then phone, then the oldest); else the match order of plan §4.3 levels 3–5 with the
   * once key and the one open run (`run_in_progress`). Failure modes and side effects: as the class.
   */
  async handleDirectMessage(
    input: AutomationDirectMessageInput,
  ): Promise<AutomationRunHandlingResult> {
    return this.withEventUnit({
      input,
      work: (unit) => this.handleMessage({ unit, input }),
    });
  }

  /**
   * A tap (plan §4.3 levels 1–2): our button's postback `<aut_…>::<run_…>` moves that run (the hello's
   * tap, the "I'm following" tap, or a step that waits for `any`); a starter question, an ig.me link
   * or an ad's "Send message" starts the automation it names (a paused starter question falls through
   * to a message with its text, rule 5).
   *
   * @remarks
   * Algorithm: one unit. A postback on a run that is not waiting, of another contact, of a deleted
   * automation or of another account is `ignored`. Failure modes and side effects: as the class.
   */
  async handleButtonClick(input: AutomationButtonClickInput): Promise<AutomationRunHandlingResult> {
    return this.withEventUnit({
      input,
      work: (unit) => this.handleTap({ unit, input }),
    });
  }

  /**
   * A tag added to or removed from her (3.B's tag event, D45): the oldest live automation of that
   * change and tag starts — never the automation whose tag step made it, never at chain number
   * {@link AUTOMATION_TAG_CHAIN_MAX}, and only while her chat window is open.
   *
   * @remarks
   * Algorithm: one unit — the choice, the window, the once key (`tag:<tag>:<event id>`) and the open
   * run. Called by the tag intake (ROUTE row R38). Failure modes and side effects: as the class.
   */
  async startTagRun(input: AutomationTagRunInput): Promise<AutomationRunHandlingResult> {
    return this.withEventUnit({
      input,
      work: async (unit) => {
        if (input.chainNumber >= AUTOMATION_TAG_CHAIN_MAX)
          return handlingResult({ outcome: 'ignored' });
        if (await this.isEventHandled(unit)) return handlingResult({ outcome: 'already_handled' });
        const candidates = await unit.automations.listRunCandidates({
          organizationId: unit.organizationId,
          channelAccountId: unit.channelAccountId,
        });
        const match = chooseTagAutomation({
          candidates,
          change: input.change,
          tag: input.tag,
          sourceAutomationId: input.sourceAutomationId,
        });
        if (match === null) return handlingResult({ outcome: 'nothing_matched' });
        if (!isChatOpen({ contact: unit.contact, now: unit.now })) {
          logger.info(
            { organizationPublicId: unit.scope.organizationPublicId, reason: 'window_closed' },
            'app.automation_run.tag_start_skipped',
          );
          return handlingResult({ outcome: 'ignored' });
        }
        return this.startFromMatch({
          unit,
          match,
          eventId: String(input.tagEventId),
          targets: { tag: input.tag },
          versionExtras: { tag_chain: input.chainNumber },
        });
      },
    });
  }

  /**
   * The owner's retry's run step (plan §33.10 rule 4, WC-42 — ROUTE row R46): each run that ended
   * `failed` and has a message going back to `waiting` "waits for this step again" — `running`, its
   * failure cleared, a `status_changed` event — and its open-run key is added again (P100), in the
   * retry piece's commit. A run that is no longer `failed`, or whose automation and person hold
   * another open run's key, is left as it is.
   *
   * @remarks
   * Algorithm: per run, the run locked (still `failed`?), then its key `INSERT … ON CONFLICT DO
   * NOTHING` — a conflict (another run of the automation and person is open) leaves the run
   * `failed`, so the one-open-run rule holds — then the run `running` and its event. The caller holds
   * her contact's lock (the lock order). Answers how many runs were reopened. Failure
   * modes: database errors roll the piece back. Side effects: the runs, their events and keys.
   */
  async reopenRetriedRuns({
    databaseHandle,
    organizationId,
    runs,
  }: {
    databaseHandle: WorkerDatabaseHandle;
    organizationId: number;
    runs: ReadonlyArray<{ runId: number; runStartedAt: Date }>;
  }): Promise<number> {
    const repositories = this.bindRepositories(databaseHandle);
    let reopenedCount = 0;
    for (const { runId, runStartedAt } of runs) {
      const key = { organizationId, runId, runStartedAt };
      const failed = await repositories.runs.lockByKey(key);
      if (failed === null || failed.status !== 'failed') continue;
      const isKeyAdded = await repositories.openKeys.insert({
        organizationId,
        automationId: failed.automation_id,
        contactId: failed.contact_id,
        runId,
        runStartedAt,
      });
      if (!isKeyAdded) continue;
      await repositories.runs.update({
        ...key,
        changes: {
          status: 'running',
          failed_at: null,
          error_message: null,
          last_step_at: new Date(),
        },
      });
      await repositories.runEvents.insertMany([
        { ...key, eventType: 'status_changed', status: 'running' },
      ]);
      reopenedCount += 1;
    }
    return reopenedCount;
  }

  /**
   * The outbound seam's way back (AU35): a waiting message's final result — `sent`, `failed`,
   * `skipped` or `unknown` — reported by the channel's sending sub-domain **in the commit of the
   * message's final status**. The engine moves the run on: the next step, the public reply and hide
   * after the first DM of a comment, the wait for her tap or answer, completion; an `unknown` waits
   * for `any` (D17); a failed step fails the run; a skipped one cancels it with its reason. A repeat
   * call for a settled message, or for a run that moved on, does nothing.
   *
   * @remarks
   * Algorithm: joins the caller's unit (`withAppDatabaseContext` with its scope); her contact, then the
   * run's automation, then the run locked. Failure modes: a database error rolls the caller's commit
   * back. Side effects: as the class.
   */
  async recordMessageResult(input: ChannelMessageResultInput): Promise<void> {
    await withAppDatabaseContext({
      scope: input.scope,
      callback: async (databaseHandle) => {
        const repositories = this.bindRepositories(databaseHandle);
        const key = {
          organizationId: input.organizationId,
          runId: input.automationRunId,
          runStartedAt: input.automationRunStartedAt,
        };
        const runCopy = await repositories.runs.findByKey(key);
        if (runCopy === null) return;
        const contact = await this.dependencies.contactService.lockLiveContact({
          databaseHandle,
          organizationId: input.organizationId,
          contactId: runCopy.contact_id,
        });
        if (contact === null) return;
        await repositories.automations.lockForRunChanges({
          organizationId: input.organizationId,
          automationIds: [runCopy.automation_id],
        });
        const run = await repositories.runs.lockByKey(key);
        const automation = await repositories.automations.findByIdIncludingDeleted({
          organizationId: input.organizationId,
          automationId: runCopy.automation_id,
        });
        if (run === null || automation === null) return;
        if (run.status !== 'running' && run.status !== 'waiting') return;
        const port = this.dependencies.sendingPorts[automation.channel as ChannelAccountChannel];
        if (port === undefined) return;
        const unit: AutomationRunUnit = {
          ...repositories,
          scope: input.scope,
          organizationId: input.organizationId,
          channelAccountId: input.channelAccountId,
          switches: await this.readPlanSwitches(input.scope),
          port,
          contact,
          now: input.occurredAt,
        };
        await this.applyResult({ unit, run, automation, input });
      },
    });
  }

  /**
   * Her runs' history for a contact's "what happened" (routes-final § 3.A CT14, route 24): run
   * events newest first, after the keyset `(occurred_at, source, id)` — each with its automation and
   * run ids; never a collected value.
   *
   * @remarks
   * Algorithm: one read in the scope's unit. Failure modes: none of its own. Side effects: none.
   */
  async listContactRunEvents({
    scope,
    organizationId,
    contactId,
    after,
    limit,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    contactId: number;
    after: ChannelActivityCursor | null;
    limit: number;
  }): Promise<AutomationContactRunEventRow[]> {
    return withAppDatabaseContext({
      scope,
      callback: (databaseHandle) =>
        new AutomationRunEventRepository(databaseHandle).listForContact({
          organizationId,
          contactId,
          after,
          limit,
        }),
    });
  }

  /**
   * The automation delete's open-run cancel (AU29) — registered with the automation service by the
   * app container; runs inside route 31's unit, which holds the automation `FOR UPDATE`. Cancels its
   * open runs (`automation_deleted`), deletes their open keys, writes their events and logs.
   * Answers how many. (The waiting messages are cancelled by the automation service through the
   * port.)
   *
   * @remarks
   * Algorithm: one update joining the route's unit. Failure modes: a database error rolls the delete
   * back. Side effects: the runs, keys, events and logs.
   */
  async cancelAutomationOpenRuns({
    organizationId,
    automationId,
  }: AutomationOpenRunCancelInput): Promise<number> {
    const repositories = this.bindRouteRepositories();
    const cancelled = await repositories.runs.cancelOpenRunsOfAutomation({
      organizationId,
      automationId,
    });
    await this.recordEndedRuns({
      repositories,
      organizationId,
      ended: cancelled,
      status: 'cancelled',
    });
    return cancelled.length;
  }

  /**
   * The contact erase's step (AU29, CT8) — runs inside route 23's unit, before the contact is
   * anonymised: her open runs `cancelled` · `contact_deleted` (keys deleted, events and logs written),
   * then every comment log's personal copies cleared (her free text is never on a run, D46).
   *
   * @remarks
   * Algorithm: the automations of her open runs locked `FOR KEY SHARE` (D47), the cancel, the erase.
   * Failure modes: a database error rolls the erase back. Side effects: the writes above.
   */
  async eraseContactRunCopies({
    organizationId,
    contactId,
  }: ContactErasureStepInput): Promise<void> {
    const repositories = this.bindRouteRepositories();
    await this.cancelOpenRunsOfContact({
      repositories,
      organizationId,
      contactId,
      reason: 'contact_deleted',
    });
    await repositories.commentLogs.eraseContactCopies({ organizationId, contactId });
  }

  /**
   * The contact pause step (AU29, CTC4, D71, D49) — runs inside the commit that pauses her
   * automations (`contact_excluded`) or records her stop word (`opted_out`): her open runs `cancelled`
   * with that reason, keys deleted, events and logs written; on the job's handle when one is given.
   *
   * @remarks
   * Algorithm: as the erase's cancel. Failure modes: a database error rolls the pause back. Side
   * effects: the cancelled runs, keys, events and logs.
   */
  async cancelContactOpenRuns({
    organizationId,
    contactId,
    reason,
    databaseHandle,
  }: ContactPauseStepInput): Promise<void> {
    const repositories =
      databaseHandle === undefined
        ? this.bindRouteRepositories()
        : this.bindRepositories(databaseHandle);
    await this.cancelOpenRunsOfContact({ repositories, organizationId, contactId, reason });
  }

  /**
   * The 7-day wait's cancel (WC-45, CHANGED — P99, P100): one organization's runs the hourly scan
   * found, in its job's unit — each still waiting since before the cutoff is `cancelled` ·
   * `wait_expired`, **its open key deleted in the same commit**, its event and log written, its
   * waiting messages cancelled through its channel's port. Answers how many.
   *
   * @remarks
   * Algorithm: one conditional update (`SKIP LOCKED` — a run another transaction holds stays due the
   * next hour), then the keys, events, logs and the port. Failure modes: a database error rolls the
   * organization's cancel back. Side effects: as described. Safe to repeat.
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
    const repositories = this.bindRepositories(databaseHandle);
    const cancelled = await repositories.runs.cancelExpiredWaitingRuns({
      organizationId,
      runIds,
      waitingSinceBefore,
    });
    await this.recordEndedRuns({
      repositories,
      organizationId,
      ended: cancelled,
      status: 'cancelled',
    });
    for (const run of cancelled) {
      const automation = await repositories.automations.findByIdIncludingDeleted({
        organizationId,
        automationId: run.automation_id,
      });
      const port =
        automation === null
          ? undefined
          : this.dependencies.sendingPorts[automation.channel as ChannelAccountChannel];
      await port?.cancelWaitingMessages({
        databaseHandle,
        organizationId,
        by: 'run',
        id: run.id,
        reason: 'wait_expired',
      });
    }
    return cancelled.length;
  }

  /**
   * The repair duty of the open keys (WC-67, P100, P94): removes up to `limit` keys of every
   * organization whose run has ended — a missed delete never blocks her for good. Its own repeat job
   * on sub-domain 6's repair queue (40 s budget) is scheduled by ROUTE row R47. Answers how many.
   *
   * @remarks
   * Algorithm: one delete on a retention handle (the sweep arm), `SKIP LOCKED`. Failure modes: a
   * database error propagates. Side effects: deletes keys only.
   */
  async repairOpenRunKeys({
    databaseHandle,
    limit,
  }: {
    databaseHandle: WorkerDatabaseHandle;
    limit: number;
  }): Promise<number> {
    return createRetentionAutomationRunOpenKeyRepository(databaseHandle).deleteKeysOfEndedRuns({
      limit,
    });
  }

  // ── Units ────────────────────────────────────────────────────────────────────────────────

  /** The repositories of a job's unit. */
  private bindRepositories(databaseHandle: WorkerDatabaseHandle): AutomationRunRepositories {
    return {
      databaseHandle,
      runs: createWorkerAutomationRunRepository(databaseHandle),
      runEvents: createWorkerAutomationRunEventRepository(databaseHandle),
      commentLogs: createWorkerAutomationCommentLogRepository(databaseHandle),
      openKeys: createWorkerAutomationRunOpenKeyRepository(databaseHandle),
      automations: createWorkerAutomationRepository(databaseHandle),
    };
  }

  /** The repositories joining a route's own unit (no handle). */
  private bindRouteRepositories(): Omit<AutomationRunRepositories, 'databaseHandle'> {
    return {
      runs: new AutomationRunRepository(),
      runEvents: new AutomationRunEventRepository(),
      commentLogs: new AutomationCommentLogRepository(),
      openKeys: new AutomationRunOpenKeyRepository(),
      automations: new AutomationRepository(),
    };
  }

  /** The plan's feature switches (P83), or `null` when the organization has no readable plan. */
  private async readPlanSwitches(
    scope: OrganizationPrincipalDatabaseScope,
  ): Promise<AutomationPlanSwitches> {
    const planAccess = await this.dependencies.planAccessService.getPlanAccess({
      organizationPublicId: scope.organizationPublicId,
    });
    return planAccess.features?.feature_switches ?? null;
  }

  /**
   * An event's one unit: the account read once (this organization's connected account, the contact
   * of that account), the plan's switches once, then the work with her contact locked and the
   * automations of her open runs locked (D47).
   */
  private async withEventUnit({
    input,
    work,
  }: {
    input: AutomationRunTriggerInput;
    work: (unit: AutomationRunEventUnit) => Promise<AutomationRunHandlingResult>;
  }): Promise<AutomationRunHandlingResult> {
    const account = await this.dependencies.channelAccountService.readAutomationRunAccount({
      scope: input.scope,
      channelAccountPublicId: input.channelAccountPublicId,
    });
    // An `error` (or stopped) account still decides: its messages wait in its stopped lanes (WH3).
    if (
      account === null ||
      account.connection_status === 'revoked' ||
      input.contact.channel_account_id !== account.id
    ) {
      logger.info(
        {
          organizationPublicId: input.scope.organizationPublicId,
          channelAccountPublicId: input.channelAccountPublicId,
          connectionStatus: account?.connection_status ?? null,
        },
        'app.automation_run.account_unavailable',
      );
      return handlingResult({ outcome: 'account_unavailable' });
    }
    const port = this.dependencies.sendingPorts[account.channel];
    if (port === undefined) {
      throw new Error(`automation run engine: no sending port wired for ${account.channel}`);
    }
    const switches = await this.readPlanSwitches(input.scope);
    return withAppDatabaseContext({
      scope: input.scope,
      callback: async (databaseHandle) => {
        const repositories = this.bindRepositories(databaseHandle);
        const contact = await this.dependencies.contactService.lockLiveContact({
          databaseHandle,
          organizationId: account.organizationId,
          contactId: input.contact.id,
        });
        if (contact === null) return handlingResult({ outcome: 'ignored' });
        await repositories.automations.lockForRunChanges({
          organizationId: account.organizationId,
          automationIds: await repositories.openKeys.listAutomationIdsOfContact({
            organizationId: account.organizationId,
            contactId: contact.id,
          }),
        });
        return work({
          ...repositories,
          scope: input.scope,
          organizationId: account.organizationId,
          channelAccountId: account.id,
          switches,
          port,
          contact,
          now: new Date(),
          account,
          event: input.event,
        });
      },
    });
  }

  /** Whether this event already moved a run of hers (a retry — its commit holds all of its work). */
  private isEventHandled(unit: AutomationRunEventUnit): Promise<boolean> {
    return unit.runs.hasRunMovedByEvent({
      organizationId: unit.organizationId,
      contactId: unit.contact.id,
      eventKey: unit.event.eventKey,
      since: new Date(
        unit.now.getTime() - (AUTOMATION_RUN_PART_DROP_AFTER_DAYS + 31) * MILLISECONDS_PER_DAY,
      ),
    });
  }

  // ── Comments ─────────────────────────────────────────────────────────────────────────────

  /** A comment's own handling ({@link startCommentRun}). */
  private async handleComment({
    unit,
    input,
  }: {
    unit: AutomationRunEventUnit;
    input: AutomationCommentRunInput;
  }): Promise<AutomationRunHandlingResult> {
    const since = lastTwoMonthsStart(unit.now);
    const existingLogs = await unit.commentLogs.listForComment({
      organizationId: unit.organizationId,
      commentId: input.commentId,
      since,
    });
    if (existingLogs.length > 0) return handlingResult({ outcome: 'already_handled' });
    const candidates = await unit.automations.listRunCandidates({
      organizationId: unit.organizationId,
      channelAccountId: unit.channelAccountId,
    });
    const { chosen, otherMatches } = chooseCommentAutomation({
      candidates,
      kind: input.kind,
      mediaId: input.mediaId,
      adId: input.adId ?? null,
      mediaPublishedAt: input.mediaPublishedAt ?? null,
      text: input.text,
    });
    if (chosen === null) return handlingResult({ outcome: 'nothing_matched' });
    const logOf = ({
      automation,
      run,
      ignoredReason,
    }: {
      automation: AutomationRow;
      run: AutomationRunRow | null;
      ignoredReason: AutomationCommentLogIgnoredReason | null;
    }): AutomationCommentLogInsertValues => ({
      organizationId: unit.organizationId,
      automationId: automation.id,
      automationName: automation.name,
      automationRun: run === null ? null : { id: run.id, startedAt: run.started_at },
      contactId: unit.contact.id,
      mediaId: input.mediaId,
      commentId: input.commentId,
      commentOccurredAt: input.event.occurredAt,
      commentText: input.text,
      commenterUsername: input.commenterUsername,
      commenterUserId: unit.contact.instagram_user_id,
      overallStatus: ignoredReason === null ? 'started' : 'ignored',
      ignoredReason,
    });
    const writeLogs = async ({
      run,
      ignoredReason,
    }: {
      run: AutomationRunRow | null;
      ignoredReason: AutomationCommentLogIgnoredReason | null;
    }) => {
      await unit.commentLogs.insertMany([
        logOf({ automation: chosen.automation, run, ignoredReason }),
        ...otherMatches.map((automation) =>
          logOf({ automation, run: null, ignoredReason: 'comment_already_answered' }),
        ),
      ]);
    };
    const gate = await this.commentGate({ unit, input, match: chosen });
    if (gate === 'opted_out') return handlingResult({ outcome: 'ignored' });
    if (gate !== null) {
      await writeLogs({ run: null, ignoredReason: gate });
      return handlingResult({ outcome: 'comment_logged' });
    }
    const started = await this.startRun({
      unit,
      match: chosen,
      eventId: input.commentId,
      targets: { mediaId: input.mediaId, commentId: input.commentId, adId: input.adId ?? null },
      isReplaceAllowed: true,
      beforeFirstStep: (run) => writeLogs({ run, ignoredReason: null }),
    });
    if (started.kind === 'held') {
      await writeLogs({ run: null, ignoredReason: started.reason });
      return handlingResult({ outcome: 'comment_logged' });
    }
    if (started.kind === 'gone') return handlingResult({ outcome: 'ignored' });
    logger.info(
      {
        organizationPublicId: unit.scope.organizationPublicId,
        runPublicId: started.run.public_id,
        isReplacement: started.isReplacement,
        alreadyAnsweredCount: otherMatches.length,
      },
      'app.automation_run.comment_matched',
    );
    return handlingResult({
      outcome: started.isReplacement ? 'run_replaced' : 'run_started',
      runPublicIds: [started.run.public_id],
    });
  }

  /**
   * The comment's gates before a run may start (AU28; plan §4.4): `null` when it may; an ignored
   * reason to log; `opted_out` — nothing is written.
   */
  private async commentGate({
    unit,
    input,
    match,
  }: {
    unit: AutomationRunEventUnit;
    input: AutomationCommentRunInput;
    match: AutomationMatch<AutomationRow>;
  }): Promise<AutomationCommentLogIgnoredReason | 'opted_out' | null> {
    if (input.isOwnComment === true) return 'own_comment';
    const isThreadReply = (input.parentCommentId ?? null) !== null;
    if (isThreadReply && !unit.account.is_comment_reply_trigger_enabled) return 'thread_reply_off';
    if (unit.contact.automations_off_at !== null) return 'contact_excluded';
    if (unit.contact.opted_out_at !== null) {
      // Only a keyword comment restarts her (D49).
      if (match.automation.keywords.length === 0) return 'opted_out';
      await this.dependencies.contactService.clearContactOptOut({
        databaseHandle: unit.databaseHandle,
        organizationId: unit.organizationId,
        contactId: unit.contact.id,
      });
    }
    const emailWaits = await unit.runs.lockWaitingRunsOfContact({
      organizationId: unit.organizationId,
      contactId: unit.contact.id,
      waitingFor: ['email'],
    });
    if (emailWaits.some((run) => run.automation_id !== match.automation.id)) {
      return 'waiting_for_other_email';
    }
    return null;
  }

  // ── Messages and taps ────────────────────────────────────────────────────────────────────

  /** A message event's own handling ({@link handleDirectMessage}). */
  private async handleMessage({
    unit,
    input,
  }: {
    unit: AutomationRunEventUnit;
    input: AutomationDirectMessageInput;
  }): Promise<AutomationRunHandlingResult> {
    if (await this.isEventHandled(unit)) return handlingResult({ outcome: 'already_handled' });
    if (input.kind === 'message') {
      const answered = await this.answerWaitingRun({ unit, input });
      if (answered !== null) return answered;
    }
    const candidates = await unit.automations.listRunCandidates({
      organizationId: unit.organizationId,
      channelAccountId: unit.channelAccountId,
    });
    const match = chooseMessageAutomation({
      candidates,
      input: {
        kind: input.kind,
        text: input.text,
        storyId: input.storyId ?? null,
        sharedMediaId: input.sharedMediaId ?? null,
        isFirstMessage: input.isFirstMessage ?? false,
        isOwnerChatting: input.isOwnerChatting ?? false,
      },
    });
    if (match === null) return handlingResult({ outcome: 'nothing_matched' });
    // A keyword DM restarts her after a stop word (D49); nothing else does.
    const isRestart =
      match.triggerType === 'dm_keyword' &&
      matchesAutomationKeywords({
        keywords: match.automation.keywords,
        text: input.text,
        isMatchWithoutKeywords: false,
      });
    return this.startFromMatch({
      unit,
      match,
      eventId: input.event.eventId,
      targets: {
        mediaId: input.sharedMediaId ?? null,
        storyId: input.storyId ?? null,
      },
      isRestart,
    });
  }

  /** A tap's own handling ({@link handleButtonClick}). */
  private async handleTap({
    unit,
    input,
  }: {
    unit: AutomationRunEventUnit;
    input: AutomationButtonClickInput;
  }): Promise<AutomationRunHandlingResult> {
    if (await this.isEventHandled(unit)) return handlingResult({ outcome: 'already_handled' });
    const kind = input.kind ?? 'postback';
    if (kind === 'postback') {
      if (input.runPublicId == null || input.automationPublicId == null) {
        return handlingResult({ outcome: 'ignored' });
      }
      return this.tapOurButton({
        unit,
        automationPublicId: input.automationPublicId,
        runPublicId: input.runPublicId,
      });
    }
    if (kind === 'broadcast_tap') {
      return this.startFromBroadcastTap({ unit, input });
    }
    const value = exactSourceValueOf({ kind, input });
    if (value == null || value.trim() === '') return handlingResult({ outcome: 'ignored' });
    const candidates = await unit.automations.listRunCandidates({
      organizationId: unit.organizationId,
      channelAccountId: unit.channelAccountId,
    });
    const match = chooseExactSourceAutomation({ candidates, kind, value });
    if (match === null) {
      if (kind !== 'starter_question') return handlingResult({ outcome: 'nothing_matched' });
      // A paused automation's question goes on as a message with its text (plan §4.3 rule 5).
      return this.handleMessage({
        unit,
        input: {
          ...input,
          kind: 'message',
          text: value,
          quickReplyPayload: null,
          attachmentEmail: null,
        },
      });
    }
    return this.startFromMatch({
      unit,
      match,
      eventId: input.event.eventId,
      targets: {
        adId: kind === 'ad_message' ? value : null,
        refCode: kind === 'ref_link' ? value : null,
      },
      isRestart: kind !== 'ad_message',
    });
  }

  /**
   * A tap on a broadcast message's "start automation X" button (§ 7.A.10): that automation's run
   * for her, when it is a live automation of the account — started as by its own way to start (its
   * once key and open run), an opted-out contact coming back as with a starter question.
   */
  private async startFromBroadcastTap({
    unit,
    input,
  }: {
    unit: AutomationRunEventUnit;
    input: AutomationButtonClickInput;
  }): Promise<AutomationRunHandlingResult> {
    if (input.automationPublicId == null) return handlingResult({ outcome: 'ignored' });
    const candidates = await unit.automations.listRunCandidates({
      organizationId: unit.organizationId,
      channelAccountId: unit.channelAccountId,
    });
    const chosen = candidates.find((candidate) => candidate.public_id === input.automationPublicId);
    if (chosen === undefined) return handlingResult({ outcome: 'nothing_matched' });
    return this.startFromMatch({
      unit,
      match: { automation: chosen, triggerType: chosen.trigger_type as AutomationTriggerType },
      eventId: input.event.eventId,
      targets: {},
      isRestart: true,
    });
  }

  /** A tap on our own button: the run it names moves on (the hello, the follow, or `any`). */
  private async tapOurButton({
    unit,
    automationPublicId,
    runPublicId,
  }: {
    unit: AutomationRunEventUnit;
    automationPublicId: string;
    runPublicId: string;
  }): Promise<AutomationRunHandlingResult> {
    const run = await unit.runs.lockContactRunByPublicId({
      organizationId: unit.organizationId,
      contactId: unit.contact.id,
      runPublicId,
    });
    if (run === null || run.status !== 'waiting') return handlingResult({ outcome: 'ignored' });
    const automation = await unit.automations.findByIdIncludingDeleted({
      organizationId: unit.organizationId,
      automationId: run.automation_id,
    });
    if (
      automation === null ||
      automation.deleted_at !== null ||
      automation.public_id !== automationPublicId ||
      automation.channel_account_id !== unit.channelAccountId
    ) {
      return handlingResult({ outcome: 'ignored' });
    }
    const marked = await this.markMovedByEvent({ unit, run });
    switch (run.waiting_for as AutomationRunWaitingFor) {
      case 'opening_message_button':
        await this.takeHelloAnswer({ unit, run: marked, automation, isTap: true });
        return handlingResult({ outcome: 'run_continued', runPublicIds: [run.public_id] });
      case 'follow': {
        await unit.runEvents.insertMany([
          { ...runKeyOf({ organizationId: unit.organizationId, run }), eventType: 'follow_tapped' },
        ]);
        await this.updateCommentLog({
          unit,
          run,
          changes: { follow_confirmed_at: unit.now },
        });
        await this.saveFollowCheck({ unit, run: marked, automation });
        return handlingResult({ outcome: 'run_continued', runPublicIds: [run.public_id] });
      }
      case 'any':
        await this.sendPendingStepAgain({ unit, run: marked, automation });
        return handlingResult({ outcome: 'run_continued', runPublicIds: [run.public_id] });
      default:
        // A tap proves only the message that carries that button (AU25); an email or phone wait
        // takes no tap.
        return handlingResult({ outcome: 'ignored' });
    }
  }

  /**
   * Her text answers her waiting run (plan §4.3 level 1): an email, a phone, the hello's tap as
   * typed text, or `any`. `null` when no run of hers waits for a message.
   */
  private async answerWaitingRun({
    unit,
    input,
  }: {
    unit: AutomationRunEventUnit;
    input: AutomationDirectMessageInput;
  }): Promise<AutomationRunHandlingResult | null> {
    const waiting = await unit.runs.lockWaitingRunsOfContact({
      organizationId: unit.organizationId,
      contactId: unit.contact.id,
      waitingFor: ['email', 'phone', 'opening_message_button', 'any'],
    });
    for (const candidate of waiting) {
      const automation = await unit.automations.findByIdIncludingDeleted({
        organizationId: unit.organizationId,
        automationId: candidate.automation_id,
      });
      if (automation === null || automation.deleted_at !== null) continue;
      if (automation.channel_account_id !== unit.channelAccountId) continue;
      const run = await this.markMovedByEvent({ unit, run: candidate });
      switch (run.waiting_for as AutomationRunWaitingFor) {
        case 'email':
        case 'phone':
          return this.takeQuestionAnswer({ unit, run, automation, input });
        case 'opening_message_button':
          await this.takeHelloAnswer({ unit, run, automation, isTap: false });
          return handlingResult({ outcome: 'run_continued', runPublicIds: [run.public_id] });
        case 'any':
          await this.sendPendingStepAgain({ unit, run, automation });
          return handlingResult({ outcome: 'run_continued', runPublicIds: [run.public_id] });
        default:
          continue;
      }
    }
    return null;
  }

  /** Stamps the event on a run it moves — a retried event finds its work done. */
  private async markMovedByEvent({
    unit,
    run,
  }: {
    unit: AutomationRunEventUnit;
    run: AutomationRunRow;
  }): Promise<AutomationRunRow> {
    return (
      (await unit.runs.update({
        ...runKeyOf({ organizationId: unit.organizationId, run }),
        changes: { last_instagram_event_key: unit.event.eventKey },
      })) ?? run
    );
  }

  /** The hello's tap or her first text while the run waits for it (AU27): counted, then on. */
  private async takeHelloAnswer({
    unit,
    run,
    automation,
    isTap,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
    isTap: boolean;
  }): Promise<void> {
    const versions = run.version_numbers;
    if (isTap) {
      await unit.runEvents.insertMany([
        { ...runKeyOf({ organizationId: unit.organizationId, run }), eventType: 'hello_tapped' },
      ]);
    }
    await this.dependencies.countService.increment({
      scope: unit.scope,
      increment: {
        organizationId: unit.organizationId,
        automationId: automation.id,
        automationRunId: run.id,
        counter: isTap ? 'taps' : 'typed_answers',
        versionKey: `hello.${versions.hello ?? 1}`,
      },
    });
    if (isSheMessagedFirst(run.trigger_type as AutomationTriggerType)) {
      // Her tap or message before it goes cancels the nudge (plan §5.6, `answered`).
      await unit.port.cancelWaitingMessages({
        databaseHandle: unit.databaseHandle,
        organizationId: unit.organizationId,
        by: 'run',
        id: run.id,
        reason: 'answered',
      });
    }
    await this.updateCommentLog({
      unit,
      run,
      changes: { opening_dm_status: 'done', button_clicked_at: unit.now, waiting_for: null },
    });
    await this.proceed({ unit, run, automation, from: 'follow' });
  }

  /** An email or phone answer (plan §14): saved → on; wrong → asked again up to 3 times in all. */
  private async takeQuestionAnswer({
    unit,
    run,
    automation,
    input,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
    input: AutomationDirectMessageInput;
  }): Promise<AutomationRunHandlingResult> {
    const part = run.waiting_for === 'email' ? 'email' : 'phone';
    const nextStage = part === 'email' ? 'phone' : 'messages';
    const question = questionStepOf({ steps: automation.steps, part, switches: unit.switches });
    if (question === null) {
      // The step is off or the plan lost its PRO switch: the run moves on (AU26).
      await this.proceed({ unit, run, automation, from: nextStage });
      return handlingResult({ outcome: 'run_continued', runPublicIds: [run.public_id] });
    }
    const answer =
      part === 'email'
        ? pickEmailAnswer({
            quickReplyPayload: input.quickReplyPayload,
            attachmentEmail: input.attachmentEmail,
            text: input.text,
          })
        : pickPhoneAnswer({ quickReplyPayload: input.quickReplyPayload, text: input.text });
    const target = {
      databaseHandle: unit.databaseHandle,
      organizationId: unit.organizationId,
      contactId: unit.contact.id,
      collectedAt: unit.now,
    };
    let saved: ContactCollectedValueResult | null;
    if (answer === null) {
      saved = { outcome: 'invalid' };
    } else if (part === 'email') {
      saved = await this.dependencies.contactService.recordContactEmail({
        ...target,
        email: answer,
      });
    } else {
      saved = await this.dependencies.contactService.recordContactPhone({
        ...target,
        phone: answer,
      });
    }
    if (saved === null) return handlingResult({ outcome: 'ignored' });
    if (saved.outcome === 'invalid') {
      const versions = run.version_numbers;
      // `asks` counts the first question too: it plus at most 3 asks again (AC-19.5, R54).
      const asks = (part === 'email' ? versions.email_asks : versions.phone_asks) ?? 1;
      if (asks <= AUTOMATION_RUN_ASK_MAX_COUNT) {
        await this.askQuestion({ unit, run, automation, part });
      }
      return handlingResult({ outcome: 'answer_invalid', runPublicIds: [run.public_id] });
    }
    // The grouped "new contact details" note (UN13): one per account and hour, after this commit.
    await this.dependencies.contactService.noteContactDetailsLeft({
      databaseHandle: unit.databaseHandle,
      scope: unit.scope,
      organizationId: unit.organizationId,
      channelAccountId: unit.channelAccountId,
      at: unit.now,
    });
    await unit.runEvents.insertMany([
      {
        ...runKeyOf({ organizationId: unit.organizationId, run }),
        eventType: part === 'email' ? 'email_received' : 'phone_received',
      },
    ]);
    await this.updateCommentLog({
      unit,
      run,
      changes:
        part === 'email'
          ? { email_status: 'done', email_at: unit.now, email_received: answer, waiting_for: null }
          : { phone_status: 'done', phone_at: unit.now, phone_received: answer, waiting_for: null },
    });
    await this.proceed({ unit, run, automation, from: nextStage });
    return handlingResult({ outcome: 'run_continued', runPublicIds: [run.public_id] });
  }

  // ── Starting a run ───────────────────────────────────────────────────────────────────────

  /** A non-comment start: the gates of a message or tap start, then the run (plan §4.3). */
  private async startFromMatch({
    unit,
    match,
    eventId,
    targets,
    isRestart = false,
    versionExtras = {},
  }: {
    unit: AutomationRunEventUnit;
    match: AutomationMatch<AutomationRow>;
    eventId: string;
    targets: {
      mediaId?: string | null;
      storyId?: string | null;
      adId?: string | null;
      refCode?: string | null;
      tag?: string | null;
    };
    isRestart?: boolean;
    versionExtras?: AutomationRunVersionNumbers;
  }): Promise<AutomationRunHandlingResult> {
    if (unit.contact.automations_off_at !== null) return handlingResult({ outcome: 'ignored' });
    if (unit.contact.opted_out_at !== null) {
      if (!isRestart) return handlingResult({ outcome: 'ignored' });
      await this.dependencies.contactService.clearContactOptOut({
        databaseHandle: unit.databaseHandle,
        organizationId: unit.organizationId,
        contactId: unit.contact.id,
      });
    }
    const started = await this.startRun({
      unit,
      match,
      eventId,
      targets: { ...targets, cameInRef: targets.refCode ?? targets.adId ?? null },
      isReplaceAllowed: false,
      versionExtras,
    });
    if (started.kind !== 'started') return handlingResult({ outcome: 'ignored' });
    return handlingResult({ outcome: 'run_started', runPublicIds: [started.run.public_id] });
  }

  /**
   * Starts a run (AU22–AU27): the automation locked live, the once key, the open key (the replace
   * rule for an allowed comment, P35), the run with its versions, its key, its event, the count, her
   * first run, `last_triggered_at`; then `beforeFirstStep` (the comment logs) and its first step.
   */
  private async startRun({
    unit,
    match,
    eventId,
    targets,
    isReplaceAllowed,
    versionExtras = {},
    beforeFirstStep,
  }: {
    unit: AutomationRunEventUnit;
    match: AutomationMatch<AutomationRow>;
    eventId: string;
    targets: {
      mediaId?: string | null;
      commentId?: string | null;
      storyId?: string | null;
      adId?: string | null;
      tag?: string | null;
      cameInRef?: string | null;
    };
    isReplaceAllowed: boolean;
    versionExtras?: AutomationRunVersionNumbers;
    beforeFirstStep?: (run: AutomationRunRow) => Promise<void>;
  }): Promise<
    | { kind: 'started'; run: AutomationRunRow; isReplacement: boolean }
    | { kind: 'held'; reason: AutomationCommentLogIgnoredReason }
    | { kind: 'gone' }
  > {
    const { organizationId } = unit;
    const automation = await unit.automations.lockLiveForRunStart({
      organizationId,
      automationId: match.automation.id,
    });
    if (automation === null) return { kind: 'gone' };
    const onceKey = buildOnceKey({
      triggerType: match.triggerType,
      isOncePerPersonPerPost: unit.account.is_once_per_person_per_post_enabled,
      defaultReplyMode: automation.default_reply_mode,
      day: organizationDayOf({ at: unit.event.occurredAt, timeZone: unit.account.time_zone }),
      eventId,
      mediaId: targets.mediaId ?? null,
      storyId: targets.storyId ?? null,
      adId: targets.adId ?? null,
      tag: targets.tag ?? null,
    });
    if (
      await unit.runs.hasDirectMessageForOnceKey({
        organizationId,
        automationId: automation.id,
        contactId: unit.contact.id,
        onceKey,
      })
    ) {
      return { kind: 'held', reason: 'once_per_post' };
    }
    const opening = await this.takeOpenKey({ unit, automation, onceKey, isReplaceAllowed });
    if (opening.kind === 'held') return opening;
    const isReplacement = opening.isReplacement;
    const versionNumbers = this.pickVersions({ unit, automation, versionExtras });
    const run = await unit.runs.insert({
      organizationId,
      automationId: automation.id,
      contactId: unit.contact.id,
      triggerType: match.triggerType,
      triggerMediaId: targets.mediaId ?? null,
      triggerCommentId: targets.commentId ?? null,
      triggerStoryId: targets.storyId ?? null,
      triggerOccurredAt: unit.event.occurredAt,
      onceKey,
      versionNumbers,
      lastEventKey: unit.event.eventKey,
    });
    const isKeyTaken = await unit.openKeys.insert({
      organizationId,
      automationId: automation.id,
      contactId: unit.contact.id,
      runId: run.id,
      runStartedAt: run.started_at,
    });
    if (!isKeyTaken) {
      // Another start of the same pair committed its key first (AU37): this one never existed.
      await unit.runs.deleteJustInserted(runKeyOf({ organizationId, run }));
      return { kind: 'held', reason: 'run_in_progress' };
    }
    await unit.runEvents.insertMany([
      { ...runKeyOf({ organizationId, run }), eventType: 'status_changed', status: 'running' },
    ]);
    await this.dependencies.countService.increment({
      scope: unit.scope,
      increment: {
        organizationId,
        automationId: automation.id,
        automationRunId: run.id,
        counter: 'runs_started',
        versionKey: versionNumbers.hello === undefined ? null : `hello.${versionNumbers.hello}`,
      },
    });
    await this.dependencies.contactService.recordContactFirstRun({
      databaseHandle: unit.databaseHandle,
      organizationId,
      contactId: unit.contact.id,
      automationId: automation.id,
      cameInVia: match.triggerType,
      cameInRef: targets.cameInRef ?? null,
    });
    await unit.automations.markRunStarted({ organizationId, automationId: automation.id });
    await beforeFirstStep?.(run);
    await this.proceed({ unit, run, automation, from: 'hello' });
    return { kind: 'started', run, isReplacement };
  }

  /**
   * The open key of the automation and person before a start (AU23, AU37, P35): none → the start may
   * go; her open run under the same once key → `once_per_post`; another start while it is open →
   * `run_in_progress`, or for an allowed comment the open run is replaced (`replaced`, its waiting
   * messages skipped) and its key deleted, in this commit.
   */
  private async takeOpenKey({
    unit,
    automation,
    onceKey,
    isReplaceAllowed,
  }: {
    unit: AutomationRunEventUnit;
    automation: AutomationRow;
    onceKey: string;
    isReplaceAllowed: boolean;
  }): Promise<
    | { kind: 'free'; isReplacement: boolean }
    | { kind: 'held'; reason: AutomationCommentLogIgnoredReason }
  > {
    const { organizationId } = unit;
    const openKey = await unit.openKeys.lockForAutomationAndContact({
      organizationId,
      automationId: automation.id,
      contactId: unit.contact.id,
    });
    if (openKey === null) return { kind: 'free', isReplacement: false };
    const openRun = await unit.runs.lockByKey({
      organizationId,
      runId: openKey.automation_run_id,
      runStartedAt: openKey.automation_run_started_at,
    });
    if (openRun !== null && openRun.once_key === onceKey) {
      return { kind: 'held', reason: 'once_per_post' };
    }
    if (!isReplaceAllowed) return { kind: 'held', reason: 'run_in_progress' };
    if (openRun !== null && (openRun.status === 'running' || openRun.status === 'waiting')) {
      await this.endRun({ unit, run: openRun, end: { status: 'cancelled', reason: 'replaced' } });
      await unit.port.skipWaitingMessages({
        databaseHandle: unit.databaseHandle,
        organizationId,
        by: 'run',
        id: openRun.id,
        reason: 'replaced',
      });
    } else {
      await unit.openKeys.deleteForRuns({
        organizationId,
        runs: [{ id: openKey.automation_run_id, started_at: openKey.automation_run_started_at }],
      });
    }
    return { kind: 'free', isReplacement: true };
  }

  /** The hello and follow versions of a new run, at random (PRO only beyond 1 — AU27). */
  private pickVersions({
    unit,
    automation,
    versionExtras,
  }: {
    unit: AutomationRunUnit;
    automation: AutomationRow;
    versionExtras: AutomationRunVersionNumbers;
  }): AutomationRunVersionNumbers {
    const versionNumbers: AutomationRunVersionNumbers = { ...versionExtras };
    const hello = helloStepOf(automation.steps);
    if (hello !== null) {
      versionNumbers.hello = pickVersionNumber({
        count: hello.versions.length,
        switches: unit.switches,
        drawInteger: this.drawInteger,
      });
    }
    const follow = followStepOf(automation.steps);
    if (follow !== null) {
      versionNumbers.follow = pickVersionNumber({
        count: follow.versions.length,
        switches: unit.switches,
        drawInteger: this.drawInteger,
      });
    }
    return versionNumbers;
  }

  // ── Steps ────────────────────────────────────────────────────────────────────────────────

  /**
   * Moves a run on from a stage (AU24): the first step that is on and needed saves its waiting message
   * and the run stays `running` at it; with nothing left, the tags and `completed`.
   */
  private async proceed({
    unit,
    run,
    automation,
    from,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
    from: 'hello' | 'follow' | 'email' | 'phone' | 'messages';
  }): Promise<void> {
    const stages = ['hello', 'follow', 'email', 'phone', 'messages'] as const;
    for (const stage of stages.slice(stages.indexOf(from))) {
      if (await this.saveStage({ unit, run, automation, stage })) return;
    }
    await this.completeRun({ unit, run, automation });
  }

  /** One stage of {@link proceed}: saves its waiting message and answers `true`, or `false` when off or not needed. */
  private async saveStage({
    unit,
    run,
    automation,
    stage,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
    stage: 'hello' | 'follow' | 'email' | 'phone' | 'messages';
  }): Promise<boolean> {
    const steps = automation.steps;
    const versions = run.version_numbers;
    switch (stage) {
      case 'hello':
        if (helloStepOf(steps) === null) return false;
        await this.saveBlockingMessage({
          unit,
          run,
          automation,
          runStep: 'comment_reply',
          message: {
            step: 'hello',
            versionNumber: versions.hello ?? 1,
            stepPath: `steps.hello.versions.${(versions.hello ?? 1) - 1}`,
          },
        });
        return true;
      case 'follow':
        if (followStepOf(steps) === null || unit.contact.is_following_account === true)
          return false;
        await this.saveFollowCheck({ unit, run, automation });
        return true;
      case 'email':
      case 'phone':
        if (questionStepOf({ steps, part: stage, switches: unit.switches }) === null) return false;
        if ((stage === 'email' ? unit.contact.email : unit.contact.phone) !== null) return false;
        await this.askQuestion({ unit, run, automation, part: stage });
        return true;
      case 'messages':
        return this.saveNextListMessage({ unit, run, automation });
    }
  }

  /** The next message of the list, its wait as `not_before` (D29); `false` when the list is done. */
  private async saveNextListMessage({
    unit,
    run,
    automation,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
  }): Promise<boolean> {
    const messageNumber = (run.last_message_number ?? 0) + 1;
    const message = messagesOf(automation.steps)[messageNumber - 1];
    if (message === undefined) return false;
    await this.saveBlockingMessage({
      unit,
      run,
      automation,
      runStep: 'messages',
      message: {
        step: 'messages',
        messageNumber,
        messageKind: message.kind,
        stepPath: `steps.messages.${messageNumber - 1}`,
        uploadPublicIds: uploadPublicIdsOf(message),
        notBefore:
          message.wait_minutes > 0
            ? new Date(unit.now.getTime() + message.wait_minutes * 60_000)
            : null,
      },
    });
    return true;
  }

  /** The follow check (plan §14.1): a read of her follow, which comes back as a result. */
  private async saveFollowCheck({
    unit,
    run,
    automation,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
  }): Promise<void> {
    await this.saveBlockingMessage({
      unit,
      run,
      automation,
      runStep: 'follow_check',
      message: { step: 'follow_check', stepPath: 'steps.follow' },
    });
  }

  /** Asks for her email or phone with a wording other than the last (plan §5.8), counting the asks. */
  private async askQuestion({
    unit,
    run,
    automation,
    part,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
    part: 'email' | 'phone';
  }): Promise<void> {
    const question = automation.steps[part];
    const versions = run.version_numbers;
    const wordingNumber = pickWordingNumber({
      count: question?.wordings.length ?? 1,
      lastWordingNumber: versions[part] ?? null,
      drawInteger: this.drawInteger,
    });
    const asksKey = part === 'email' ? 'email_asks' : 'phone_asks';
    const updated =
      (await unit.runs.update({
        ...runKeyOf({ organizationId: unit.organizationId, run }),
        changes: {
          version_numbers: {
            ...versions,
            [part]: wordingNumber,
            [asksKey]: (versions[asksKey] ?? 0) + 1,
          },
        },
      })) ?? run;
    await this.saveBlockingMessage({
      unit,
      run: updated,
      automation,
      runStep: part === 'email' ? 'email_collect' : 'phone_collect',
      message: {
        step: part,
        wordingNumber,
        stepPath: `steps.${part}.wordings.${wordingNumber - 1}`,
      },
    });
  }

  /**
   * Saves one step's waiting message through the channel's port (AU35) and keeps the run `running` at
   * that step; a message that can never go (`skipped` at the save) ends the run as its result would.
   */
  private async saveBlockingMessage({
    unit,
    run,
    automation,
    runStep,
    message,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
    runStep: AutomationRunStep;
    message: AutomationWaitingMessage;
  }): Promise<void> {
    const isFirstDirectMessage =
      run.direct_message_sent_at === null && message.step !== 'follow_check';
    const saved = await this.saveMessage({
      unit,
      run,
      message: {
        ...message,
        // A comment's first DM answers her comment — the channel picks a private reply or a DM.
        answersEventId:
          isFirstDirectMessage && isCommentTrigger(run.trigger_type)
            ? run.trigger_instagram_comment_id
            : null,
      },
    });
    const moved =
      (await unit.runs.update({
        ...runKeyOf({ organizationId: unit.organizationId, run }),
        changes: {
          status: 'running',
          current_step: runStep,
          waiting_for: null,
          waiting_since_at: null,
          last_step_at: unit.now,
        },
      })) ?? run;
    if (run.status !== 'running') {
      await unit.runEvents.insertMany([
        {
          ...runKeyOf({ organizationId: unit.organizationId, run }),
          eventType: 'status_changed',
          status: 'running',
        },
      ]);
    }
    const logStep = COMMENT_LOG_STEP_OF_RUN_STEP[runStep];
    await this.updateCommentLog({
      unit,
      run,
      changes: {
        overall_status: 'started',
        current_step: logStep.step,
        waiting_for: null,
        [logStep.status]: 'waiting',
      },
    });
    if (saved.status === 'skipped') {
      await this.applyBlockingResult({
        unit,
        run: moved,
        automation,
        step: message.step as AutomationBlockingStep,
        result: 'skipped',
        reason: saved.reason,
      });
    }
  }

  /** One `saveWaitingMessage` call for a run (AU35): content by reference, never text. */
  private saveMessage({
    unit,
    run,
    message,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    message: AutomationWaitingMessage;
  }): Promise<SaveWaitingMessageResult> {
    return unit.port.saveWaitingMessage({
      databaseHandle: unit.databaseHandle,
      organizationId: unit.organizationId,
      channelAccountId: unit.channelAccountId,
      contactId: run.contact_id,
      source: {
        automationId: run.automation_id,
        automationRunId: run.id,
        automationRunStartedAt: run.started_at,
      },
      step: message.step,
      messageNumber: message.messageNumber ?? null,
      versionNumber: message.versionNumber ?? null,
      wordingNumber: message.wordingNumber ?? null,
      messageKind: message.messageKind ?? 'text',
      content: { stepPath: message.stepPath, uploadPublicIds: message.uploadPublicIds ?? [] },
      notBefore: message.notBefore ?? null,
      triggerOccurredAt: run.trigger_occurred_at,
      answersEventId: message.answersEventId ?? null,
      organizationPublicId: unit.scope.organizationPublicId,
      answerDelay: answerDelayOf(unit),
      isExtraDelayAllowed: isPlanSwitchOn({ switches: unit.switches, feature: 'extra_delay' }),
    });
  }

  /** The run's pending step once more after an `unknown` result — only on her next message or tap (AU25). */
  private async sendPendingStepAgain({
    unit,
    run,
    automation,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
  }): Promise<void> {
    switch (run.current_step as AutomationRunStep) {
      case 'keyword_match':
      case 'comment_reply':
        await this.proceed({ unit, run, automation, from: 'hello' });
        return;
      case 'follow_check': {
        const versions = run.version_numbers;
        await this.saveBlockingMessage({
          unit,
          run,
          automation,
          runStep: 'follow_check',
          message: {
            step: 'follow',
            versionNumber: versions.follow ?? 1,
            stepPath: `steps.follow.versions.${(versions.follow ?? 1) - 1}`,
          },
        });
        return;
      }
      case 'email_collect':
        await this.askQuestion({ unit, run, automation, part: 'email' });
        return;
      case 'phone_collect':
        await this.askQuestion({ unit, run, automation, part: 'phone' });
        return;
      case 'messages':
        await this.proceed({ unit, run, automation, from: 'messages' });
        return;
    }
  }

  /** The tag step (D45) and `completed` (AU24): her tags with the automation as their source. */
  private async completeRun({
    unit,
    run,
    automation,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
  }): Promise<void> {
    const tags = tagsOf(automation.steps);
    if (tags.length > 0) {
      const versions = run.version_numbers;
      const isTagStart = run.trigger_type === 'tag_added' || run.trigger_type === 'tag_removed';
      await this.dependencies.contactService.addContactTags({
        databaseHandle: unit.databaseHandle,
        organizationId: unit.organizationId,
        contactId: run.contact_id,
        tags,
        sourceAutomationId: automation.id,
        chainNumber: isTagStart ? (versions.tag_chain ?? 0) + 1 : 0,
      });
    }
    await this.endRun({ unit, run, end: { status: 'completed' } });
  }

  // ── Results (AU35) ───────────────────────────────────────────────────────────────────────

  /** A result for a run that is still open: the public reply, the hide, the nudge or a blocking step. */
  private async applyResult({
    unit,
    run,
    automation,
    input,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
    input: ChannelMessageResultInput;
  }): Promise<void> {
    switch (input.step) {
      case 'public_reply':
      case 'hide_comment':
        await this.updateCommentLog({
          unit,
          run,
          changes: this.replyLogChanges({
            step: input.step,
            result: input.result,
            reason: input.reason,
            at: input.occurredAt,
          }),
        });
        return;
      case 'nudge':
      case 'broadcast':
        return;
      default:
        break;
    }
    if (
      run.status !== 'running' ||
      !this.isPendingStep({ run, step: input.step, messageNumber: input.messageNumber })
    ) {
      return;
    }
    await this.applyBlockingResult({
      unit,
      run,
      automation,
      step: input.step,
      result: input.result,
      reason: input.reason,
    });
  }

  /** Whether a result names the step the run is held at (a repeat or a stale result does nothing). */
  private isPendingStep({
    run,
    step,
    messageNumber,
  }: {
    run: AutomationRunRow;
    step: ChannelMessageStep;
    messageNumber: number | null;
  }): boolean {
    switch (step) {
      case 'hello':
        return run.current_step === 'comment_reply';
      case 'follow':
      case 'follow_check':
        return run.current_step === 'follow_check';
      case 'email':
        return run.current_step === 'email_collect';
      case 'phone':
        return run.current_step === 'phone_collect';
      case 'messages':
        return (
          run.current_step === 'messages' && messageNumber === (run.last_message_number ?? 0) + 1
        );
      default:
        return false;
    }
  }

  /** The comment-log columns of a public reply's or hide's result. */
  private replyLogChanges({
    step,
    result,
    reason,
    at,
  }: {
    step: 'public_reply' | 'hide_comment';
    result: ChannelMessageResultInput['result'];
    reason: string | null;
    at: Date;
  }): AutomationCommentLogChanges {
    let status: AutomationCommentLogStepStatus = result;
    let skipReason: AutomationPublicReplySkipReason | null = null;
    if (result === 'skipped') {
      if (reason === 'expired' || reason === 'reply_too_old') status = 'expired';
      else if (
        step === 'public_reply' &&
        !(AUTOMATION_PUBLIC_REPLY_SKIP_REASONS as readonly string[]).includes(reason ?? '')
      ) {
        status = 'failed';
      } else if (step === 'public_reply') skipReason = reason as AutomationPublicReplySkipReason;
    }
    if (step === 'hide_comment') {
      return { hide_status: status, ...(result === 'sent' ? { hidden_at: at } : {}) };
    }
    return {
      public_reply_status: status,
      public_reply_skip_reason: skipReason,
      ...(result === 'sent' ? { public_reply_at: at } : {}),
    };
  }

  /** A blocking step's result: on, wait, `any`, failed or cancelled (AU24, AU25). */
  private async applyBlockingResult({
    unit,
    run,
    automation,
    step,
    result,
    reason,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
    step: ChannelMessageStep;
    result: ChannelMessageResultInput['result'];
    reason: string | null;
  }): Promise<void> {
    if (step === 'follow_check') {
      await this.applyFollowCheckResult({ unit, run, automation, result, reason });
      return;
    }
    if (result === 'failed' || result === 'skipped') {
      await this.endStepFailedOrSkipped({ unit, run, step, result, reason });
      return;
    }
    const isFirstDirectMessage = run.direct_message_sent_at === null;
    const moved =
      (await unit.runs.update({
        ...runKeyOf({ organizationId: unit.organizationId, run }),
        changes: {
          ...(isFirstDirectMessage ? { direct_message_sent_at: unit.now } : {}),
          ...(step === 'messages' && result === 'sent'
            ? { last_message_number: (run.last_message_number ?? 0) + 1 }
            : {}),
          last_step_at: unit.now,
        },
      })) ?? run;
    if (result === 'unknown') {
      // Never sent again by itself: her next message or tap may send it once more (D17, AU25).
      const logStep = COMMENT_LOG_STEP_OF_RUN_STEP[run.current_step as AutomationRunStep];
      await this.waitFor({
        unit,
        run: moved,
        waitingFor: 'any',
        logChanges: { [logStep.status]: 'unknown' },
      });
      return;
    }
    if (isFirstDirectMessage && isCommentTrigger(run.trigger_type)) {
      await this.makePublicReplyAndHide({ unit, run: moved, automation });
    }
    await this.moveOnAfterSent({ unit, run: moved, automation, step });
  }

  /** A follow check's result: two tries, both failed = "following" (D12); only "not following" asks. */
  private async applyFollowCheckResult({
    unit,
    run,
    automation,
    result,
    reason,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
    result: ChannelMessageResultInput['result'];
    reason: string | null;
  }): Promise<void> {
    if (result === 'sent' && reason === 'not_following') {
      const versions = run.version_numbers;
      await this.saveBlockingMessage({
        unit,
        run,
        automation,
        runStep: 'follow_check',
        message: {
          step: 'follow',
          versionNumber: versions.follow ?? 1,
          stepPath: `steps.follow.versions.${(versions.follow ?? 1) - 1}`,
        },
      });
      return;
    }
    await this.updateCommentLog({ unit, run, changes: { follow_status: 'done' } });
    // The check sent her nothing: the next step goes at once (plan §30.2 step 13).
    await this.proceed({ unit: { ...unit, answerDelay: 'none' }, run, automation, from: 'email' });
  }

  /** A blocking step `failed` (the run fails) or `skipped` (cancelled with its reason, else failed). */
  private async endStepFailedOrSkipped({
    unit,
    run,
    step,
    result,
    reason,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    step: ChannelMessageStep;
    result: 'failed' | 'skipped';
    reason: string | null;
  }): Promise<void> {
    const logStep = COMMENT_LOG_STEP_OF_RUN_STEP[run.current_step as AutomationRunStep];
    const cancelReason = result === 'skipped' ? cancelReasonOfSkip(reason) : null;
    await this.updateCommentLog({
      unit,
      run,
      changes: {
        [logStep.status]: result === 'skipped' && reason === 'expired' ? 'expired' : result,
        ...(result === 'failed'
          ? {
              failed_step: logStep.step,
              error_type: 'instagram_api',
              error_reason: reason,
              error_message: describeFailure({ step, reason }),
              error_at: unit.now,
            }
          : {}),
      },
    });
    await this.endRun({
      unit,
      run,
      end:
        cancelReason === null
          ? {
              status: 'failed',
              errorMessage: describeFailure({ step, reason: `${result}:${reason ?? ''}` }),
            }
          : { status: 'cancelled', reason: cancelReason },
    });
  }

  /** A blocking step `sent`: the hello waits for her tap (a nudge when she messaged first), a question for her answer, a list message moves on. */
  private async moveOnAfterSent({
    unit,
    run,
    automation,
    step,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
    step: ChannelMessageStep;
  }): Promise<void> {
    switch (step) {
      case 'hello':
        await this.afterHelloSent({ unit, run, automation });
        return;
      case 'follow':
        await this.waitFor({
          unit,
          run,
          waitingFor: 'follow',
          logChanges: { follow_status: 'waiting', follow_at: unit.now },
        });
        return;
      case 'email':
      case 'phone':
        await this.waitFor({
          unit,
          run,
          waitingFor: step,
          logChanges: step === 'email' ? { email_status: 'waiting' } : { phone_status: 'waiting' },
        });
        return;
      case 'messages':
        await this.updateCommentLog({
          unit,
          run,
          changes: { messages_status: 'sent', messages_at: unit.now },
        });
        await this.proceed({ unit, run, automation, from: 'messages' });
        return;
      default:
        return;
    }
  }

  /** The hello `sent`: without a "next step" button the run goes on; else it waits for her tap. */
  private async afterHelloSent({
    unit,
    run,
    automation,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
  }): Promise<void> {
    const versions = run.version_numbers;
    const logChanges: AutomationCommentLogChanges = {
      opening_dm_status: 'sent',
      opening_dm_at: unit.now,
    };
    if (!helloHasNextButton({ steps: automation.steps, versionNumber: versions.hello ?? 1 })) {
      await this.updateCommentLog({ unit, run, changes: logChanges });
      await this.proceed({ unit, run, automation, from: 'follow' });
      return;
    }
    if (
      isSheMessagedFirst(run.trigger_type as AutomationTriggerType) &&
      automation.steps.hello?.nudge === true
    ) {
      await this.saveMessage({
        unit,
        run,
        message: {
          step: 'nudge',
          versionNumber: versions.hello ?? 1,
          stepPath: `steps.hello.versions.${(versions.hello ?? 1) - 1}`,
          notBefore: new Date(unit.now.getTime() + AUTOMATION_RUN_NUDGE_AFTER_MILLISECONDS),
        },
      });
    }
    await this.waitFor({ unit, run, waitingFor: 'opening_message_button', logChanges });
  }

  /**
   * After the first DM of a comment is `sent` (plan §7.2): the public reply (when on — a duplicate is
   * `skipped`; "Reply like a person" with its PRO switch draws 80 %) and then the hide (when on).
   * A Live comment gets neither.
   */
  private async makePublicReplyAndHide({
    unit,
    run,
    automation,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
  }): Promise<void> {
    if (run.trigger_type === 'live_comment' || run.trigger_instagram_comment_id === null) return;
    const commentId = run.trigger_instagram_comment_id;
    const logChanges: AutomationCommentLogChanges = {};
    if (automation.is_public_reply_enabled && automation.public_reply_texts.length > 0) {
      Object.assign(logChanges, await this.makePublicReply({ unit, run, automation, commentId }));
    }
    if (automation.is_hide_comment_after_direct_message_enabled) {
      const saved = await this.saveMessage({
        unit,
        run,
        message: { step: 'hide_comment', stepPath: 'hide_comment', answersEventId: commentId },
      });
      Object.assign(
        logChanges,
        saved.status === 'waiting'
          ? { hide_status: 'waiting' }
          : this.replyLogChanges({
              step: 'hide_comment',
              result: 'skipped',
              reason: saved.reason,
              at: unit.now,
            }),
      );
    }
    await this.updateCommentLog({ unit, run, changes: logChanges });
  }

  /**
   * The public reply of {@link makePublicReplyAndHide}: skipped as a duplicate or by the 80 % draw,
   * else saved as a waiting message (with the automation's waiting-reply count) — the comment log
   * changes it makes.
   */
  private async makePublicReply({
    unit,
    run,
    automation,
    commentId,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
    commentId: string;
  }): Promise<AutomationCommentLogChanges> {
    const skipReason = await this.publicReplySkipReason({ unit, run, automation, commentId });
    if (skipReason !== null) {
      return { public_reply_status: 'skipped', public_reply_skip_reason: skipReason };
    }
    const saved = await this.saveMessage({
      unit,
      run,
      message: {
        step: 'public_reply',
        stepPath: 'public_reply_texts',
        answersEventId: commentId,
      },
    });
    if (saved.status !== 'waiting') {
      return this.replyLogChanges({
        step: 'public_reply',
        result: 'skipped',
        reason: saved.reason,
        at: unit.now,
      });
    }
    await this.dependencies.replyStateService.addWaitingReply({
      scope: unit.scope,
      key: { organizationId: unit.organizationId, automationId: automation.id },
      channelAccountId: unit.channelAccountId,
    });
    return { public_reply_status: 'waiting' };
  }

  /**
   * Why the public reply is skipped: `duplicate` when another run's reply to the comment is waiting
   * or sent in the last two months, `random` when "Reply like a person" (with its PRO switch) draws
   * the skip, else `null`.
   */
  private async publicReplySkipReason({
    unit,
    run,
    automation,
    commentId,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    automation: AutomationRow;
    commentId: string;
  }): Promise<AutomationPublicReplySkipReason | null> {
    const logs = await unit.commentLogs.listForComment({
      organizationId: unit.organizationId,
      commentId,
      since: lastTwoMonthsStart(unit.now),
    });
    const isDuplicate = logs.some(
      (log) =>
        log.automation_run_id !== run.id &&
        (log.public_reply_status === 'waiting' || log.public_reply_status === 'sent'),
    );
    if (isDuplicate) return 'duplicate';
    const isLikePerson =
      automation.is_reply_like_person_enabled &&
      isPlanSwitchOn({ switches: unit.switches, feature: 'reply_like_person' });
    if (
      isLikePerson &&
      this.drawInteger(AUTOMATION_PUBLIC_REPLY_CHANCE_SCALE) >=
        AUTOMATION_PUBLIC_REPLY_CHANCE_PERCENT
    ) {
      return 'random';
    }
    return null;
  }

  // ── Run state ────────────────────────────────────────────────────────────────────────────

  /** The run waits for her (status `waiting`), its event and its log. */
  private async waitFor({
    unit,
    run,
    waitingFor,
    logChanges,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    waitingFor: AutomationRunWaitingFor;
    logChanges: AutomationCommentLogChanges;
  }): Promise<void> {
    const key = runKeyOf({ organizationId: unit.organizationId, run });
    await unit.runs.update({
      ...key,
      changes: {
        status: 'waiting',
        waiting_for: waitingFor,
        waiting_since_at: unit.now,
        last_step_at: unit.now,
      },
    });
    if (run.status !== 'waiting') {
      await unit.runEvents.insertMany([{ ...key, eventType: 'status_changed', status: 'waiting' }]);
    }
    await this.updateCommentLog({
      unit,
      run,
      changes: { ...logChanges, overall_status: 'waiting', waiting_for: waitingFor },
    });
  }

  /** Ends a run (AU21): its status, its event, its log and — in the same commit — its open key (AU37). */
  private async endRun({
    unit,
    run,
    end,
  }: {
    unit: AutomationRunUnit;
    run: AutomationRunRow;
    end: AutomationRunEnd;
  }): Promise<void> {
    const key = runKeyOf({ organizationId: unit.organizationId, run });
    const changes: AutomationRunChanges = {
      status: end.status,
      waiting_for: null,
      waiting_since_at: null,
      last_step_at: unit.now,
      ...(end.status === 'completed' ? { completed_at: unit.now } : {}),
      ...(end.status === 'failed' ? { failed_at: unit.now, error_message: end.errorMessage } : {}),
      ...(end.status === 'cancelled' ? { cancelled_at: unit.now, cancel_reason: end.reason } : {}),
    };
    await unit.runs.update({ ...key, changes });
    await unit.runEvents.insertMany([{ ...key, eventType: 'status_changed', status: end.status }]);
    await unit.openKeys.deleteForRuns({
      organizationId: unit.organizationId,
      runs: [{ id: run.id, started_at: run.started_at }],
    });
    const isChatStillHers =
      end.status === 'completed' ||
      (end.status === 'cancelled' && RUN_END_HOOK_CANCEL_REASONS.has(end.reason));
    if (isChatStillHers) {
      await this.dependencies.runEndedHook?.({
        databaseHandle: unit.databaseHandle,
        organizationId: unit.organizationId,
        channelAccountId: unit.channelAccountId,
        contactId: run.contact_id,
      });
    }
    await this.updateCommentLog({
      unit,
      run,
      changes: {
        overall_status: end.status,
        waiting_for: null,
        ...(end.status === 'failed' ? { error_at: unit.now } : {}),
      },
    });
    logger.info(
      {
        organizationPublicId: unit.scope.organizationPublicId,
        runPublicId: run.public_id,
        status: end.status,
        cancelReason: end.status === 'cancelled' ? end.reason : null,
      },
      'app.automation_run.ended',
    );
  }

  /** Writes a comment run's log changes (a comment way only); nothing to write is a no-op. */
  private async updateCommentLog({
    unit,
    run,
    changes,
  }: {
    unit: Pick<AutomationRunUnit, 'commentLogs' | 'organizationId'>;
    run: AutomationRunRow;
    changes: AutomationCommentLogChanges;
  }): Promise<void> {
    if (!isCommentTrigger(run.trigger_type) || Object.keys(changes).length === 0) return;
    await unit.commentLogs.updateForRun({
      ...runKeyOf({ organizationId: unit.organizationId, run }),
      changes,
    });
  }

  /** Cancels her open runs with a reason (erase or pause): the lock order, then the cancel. */
  private async cancelOpenRunsOfContact({
    repositories,
    organizationId,
    contactId,
    reason,
  }: {
    repositories: Omit<AutomationRunRepositories, 'databaseHandle'>;
    organizationId: number;
    contactId: number;
    reason: 'contact_deleted' | 'contact_excluded' | 'opted_out';
  }): Promise<void> {
    await repositories.automations.lockForRunChanges({
      organizationId,
      automationIds: await repositories.openKeys.listAutomationIdsOfContact({
        organizationId,
        contactId,
      }),
    });
    const cancelled = await repositories.runs.cancelOpenRunsOfContact({
      organizationId,
      contactId,
      reason,
    });
    await this.recordEndedRuns({
      repositories,
      organizationId,
      ended: cancelled,
      status: 'cancelled',
    });
  }

  /** The keys, `status_changed` events and logs of runs a bulk statement just ended. */
  private async recordEndedRuns({
    repositories,
    organizationId,
    ended,
    status,
  }: {
    repositories: Pick<AutomationRunRepositories, 'runEvents' | 'commentLogs' | 'openKeys'>;
    organizationId: number;
    ended: readonly AutomationEndedRun[];
    status: 'cancelled';
  }): Promise<void> {
    if (ended.length === 0) return;
    await repositories.openKeys.deleteForRuns({ organizationId, runs: ended });
    const events: AutomationRunEventValues[] = ended.map((run) => ({
      organizationId,
      runId: run.id,
      runStartedAt: run.started_at,
      eventType: 'status_changed',
      status,
    }));
    await repositories.runEvents.insertMany(events);
    await repositories.commentLogs.markRunsCancelled({
      organizationId,
      runIds: ended.map((run) => run.id),
    });
  }
}
