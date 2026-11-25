import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { ContactRow } from '@/domains/app/sub-domains/contact/contact.repository.js';

/**
 * A run's `version_numbers` (AU21, AU27 — the plan's `version_nos`): the hello and follow-ask
 * versions picked at the start, the email and phone wording last sent, how many times each was asked
 * (`ASK_AGAIN_MAX`), and — for a run a tag started — its tag chain number (D45).
 */
export interface AutomationRunVersionNumbers {
  hello?: number;
  follow?: number;
  email?: number;
  phone?: number;
  email_asks?: number;
  phone_asks?: number;
  /** The chain number of the tag event that started the run (3.B), so its own tags go one further. */
  tag_chain?: number;
}

/**
 * The event a run-engine call handles (4.B.10, the inbound seam): its key (unique per account), its
 * own id (the "every time" once key, D65), the channel's own time and the last-attempt flag.
 */
export interface AutomationRunEvent {
  /** The stored event's key (`comment:<id>`, `message:<mid>`, `postback:<…>`). */
  eventKey: string;
  /** The event's own id as the channel sent it — the comment id, the message id, … (D65). */
  eventId: string;
  /** The event's own time — the 7-day clock (D9). */
  occurredAt: Date;
  /** `true` on the event's last processing attempt (kept for the intake's log lines). */
  isLastAttempt: boolean;
  /** The processing job's id, carried to log lines. */
  requestId?: string | undefined;
}

/**
 * What every run-engine entry point takes (4.B.10): the job's organization scope (relayed by the
 * channel's intake, never minted here), the event's channel account, the contact intake recorded,
 * and the event — channel-neutral inputs only (AU34).
 */
export interface AutomationRunTriggerInput {
  /** The job's organization scope, minted by the intake's worker and relayed here. */
  scope: OrganizationPrincipalDatabaseScope;
  /** `cha_…` — every match is limited to this account's automations. */
  channelAccountPublicId: string;
  /** The contact of the event (sub-domain 3's row). */
  contact: ContactRow;
  event: AutomationRunEvent;
}

/** The comment kinds `startCommentRun` takes (normalized — 4.B.10). */
export type AutomationCommentKind = 'comment' | 'live_comment' | 'ad_comment';

/** Input of `startCommentRun` — a comment, a Live comment or an ad comment (AU22, AU23, AU28). */
export interface AutomationCommentRunInput extends AutomationRunTriggerInput {
  kind: AutomationCommentKind;
  commentId: string;
  mediaId: string;
  /** The ad the commented post belongs to (`media.ad_id`), when it is an ad. */
  adId?: string | null;
  /** The comment this one replies under (`parent_id`, D64); `null` for a top-level comment. */
  parentCommentId?: string | null;
  /** The connected account's own comment (P24) — never starts anything. */
  isOwnComment?: boolean;
  /** When the commented post was published — the `between` scope (AU8). */
  mediaPublishedAt?: Date | null;
  /** The comment's text (`null` when the channel sent none). */
  text: string | null;
  /** The commenter's username, when the event carried one. */
  commenterUsername: string | null;
}

/** The message kinds `handleDirectMessage` takes (normalized — 4.B.10). */
export type AutomationMessageEventKind =
  | 'message'
  | 'story_reply'
  | 'story_mention'
  | 'shared_post';

/** Input of `handleDirectMessage` — a DM, a story reply or mention, a shared post (plan §4.3). */
export interface AutomationDirectMessageInput extends AutomationRunTriggerInput {
  kind: AutomationMessageEventKind;
  /** The typed text (`null` for an attachment-only message). */
  text: string | null;
  /** `message.quick_reply.payload` — the email or phone the channel's own quick reply sent. */
  quickReplyPayload: string | null;
  /** An attachment's email (D18). */
  attachmentEmail: string | null;
  /** The story replied to or mentioned in. */
  storyId?: string | null;
  /** The shared post. */
  sharedMediaId?: string | null;
  /** Her first ever DM to the account (`first_message_at` was empty — plan §4.3 rule 3). */
  isFirstMessage?: boolean;
  /** The owner typed to her by hand in the last 6 hours — "no other automation answered" waits. */
  isOwnerChatting?: boolean;
}

