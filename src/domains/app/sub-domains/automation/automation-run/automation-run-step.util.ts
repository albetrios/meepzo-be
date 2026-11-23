import type {
  AutomationFollowRequestMessage,
  AutomationOpeningMessage,
} from '@/domains/app/sub-domains/automation/automation.types.js';
import {
  AUTOMATION_OPENING_MESSAGE_SKIP_WINDOW_MILLISECONDS,
  type AutomationCommentLogStep,
  type AutomationRunStep,
  type AutomationRunWaitingFor,
} from './automation-run.constants.js';
import type {
  AutomationCommentLogStepChanges,
  AutomationRunStepPlan,
  AutomationWaitedStepOff,
} from './automation-run.types.js';

/** The automation fields the step planner reads (AU14: as the automation is now, at every step). */
export interface AutomationStepSource {
  is_public_reply_enabled: boolean;
  is_opening_message_enabled: boolean;
  opening_message: AutomationOpeningMessage | null;
  is_follow_required: boolean;
  follow_request_message: AutomationFollowRequestMessage | null;
  is_email_collection_enabled: boolean;
  is_phone_collection_enabled: boolean;
}

/** The contact fields the step planner reads. */
export interface AutomationStepContact {
  email: string | null;
  phone: string | null;
  /** When the account last sent the contact a DM — the opening message's 24-hour rule (D14). */
  last_message_sent_at: Date | null;
}

/**
 * The run's step → the comment log's step (D19): `comment_reply` is the log's `public_reply` then
 * `opening_dm`; `keyword_match` is the log's start (no step); the others keep their names.
 */
export function toCommentLogStep({
  runStep,
  isPublicReplyPending,
}: {
  runStep: AutomationRunStep;
  /** On `comment_reply`: whether the public reply is still to come. */
  isPublicReplyPending: boolean;
}): AutomationCommentLogStep | null {
  switch (runStep) {
    case 'keyword_match':
      return null;
    case 'comment_reply':
      return isPublicReplyPending ? 'public_reply' : 'opening_dm';
    default:
      return runStep;
  }
}

/** Whether the automation asks for the follow (AU18 step 3): required, with its request saved. */
function isFollowStepOn(
  automation: Pick<AutomationStepSource, 'is_follow_required' | 'follow_request_message'>,
): boolean {
  return automation.is_follow_required && automation.follow_request_message !== null;
}

/** The opening message the automation sends (AU18 step 2); `null` when it is off. */
function openingMessageOf(
  automation: Pick<AutomationStepSource, 'is_opening_message_enabled' | 'opening_message'>,
): AutomationOpeningMessage | null {
  return automation.is_opening_message_enabled ? automation.opening_message : null;
}

/**
 * Where a `waiting` run goes when the step it waits for is now off in its automation (AU14, D48) —
 * the next step, as if the run had no such step; `null` while the step is still on.
 *
 * @remarks
 * - **Algorithm:** the planner's own "off" of each step a run waits at
 *   ({@link planAutomationRunStep}): the opening message (its log step `sent` — the message went,
 *   only the click is no longer waited for), the follow, the email and the phone (`skipped`). Pure —
 *   the automation is read by the caller, as it is now.
 * - **Failure modes:** none.
 * - **Side effects:** none.
 */
export function planWaitedStepNowOff({
  waitingFor,
  automation,
}: {
  waitingFor: AutomationRunWaitingFor;
  automation: Pick<
    AutomationStepSource,
    | 'is_opening_message_enabled'
    | 'opening_message'
    | 'is_follow_required'
    | 'follow_request_message'
    | 'is_email_collection_enabled'
    | 'is_phone_collection_enabled'
  >;
}): AutomationWaitedStepOff | null {
  switch (waitingFor) {
    case 'opening_message_button':
      return openingMessageOf(automation) !== null
        ? null
        : { toStep: 'follow_check', commentLogChanges: { opening_dm_status: 'sent' } };
    case 'follow':
      return isFollowStepOn(automation)
        ? null
        : { toStep: 'email_collect', commentLogChanges: { follow_status: 'skipped' } };
    case 'email':
      return automation.is_email_collection_enabled
        ? null
        : { toStep: 'phone_collect', commentLogChanges: { email_status: 'skipped' } };
    case 'phone':
      return automation.is_phone_collection_enabled
        ? null
        : { toStep: 'final_dm', commentLogChanges: { phone_status: 'skipped' } };
  }
}

/** A `move` plan with its comment-log changes. */
function move({
  toStep,
  commentLogChanges = {},
}: {
  toStep: AutomationRunStep;
  commentLogChanges?: AutomationCommentLogStepChanges;
}): AutomationRunStepPlan {
  return { action: 'move', toStep, commentLogChanges };
}

