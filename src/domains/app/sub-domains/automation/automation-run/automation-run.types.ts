import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { ContactRow } from '@/domains/app/sub-domains/contact/contact.repository.js';
import type { AutomationRunTriggerType } from './automation-run.constants.js';
import type {
  AutomationCommentLogErrorType,
  AutomationCommentLogStepStatus,
  AutomationRunSendingMessageKind,
  AutomationRunStep,
  AutomationRunWaitingFor,
} from './automation-run.constants.js';

/**
 * The trigger of a queued automation (AU21, schema-routes § 10): what started it, kept so the run
 * it becomes starts exactly as the original trigger would have.
 */
export interface AutomationQueuedTrigger {
  type: AutomationRunTriggerType;
  instagram_media_id?: string;
  instagram_comment_id?: string;
  instagram_story_id?: string;
  /** The comment, story reply or DM text (personal data — emptied by the contact erase, AU26). */
  text: string | null;
}

/**
 * One automation queued behind a run's email question (AU21): its public id (queue rule § 3.1 —
 * public ids only), when it was queued and its trigger. One entry per automation.
 */
export interface AutomationQueuedEntry {
  /** `aut_…`. */
  automation_id: string;
  /** ISO 8601. */
  queued_at: string;
  trigger: AutomationQueuedTrigger;
}

/**
 * The webhook event a run-engine call handles (3.B.8): its key (unique per account, 4.B.3), Meta's
 * own time, and whether this is its last processing attempt — on the last attempt a temporary
 * Instagram error fails the run instead of being rethrown, so no run stays `running` (AU19).
 */
export interface AutomationRunEvent {
  /** The stored webhook event's key (`comment:<id>`, `message:<mid>`, `postback:<…>`). */
  eventKey: string;
  /** The event's own time. */
  occurredAt: Date;
  /** `true` on the event's last processing attempt (sub-domain 4's cap, D16). */
  isLastAttempt: boolean;
  /** The processing job's id, carried to Instagram calls and log lines. */
  requestId?: string | undefined;
}

/**
 * What every run-engine entry point takes (3.B.8): the job's organization scope (relayed by
 * sub-domain 4, never minted here), the event's Instagram account, the contact
 * `recordContactInteraction` returned, and the event.
 */
export interface AutomationRunTriggerInput {
  /** The job's organization scope, minted by sub-domain 4's worker and relayed here. */
  scope: OrganizationPrincipalDatabaseScope;
  /** `cha_…` — every match is limited to this account's automations (AU27). */
  instagramAccountPublicId: string;
  /** The contact of the event (sub-domain 2's row). */
  contact: ContactRow;
  event: AutomationRunEvent;
}

/** Input of `startCommentRun` — a comment on one of the account's posts (AU16). */
export interface AutomationCommentRunInput extends AutomationRunTriggerInput {
  instagramCommentId: string;
  instagramMediaId: string;
  /** The comment's text (`null` when Meta sent none). */
  text: string | null;
  /** The commenter's username, when the event carried one. */
  commenterUsername: string | null;
}

/** Input of `handleDirectMessage` — a DM or a `messages` change (D18). */
export interface AutomationDirectMessageInput extends AutomationRunTriggerInput {
  /** The typed text (`null` for an attachment-only message). */
  text: string | null;
  /** `message.quick_reply.payload` — the email or phone Instagram's own quick reply sent. */
  quickReplyPayload: string | null;
  /** `message.attachments[].payload.email` (D18). */
  attachmentEmail: string | null;
}

/** Input of `startStoryReplyRun` — a reply to one of the account's stories. */
export interface AutomationStoryReplyRunInput extends AutomationRunTriggerInput {
  instagramStoryId: string;
  text: string | null;
}

/** Input of `handleButtonClick` — a postback whose payload is `<aut_…>::<run_…>`. */
export interface AutomationButtonClickInput extends AutomationRunTriggerInput {
  /** `aut_…` from the payload. */
  automationPublicId: string;
  /** `run_…` from the payload. */
  runPublicId: string;
}

