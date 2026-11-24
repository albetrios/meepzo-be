import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { RecordDeleteReason } from '@/shared/constants/record-fields.constants.js';
import type {
  AutomationNextPostStatus,
  AutomationSortField,
  AutomationStatus,
  AutomationTargetScope,
  AutomationTriggerType,
} from './automation.constants.js';

/**
 * The opening message (schema-routes § 10): on a comment it is the private reply to the comment,
 * on a DM or story reply a normal DM (AQ3). With a button the run waits for the click; on a
 * comment automation with this step on the button is required (AQ2).
 */
export interface AutomationOpeningMessage {
  text: string;
  /** `null` = no button. */
  button_title: string | null;
}

/** The follow request (schema-routes § 10): the "I'm following" button and the profile button. */
export interface AutomationFollowRequestMessage {
  text: string;
  following_button_title: string;
  profile_button_title: string;
}

/** The email or phone question (schema-routes § 10); the column's `null` is the default question. */
export interface AutomationTextMessage {
  text: string;
}

/** One link button of the final message — an `https://` address. */
export interface AutomationFinalMessageLink {
  title: string;
  url: string;
}

/** The final DM with up to three link buttons (schema-routes § 10) — always set (D19). */
export interface AutomationFinalMessage {
  text: string;
  links: AutomationFinalMessageLink[];
}

/**
 * The automation object every route returns (routes-final § 3.A.6): its public id, its Instagram
 * account's public id and every stored field — never the internal ids or the soft-delete columns.
 * Every value list is typed as its list (D19).
 */
export interface AutomationOutput {
  /** `aut_…`. */
  id: string;
  /** `cha_…` — the account the automation runs on (AU27). */
  instagram_account_id: string;
  name: string;
  status: AutomationStatus;
  trigger_type: AutomationTriggerType;
  target_scope: AutomationTargetScope;
  target_instagram_media_id: string | null;
  target_instagram_story_id: string | null;
  next_post_starts_at: string | null;
  next_post_ends_at: string | null;
  next_post_status: AutomationNextPostStatus | null;
  next_post_linked_at: string | null;
  is_dm_keyword_trigger_enabled: boolean;
  keywords: string[];
  tags: string[];
  is_public_reply_enabled: boolean;
  public_reply_texts: string[];
  is_opening_message_enabled: boolean;
  opening_message: AutomationOpeningMessage | null;
  is_follow_required: boolean;
  follow_request_message: AutomationFollowRequestMessage | null;
  is_email_collection_enabled: boolean;
  email_request_message: AutomationTextMessage | null;
  is_phone_collection_enabled: boolean;
  phone_request_message: AutomationTextMessage | null;
  /** Never null (D19). */
  final_message: AutomationFinalMessage;
  completed_run_count: number;
  last_triggered_at: string | null;
  /** `usr_…`, or `null` once the user is gone or for an API key (K6). */
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The fields of an automation a person writes (routes 12 and 14) — every field of the create body,
 * as the flow rules read them. The server's own fields (the account, the counters, the "next post"
 * status and link time, who and when) are never here (AU7, AU27).
 */
export interface AutomationWritableFields {
  name: string;
  status: AutomationStatus;
  trigger_type: AutomationTriggerType;
  target_scope: AutomationTargetScope;
  target_instagram_media_id: string | null;
  target_instagram_story_id: string | null;
  next_post_starts_at: Date | null;
  next_post_ends_at: Date | null;
  is_dm_keyword_trigger_enabled: boolean;
  /** Trimmed, lowercased, deduplicated (AU7). */
  keywords: string[];
  /** Trimmed, deduplicated (AU7). */
  tags: string[];
  is_public_reply_enabled: boolean;
  public_reply_texts: string[];
  is_opening_message_enabled: boolean;
  opening_message: AutomationOpeningMessage | null;
  is_follow_required: boolean;
  follow_request_message: AutomationFollowRequestMessage | null;
  is_email_collection_enabled: boolean;
  email_request_message: AutomationTextMessage | null;
  is_phone_collection_enabled: boolean;
  phone_request_message: AutomationTextMessage | null;
  final_message: AutomationFinalMessage;
}

/** A validated create body (route 12): the final message, name and trigger always; the rest optional. */
export type AutomationCreateChanges = Partial<AutomationWritableFields> &
  Pick<AutomationWritableFields, 'name' | 'trigger_type' | 'final_message'>;

/** A validated edit body (route 14): the fields it sends — `null` clears a nullable one. */
export type AutomationUpdateChanges = Partial<AutomationWritableFields>;

/**
 * The automation as it will be saved — the create's defaults or the stored row, with the body laid
 * over it — and the "next post" state the save gives it (AU8, AU9). What `validateAutomationFlow`
 * checks and the repository writes.
 */
export interface AutomationMergedFields extends AutomationWritableFields {
  next_post_status: AutomationNextPostStatus | null;
  next_post_linked_at: Date | null;
}