/**
 * The `comment_reply` step: the comment's public reply while it is still to come, then the opening
 * message — skipped when the account sent the contact a DM in the last 24 hours (D14).
 */
function planCommentReplyStep({
  isCommentTrigger,
  isPublicReplyPending,
  automation,
  contact,
  now,
}: {
  isCommentTrigger: boolean;
  isPublicReplyPending: boolean;
  automation: AutomationStepSource;
  contact: AutomationStepContact;
  now: Date;
}): AutomationRunStepPlan {
  if (isCommentTrigger && automation.is_public_reply_enabled && isPublicReplyPending) {
    return { action: 'public_reply' };
  }
  const opening = openingMessageOf(automation);
  if (opening === null) return move({ toStep: 'follow_check' });
  const lastSentAt = contact.last_message_sent_at;
  if (
    lastSentAt !== null &&
    now.getTime() - lastSentAt.getTime() < AUTOMATION_OPENING_MESSAGE_SKIP_WINDOW_MILLISECONDS
  ) {
    return move({
      toStep: 'follow_check',
      commentLogChanges: { opening_dm_status: 'skipped' },
    });
  }
  return {
    action: 'send',
    messageKind: 'opening_message',
    waitFor: opening.button_title === null ? null : 'opening_message_button',
    nextStep: 'follow_check',
  };
}

/** The `email_collect` step: off → `phone_collect`; the contact already has one → skipped. */
function planEmailCollectStep({
  automation,
  contact,
}: {
  automation: AutomationStepSource;
  contact: AutomationStepContact;
}): AutomationRunStepPlan {
  if (!automation.is_email_collection_enabled) return move({ toStep: 'phone_collect' });
  if (contact.email !== null) {
    return move({ toStep: 'phone_collect', commentLogChanges: { email_status: 'skipped' } });
  }
  return {
    action: 'send',
    messageKind: 'email_question',
    waitFor: 'email',
    nextStep: 'phone_collect',
  };
}

/** The `phone_collect` step: off → `final_dm`; the contact already has one → skipped. */
function planPhoneCollectStep({
  automation,
  contact,
}: {
  automation: AutomationStepSource;
  contact: AutomationStepContact;
}): AutomationRunStepPlan {
  if (!automation.is_phone_collection_enabled) return move({ toStep: 'final_dm' });
  if (contact.phone !== null) {
    return move({ toStep: 'final_dm', commentLogChanges: { phone_status: 'skipped' } });
  }
  return { action: 'send', messageKind: 'phone_question', waitFor: 'phone', nextStep: 'final_dm' };
}

/**
 * Plans the next action of a `running` run at its `current_step` (AU18, schema-routes § 6.5 "Run
 * steps"), reading the automation as it is now (AU14) — a step turned off meanwhile is skipped.
 *
 * @remarks
 * - `keyword_match` → `comment_reply`.
 * - `comment_reply`: on a comment with the public reply on and not yet handled
 *   (`isPublicReplyPending`) → `public_reply`; then the opening message on **every** trigger (AQ3):
 *   off → `follow_check`; the contact got a DM from the account within 24 hours → skipped (D14);
 *   else sent — with a button the run waits for `opening_message_button`.
 * - `follow_check`: off → `email_collect`; on → `read_follow` (the engine reads Instagram, then
 *   skips or sends the request and waits for `follow`).
 * - `email_collect` / `phone_collect`: off → the next step; the contact already has it → skipped;
 *   else the question, waiting for the answer.
 * - `final_dm`: the final message, then the run completes.
 *
 * Pure: the clock is `now`.
 */
export function planAutomationRunStep({
  currentStep,
  isCommentTrigger,
  isPublicReplyPending,
  automation,
  contact,
  now,
}: {
  currentStep: AutomationRunStep;
  isCommentTrigger: boolean;
  /** Whether the comment's public reply is still to come (its log step is `off`). */
  isPublicReplyPending: boolean;
  automation: AutomationStepSource;
  contact: AutomationStepContact;
  now: Date;
}): AutomationRunStepPlan {
  switch (currentStep) {
    case 'keyword_match':
      return move({ toStep: 'comment_reply' });
    case 'comment_reply':
      return planCommentReplyStep({
        isCommentTrigger,
        isPublicReplyPending,
        automation,
        contact,
        now,
      });
    case 'follow_check':
      if (!isFollowStepOn(automation)) return move({ toStep: 'email_collect' });
      return { action: 'read_follow' };
    case 'email_collect':
      return planEmailCollectStep({ automation, contact });
    case 'phone_collect':
      return planPhoneCollectStep({ automation, contact });
    case 'final_dm':
      return { action: 'send', messageKind: 'final_message', waitFor: null, nextStep: null };
  }
}