/**
 * What one entry point did, for sub-domain 4's event status and logs:
 * - `run_started` — a run started (and was advanced as far as it goes);
 * - `run_continued` — a waiting run took the event (an answer, a click) and moved on, or one went on
 *   past a step now off and nothing else moved (AU14);
 * - `run_resumed` — a retried event resumed the runs it had moved (AU19);
 * - `answer_invalid` — an email or phone answer was not valid (asked again, or kept waiting);
 * - `comment_logged` — the chosen automation was held back by AU17 and logged, no run;
 * - `question_asked_again` — another run waits for the contact's email: asked again (AU17 (1));
 * - `ignored` — a click the run does not take, a match held back by AU17 (D18), an automation deleted
 *   or turned off before its run could start (AU12), or a contact erased while its event was being
 *   handled (CT9);
 * - `nothing_matched` — no automation of the account matched;
 * - `account_unavailable` — the account is not this organization's connected account (AU27);
 * - `already_handled` — a retried event whose work was already done.
 */
export type AutomationRunHandlingOutcome =
  | 'run_started'
  | 'run_continued'
  | 'run_resumed'
  | 'answer_invalid'
  | 'comment_logged'
  | 'question_asked_again'
  | 'ignored'
  | 'nothing_matched'
  | 'account_unavailable'
  | 'already_handled';

/** The result of one run-engine entry point (3.B.8). */
export interface AutomationRunHandlingResult {
  outcome: AutomationRunHandlingOutcome;
  /** `run_…` of every run this call started, continued or resumed, in order. */
  runPublicIds: string[];
  /**
   * How a run failed in this call — `token` when the account was marked broken (sub-domain 4 then
   * fails the event at once, WH14); `null` when none failed.
   */
  failedErrorType: AutomationCommentLogErrorType | null;
}

/**
 * A webhook event sub-domain 4 marked `failed`, or `skipped` after a claim, as it tells the run engine
 * (AU19, WH14, D47, D51) — the runs it left `running` are failed with its code.
 */
export interface AutomationFailedEventInput {
  /** The job's organization scope, relayed by sub-domain 4. */
  scope: OrganizationPrincipalDatabaseScope;
  /** `tenancy.organizations.id` of the scope's organization. */
  organizationId: number;
  /** The event's key — `last_instagram_event_key` of the runs it moved last. */
  eventKey: string;
  /**
   * The failed event's own `error_message` — a code and a short reason, never text a person wrote
   * (WH14) — or the skipped one's reason (`automation_disabled`, `account_disconnected`).
   */
  errorCode: string;
}

/** The organization and the internal ids every single-run statement names. */
export interface AutomationRunKey {
  /** `tenancy.organizations.id`. */
  organizationId: number;
  /** `app.automation_runs.id`. */
  runId: number;
}

/**
 * The comment-log changes one step makes — every field optional; `current_step` and the step
 * statuses use the log's own names (D19).
 */
export interface AutomationCommentLogStepChanges {
  public_reply_status?: AutomationCommentLogStepStatus;
  opening_dm_status?: AutomationCommentLogStepStatus;
  follow_status?: AutomationCommentLogStepStatus;
  email_status?: AutomationCommentLogStepStatus;
  phone_status?: AutomationCommentLogStepStatus;
}

/**
 * A `waiting` run's step that is now off in its automation (AU14, D48): the step the run goes on to,
 * and how its comment log closes the one it waited at.
 */
export interface AutomationWaitedStepOff {
  toStep: AutomationRunStep;
  commentLogChanges: AutomationCommentLogStepChanges;
}

/**
 * What the step planner decided for a `running` run (AU18) — one action, then the engine loops:
 * - `move` — go to `toStep` with nothing sent (a step off, or skipped by its rule);
 * - `public_reply` — the comment's public reply (reply safety decides, AU20);
 * - `send` — claim → send → record one message; then wait for `waitFor`, go to `nextStep`, or
 *   complete the run (`nextStep` `null`);
 * - `read_follow` — read the follow status through Instagram, then skip or send the request.
 */
export type AutomationRunStepPlan =
  | {
      action: 'move';
      toStep: AutomationRunStep;
      commentLogChanges: AutomationCommentLogStepChanges;
    }
  | { action: 'public_reply' }
  | {
      action: 'send';
      messageKind: AutomationRunSendingMessageKind;
      waitFor: AutomationRunWaitingFor | null;
      /** The step after the send; `null` = the run completes. */
      nextStep: AutomationRunStep | null;
    }
  | { action: 'read_follow' };