/** The stored "next post" state an edit starts from (AU9) — `null` on a create. */
export interface AutomationStoredNextPost {
  target_scope: AutomationTargetScope;
  next_post_starts_at: Date | null;
  next_post_ends_at: Date | null;
  next_post_status: AutomationNextPostStatus | null;
}

/** The automation list's parsed query (route 11, routes-final § 3.A.8) as the service reads it. */
export interface AutomationListQuery {
  limit: number;
  after: string | undefined;
  q: string | undefined;
  sort: AutomationSortField | undefined;
  order: 'asc' | 'desc' | undefined;
  status: AutomationStatus | undefined;
  triggerType: AutomationTriggerType | undefined;
  targetScope: AutomationTargetScope | undefined;
  nextPostStatus: AutomationNextPostStatus | undefined;
  /** `cha_…` — one account's automations (AU27); an unknown one gives an empty page. */
  instagramAccountPublicId: string | undefined;
}

/** What the repository's list takes: the query with the sort and order already resolved. */
export interface AutomationRepositoryListQuery extends Omit<AutomationListQuery, 'sort' | 'order'> {
  sort: AutomationSortField;
  order: 'asc' | 'desc';
}

/** One page of automations as the service returns it to the controller. */
export interface AutomationPageOutput {
  items: AutomationOutput[];
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
  /** The capped total on the first page; `null` after it. */
  total: number | null;
}

/** The reason and note of a delete (route 15, AU12, AQ6). */
export interface AutomationDeleteReason {
  reason: RecordDeleteReason;
  /** Required for `other`. */
  note: string | null;
}

/**
 * What one registered open-run cancel step receives (AU12): the deleted automation, inside route
 * 15's transaction, after the soft delete.
 */
export interface AutomationOpenRunCancelInput {
  /** `tenancy.organizations.id`. */
  organizationId: number;
  /** `app.automations.id`. */
  automationId: number;
}

/**
 * A step the run sub-domain (3.B) registers through the app container to cancel the deleted
 * automation's `running` and `waiting` runs in the same transaction as the delete (AU12,
 * `cancelAutomationOpenRuns`). It runs inside route 15's unit of work, so its repository calls join
 * that transaction; a throw rolls the whole delete back. Answers the number of runs it cancelled —
 * the audit entry's `cancelled_run_count`.
 */
export type AutomationOpenRunCancelStep = (input: AutomationOpenRunCancelInput) => Promise<number>;

/** Input of route 11's service call. */
export interface AutomationListInput {
  scope: OrganizationPrincipalDatabaseScope;
  query: AutomationListQuery;
}

/** Input of route 12's service call. */
export interface AutomationCreateInput {
  scope: OrganizationPrincipalDatabaseScope;
  changes: AutomationCreateChanges;
  /** `usr_…` of the caller; `undefined` for an API key. */
  createdByUserPublicId: string | undefined;
}

/** Input of route 13's service call. */
export interface AutomationGetInput {
  scope: OrganizationPrincipalDatabaseScope;
  /** `aut_…` from the path. */
  automationPublicId: string;
}

/** Input of route 14's service call. */
export interface AutomationUpdateInput extends AutomationGetInput {
  changes: AutomationUpdateChanges;
  /** The version the client opened (AU11); `undefined` = no check. */
  expectedUpdatedAt: string | undefined;
  /** `usr_…` of the caller; `undefined` for an API key. */
  updatedByUserPublicId: string | undefined;
}

/** Input of route 15's service call. */
export interface AutomationDeleteInput extends AutomationGetInput {
  removal: AutomationDeleteReason;
  /** `usr_…` of the caller; `undefined` for an API key. */
  deletedByUserPublicId: string | undefined;
}

/** What route 15 answers the controller for its audit entry (AU4). */
export interface AutomationDeleteResult {
  automationPublicId: string;
  cancelledRunCount: number;
}

/** Input of `linkNextPostAutomations` (AU15, 3.B.8) — sub-domain 4's call for each comment. */
export interface AutomationLinkNextPostInput {
  /** The job's organization scope, relayed by sub-domain 4 (never minted here). */
  scope: OrganizationPrincipalDatabaseScope;
  /** `cha_…` — the event's Instagram account (AU27). */
  instagramAccountPublicId: string;
  /** The commented post's Instagram media id. */
  instagramMediaId: string;
  /** The post's publish time — the window must hold it. */
  publishedAt: Date;
}

/** Input of the expiry worker's per-organization change (AU15, WC-6). */
export interface AutomationNextPostExpiryInput {
  /** The organization's job scope, minted by the expiry worker. */
  scope: OrganizationPrincipalDatabaseScope;
  /** `app.automations.id` of the due automations the scan found in this organization. */
  automationIds: readonly number[];
  /** The scan's time: only a window that ended before it expires. */
  endedBefore: Date;
}
