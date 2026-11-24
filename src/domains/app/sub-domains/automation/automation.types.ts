import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { RecordDeleteReason } from '@/shared/constants/record-fields.constants.js';
import type { ChannelFeature } from '@/domains/app/sub-domains/channel-account/channel-account-capabilities.constants.js';
import type {
  AutomationAlsoStartFrom,
  AutomationDefaultReplyMode,
  AutomationKeywordTestSource,
  AutomationNextPostStatus,
  AutomationPauseMode,
  AutomationSortField,
  AutomationStatus,
  AutomationTargetScope,
  AutomationTriggerType,
} from './automation.constants.js';
import type { AutomationSteps } from './automation-steps.dto.js';

/**
 * The fields a person writes on an automation (routes 28 and 30, routes-final § 4.A.8) — never
 * `status` (actions only, AU3), the account (fixed at create), the counters, the stop or the
 * next-post state.
 */
export interface AutomationWritableFields {
  name: string;
  trigger_type: AutomationTriggerType;
  also_start_from: AutomationAlsoStartFrom[];
  target_scope: AutomationTargetScope;
  target_instagram_media_id: string | null;
  target_instagram_story_id: string | null;
  /** `between` only — `next` takes the go-live time (AU20). */
  target_starts_at: Date | null;
  target_ends_at: Date | null;
  keywords: string[];
  ref_code: string | null;
  starter_questions: string[];
  ad_id: string | null;
  trigger_tag: string | null;
  default_reply_mode: AutomationDefaultReplyMode | null;
  is_public_reply_enabled: boolean;
  public_reply_texts: string[];
  is_public_reply_mention_enabled: boolean;
  is_reply_like_person_enabled: boolean;
  public_reply_hour_limit: number | null;
  is_hide_comment_after_direct_message_enabled: boolean;
  steps: AutomationSteps;
}

/** Route 28's body after validation: the three required fields and any other writable one. */
export type AutomationCreateChanges = Partial<AutomationWritableFields> &
  Pick<AutomationWritableFields, 'name' | 'trigger_type'> & {
    /** `cha_…` — the account the draft is saved on (AU11). */
    channel_account_id: string;
  };

/** Route 30's body after validation: any writable field. */
export type AutomationUpdateChanges = Partial<AutomationWritableFields>;

/** One go-live problem (AU13, AUQ1): its step path, its reason and the translation of its detail. */
export interface AutomationProblem {
  /** The step path (`steps.hello.versions.0.buttons`) or the column (`ref_code`). */
  field: string;
  /** A stable snake_case reason (`missing`, `too_long`, `plan_lacks_feature`, …). */
  reason: string;
  /** The `errors:automationProblems.*` key of the detail. */
  messageKey: string;
  messageParams?: Record<string, string | number>;
}

/** One warning of routes 30 and 32 (`meta.warnings`, AU13): never a refusal. */
export interface AutomationWarning {
  reason: 'keyword_shared' | 'account_private';
  field: string;
  /** The `warnings:` key and its parameters, translated by the controller. */
  messageKey: string;
  messageParams?: Record<string, string | number>;
}

/** The counts of the automation object (4.A.6, AU19): totals, `% tapped` and per step version. */
export interface AutomationCountsOutput {
  runs_started: number;
  taps: number;
  typed_answers: number;
  /** (taps + typed answers) / runs, 0–100 with one decimal; `null` before the first run (D61). */
  tapped_percent: number | null;
  by_version: Record<string, { runs_started: number; taps: number; typed_answers: number }>;
}