/** The tap kinds `handleButtonClick` takes (normalized — 4.B.10). */
export type AutomationTapKind = 'postback' | 'starter_question' | 'ref_link' | 'ad_message';

/** Input of `handleButtonClick` — a tap on our button, a starter question, an ig.me link, an ad. */
export interface AutomationButtonClickInput extends AutomationRunTriggerInput {
  kind?: AutomationTapKind;
  /** `aut_…` from a postback payload. */
  automationPublicId?: string | null;
  /** `run_…` from a postback payload. */
  runPublicId?: string | null;
  /** The starter question's text (`starter_question`). */
  starterQuestion?: string | null;
  /** The link's `ref` (`ref_link`). */
  refCode?: string | null;
  /** The ad's id (`ad_message`). */
  adId?: string | null;
}

/** Input of `startTagRun` — a tag added to or removed from her (3.B's tag event). */
export interface AutomationTagRunInput extends AutomationRunTriggerInput {
  change: 'added' | 'removed';
  tag: string;
  /** `app.contact_tag_events.id` — the once key (`tag:<tag>:<event id>`). */
  tagEventId: number;
  /** The event's chain number (3.B, D45). */
  chainNumber: number;
  /** The automation whose tag step made it — it never starts itself. */
  sourceAutomationId: number | null;
}

/**
 * What one entry point did, for the intake's event status and logs:
 * - `run_started` — a run started;
 * - `run_continued` — a waiting run took the event (an answer, a tap) and moved on;
 * - `run_replaced` — an allowed comment replaced her open run (P35);
 * - `answer_invalid` — an email or phone answer was not valid (asked again, or kept waiting);
 * - `comment_logged` — the chosen automation was held back and logged, no run;
 * - `ignored` — held back (once key, open run, paused, opted out, a tap we do not take, an
 *   automation deleted or turned off before its lock, an erased contact);
 * - `nothing_matched` — no automation of the account matched;
 * - `account_unavailable` — the account is not this organization's connected account;
 * - `already_handled` — a retried event whose work was already done.
 */
export type AutomationRunHandlingOutcome =
  | 'run_started'
  | 'run_continued'
  | 'run_replaced'
  | 'answer_invalid'
  | 'comment_logged'
  | 'ignored'
  | 'nothing_matched'
  | 'account_unavailable'
  | 'already_handled';

/** The result of one run-engine entry point (4.B.10). */
export interface AutomationRunHandlingResult {
  outcome: AutomationRunHandlingOutcome;
  /** `run_…` of every run this call started or moved, in order. */
  runPublicIds: string[];
  /** Kept for the intake's contract: the engine no longer calls a channel, so always `null`. */
  failedErrorType: null;
}

/**
 * A webhook event the intake marked `failed`, or `skipped` after a claim, as it tells the run engine
 * — the runs it left `running` are failed with its code.
 */
export interface AutomationFailedEventInput {
  /** The job's organization scope, relayed by the intake. */
  scope: OrganizationPrincipalDatabaseScope;
  /** `tenancy.organizations.id` of the scope's organization. */
  organizationId: number;
  /** The event's key — `last_instagram_event_key` of the runs it moved last. */
  eventKey: string;
  /** The failed event's own code, or the skipped one's reason — never text a person wrote. */
  errorCode: string;
}

/** The organization, the internal id and the start month every single-run statement names. */
export interface AutomationRunKey {
  /** `tenancy.organizations.id`. */
  organizationId: number;
  /** `app.automation_runs.id`. */
  runId: number;
  /** `app.automation_runs.started_at` — the run's month part (AU36). */
  runStartedAt: Date;
}