/** The Automation object of routes 28–30 and 32–34 (routes-final § 4.A.6). */
export interface AutomationOutput {
  /** `aut_…`. */
  id: string;
  /** `cha_…`. */
  channel_account_id: string;
  name: string;
  status: AutomationStatus;
  channel: string;
  trigger_type: AutomationTriggerType;
  also_start_from: AutomationAlsoStartFrom[];
  target_scope: AutomationTargetScope;
  target_instagram_media_id: string | null;
  target_instagram_story_id: string | null;
  target_starts_at: string | null;
  target_ends_at: string | null;
  next_post_status: AutomationNextPostStatus | null;
  next_post_linked_at: string | null;
  keywords: string[];
  ref_code: string | null;
  /** `https://ig.me/m/<username>?ref=<ref_code>` for a `ref_link` with both known; else `null`. */
  link_url: string | null;
  starter_questions: string[];
  ad_id: string | null;
  trigger_tag: string | null;
  default_reply_mode: AutomationDefaultReplyMode | null;
  is_public_reply_enabled: boolean;
  public_reply_texts: string[];
  is_public_reply_mention_enabled: boolean;
  is_reply_like_person_enabled: boolean;
  public_reply_hour_limit: number | null;
  is_hide_comment_after_direct_message_enabled: boolean;
  steps: AutomationSteps;
  stopped_reason: string | null;
  stopped_at: string | null;
  cancelled_before_at: string | null;
  counts: AutomationCountsOutput;
  /** The PRO parts it uses that the plan ignores now — the editor's "PRO, off on your plan" (D57). */
  pro_parts_off: ChannelFeature[];
  /** The open past-comments read (4.C, ROUTE row R15) — `null` until then. */
  open_backfill: null;
  last_triggered_at: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/** The Automation list row of route 27 (routes-final § 4.A.6). */
export interface AutomationListRowOutput {
  id: string;
  channel_account_id: string;
  name: string;
  status: AutomationStatus;
  trigger_type: AutomationTriggerType;
  stopped_reason: string | null;
  runs_started: number;
  tapped_percent: number | null;
  last_triggered_at: string | null;
  updated_at: string;
  created_at: string;
}

/** Route 27's parsed query (AU10). */
export interface AutomationListQuery {
  limit: number;
  after: string | undefined;
  q: string | undefined;
  sort: AutomationSortField | undefined;
  order: 'asc' | 'desc' | undefined;
  channelAccountPublicId: string;
  statuses: AutomationStatus[];
  triggerTypes: AutomationTriggerType[];
}

/** The list query with the sort and order the service resolved. */
export interface AutomationRepositoryListQuery extends Omit<AutomationListQuery, 'sort' | 'order'> {
  sort: AutomationSortField;
  order: 'asc' | 'desc';
}

/** One page of route 27 with its `meta.totals` (AU10). */
export interface AutomationPageOutput {
  items: AutomationListRowOutput[];
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
  totals: { live_count: number; runs_started: number };
}

/** Route 31's optional reason and note (AU16, P11). */
export interface AutomationDeleteReason {
  reason: RecordDeleteReason | null;
  note: string | null;
}

/**
 * What a registered open-run cancel step gets (AU16): the automation being deleted, inside the
 * delete's transaction.
 */
export interface AutomationOpenRunCancelInput {
  organizationId: number;
  automationId: number;
}

/**
 * One step the automation delete runs in its transaction after the soft delete (AU16): it cancels
 * the automation's open runs and answers how many it cancelled. The run engine registers its
 * `cancelAutomationOpenRuns` (4.B) through the app container.
 */
export type AutomationOpenRunCancelStep = (input: AutomationOpenRunCancelInput) => Promise<number>;

/** The scope and organization a route works in. */
export interface AutomationScopeInput {
  scope: OrganizationPrincipalDatabaseScope;
}

/** Route 27's input. */
export interface AutomationListInput extends AutomationScopeInput {
  query: AutomationListQuery;
}

/** Route 28's input. */
export interface AutomationCreateInput extends AutomationScopeInput {
  changes: AutomationCreateChanges;
  createdByUserPublicId: string | undefined;
}

/** The input of every single-automation route. */
export interface AutomationGetInput extends AutomationScopeInput {
  /** `aut_…`. */
  automationPublicId: string;
}

/** Route 30's input. */
export interface AutomationUpdateInput extends AutomationGetInput {
  changes: AutomationUpdateChanges;
  expectedUpdatedAt: string | undefined;
  updatedByUserPublicId: string | undefined;
}

/** Route 31's input. */
export interface AutomationDeleteInput extends AutomationGetInput {
  removal: AutomationDeleteReason;
  deletedByUserPublicId: string | undefined;
}

/** What route 31 did, for the controller's audit entry. */
export interface AutomationDeleteResult {
  automationPublicId: string;
  cancelledRunCount: number;
}

/** Routes 32 and 34's input (no body). */
export interface AutomationActionInput extends AutomationGetInput {
  actingUserPublicId: string | undefined;
}

/** Route 33's input. */
export interface AutomationPauseInput extends AutomationActionInput {
  mode: AutomationPauseMode;
}

/** An automation and the warnings of its save or go-live (routes 30 and 32). */
export interface AutomationWithWarningsOutput {
  automation: AutomationOutput;
  warnings: AutomationWarning[];
  /** Whether the action changed anything (route 32's repeat is a no-op, AU3). */
  isChanged: boolean;
}

/** Route 35's input (AU17). */
export interface AutomationKeywordTestInput extends AutomationGetInput {
  text: string;
  source: AutomationKeywordTestSource | undefined;
}

/** Route 35's answer — the Keyword test result (4.A.6). */
export interface AutomationKeywordTestOutput {
  is_match: boolean;
  matched_keyword: string | null;
  match_kind: 'exact' | 'close' | null;
  first_answering_automation: { id: string; name: string } | null;
  reason: 'no_keyword' | 'not_live' | 'other_answers_first' | null;
}

/** The "next post" linking input (AU20): one new post of one account. */
export interface AutomationLinkNextPostInput extends AutomationScopeInput {
  /** `cha_…` of the post's account. */
  channelAccountPublicId: string;
  instagramMediaId: string;
  publishedAt: Date;
}

/**
 * The starter-question sync (AU6, IA6 — sub-domain 2's job, ROUTE row R40): after a go-live, pause,
 * delete or question change of a starter-question automation, the account's ice breakers are set
 * again at Instagram after commit. Optional until R40 wires it; without it nothing is enqueued.
 */
export interface AutomationStarterQuestionSyncQueue {
  enqueueStarterQuestionSync(input: {
    organizationPublicId: string;
    channelAccountPublicId: string;
  }): Promise<void>;
}

/** The month limit at go-live (check 4, D34) — sub-domain 6's month count (`readOrganizationPlanStop`). */
export interface AutomationMonthLimitPort {
  readOrganizationPlanStop(input: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
  }): Promise<'plan_limit' | null>;
}

/** The usable-file read at go-live (check 15, D58) — the upload domain's `findUsableMessageFile` (R12). */
export interface AutomationMessageFilePort {
  findUsableMessageFile(input: {
    scope: OrganizationPrincipalDatabaseScope;
    uploadPublicId: string;
  }): Promise<{ upload_public_id: string; content_type: string } | null>;
}
