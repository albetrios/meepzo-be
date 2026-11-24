import type { ChannelFeature } from '@/domains/app/sub-domains/channel-account/channel-account-capabilities.constants.js';
import type {
  AutomationAlsoStartFrom,
  AutomationDefaultReplyMode,
  AutomationNextPostStatus,
  AutomationStatus,
  AutomationTargetScope,
  AutomationTriggerType,
} from './automation.constants.js';
import type { AutomationSteps } from './automation-steps.dto.js';
import type {
  AutomationCountsOutput,
  AutomationListRowOutput,
  AutomationOutput,
} from './automation.types.js';

/** The `app.automations` columns the automation object reads. */
interface AutomationSerializableRow {
  public_id: string;
  channel: string;
  name: string;
  status: string;
  trigger_type: string;
  also_start_from: string[];
  target_scope: string;
  target_instagram_media_id: string | null;
  target_instagram_story_id: string | null;
  target_starts_at: Date | null;
  target_ends_at: Date | null;
  next_post_status: string | null;
  next_post_linked_at: Date | null;
  keywords: string[];
  ref_code: string | null;
  starter_questions: string[];
  ad_id: string | null;
  trigger_tag: string | null;
  default_reply_mode: string | null;
  is_public_reply_enabled: boolean;
  public_reply_texts: string[];
  is_public_reply_mention_enabled: boolean;
  is_reply_like_person_enabled: boolean;
  public_reply_hour_limit: number | null;
  is_hide_comment_after_direct_message_enabled: boolean;
  steps: AutomationSteps;
  stopped_reason: string | null;
  stopped_at: Date | null;
  cancelled_before_at: Date | null;
  last_triggered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * The empty counts of an automation that never ran (AU19).
 *
 * @remarks
 * Pure: a fresh object each call, so a caller may fill it.
 */
export function emptyAutomationCounts(): AutomationCountsOutput {
  return { runs_started: 0, taps: 0, typed_answers: 0, tapped_percent: null, by_version: {} };
}

/** An instant as ISO 8601, or `null`. */
function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** A `ref_link` automation's chat link (`https://ig.me/m/<username>?ref=<ref_code>`, AU17). */
export function buildAutomationLinkUrl({
  triggerType,
  refCode,
  username,
}: {
  triggerType: string;
  refCode: string | null;
  username: string | null;
}): string | null {
  if (triggerType !== 'ref_link' || refCode === null || username === null) return null;
  return `https://ig.me/m/${encodeURIComponent(username)}?ref=${encodeURIComponent(refCode)}`;
}

/**
 * Shapes one automation as the Automation object of routes 28–30 and 32–34 (routes-final § 4.A.6):
 * the public ids of the automation, its channel account and its two users; the counts summed from
 * the slot rows (zero before the first run); the PRO parts the plan ignores now; the `ref_link`
 * chat link.
 *
 * @remarks
 * Pure — the service resolves the ids, the counts, `pro_parts_off` and the username first. Internal
 * ids, the soft-delete fields and `channel_account_id`'s internal value never leave. `open_backfill`
 * is `null` until the past-comments read lands (4.C, ROUTE row R15).
 */
export function serializeAutomation({
  automation,
  channel_account_public_id,
  created_by_user_public_id,
  updated_by_user_public_id,
  counts,
  pro_parts_off,
  username,
}: {
  automation: AutomationSerializableRow;
  channel_account_public_id: string;
  created_by_user_public_id: string | null;
  updated_by_user_public_id: string | null;
  counts: AutomationCountsOutput | undefined;
  pro_parts_off: ChannelFeature[];
  /** The account's Instagram username (the `ref_link` chat link), `null` when unknown. */
  username: string | null;
}): AutomationOutput {
  return {
    id: automation.public_id,
    channel_account_id: channel_account_public_id,
    name: automation.name,
    status: automation.status as AutomationStatus,
    channel: automation.channel,
    trigger_type: automation.trigger_type as AutomationTriggerType,
    also_start_from: [...automation.also_start_from] as AutomationAlsoStartFrom[],
    target_scope: automation.target_scope as AutomationTargetScope,
    target_instagram_media_id: automation.target_instagram_media_id,
    target_instagram_story_id: automation.target_instagram_story_id,
    target_starts_at: toIso(automation.target_starts_at),
    target_ends_at: toIso(automation.target_ends_at),
    next_post_status: automation.next_post_status as AutomationNextPostStatus | null,
    next_post_linked_at: toIso(automation.next_post_linked_at),
    keywords: [...automation.keywords],
    ref_code: automation.ref_code,
    link_url: buildAutomationLinkUrl({
      triggerType: automation.trigger_type,
      refCode: automation.ref_code,
      username,
    }),
    starter_questions: [...automation.starter_questions],
    ad_id: automation.ad_id,
    trigger_tag: automation.trigger_tag,
    default_reply_mode: automation.default_reply_mode as AutomationDefaultReplyMode | null,
    is_public_reply_enabled: automation.is_public_reply_enabled,
    public_reply_texts: [...automation.public_reply_texts],
    is_public_reply_mention_enabled: automation.is_public_reply_mention_enabled,
    is_reply_like_person_enabled: automation.is_reply_like_person_enabled,
    public_reply_hour_limit: automation.public_reply_hour_limit,
    is_hide_comment_after_direct_message_enabled:
      automation.is_hide_comment_after_direct_message_enabled,
    steps: automation.steps,
    stopped_reason: automation.stopped_reason,
    stopped_at: toIso(automation.stopped_at),
    cancelled_before_at: toIso(automation.cancelled_before_at),
    counts: counts ?? emptyAutomationCounts(),
    pro_parts_off,
    open_backfill: null,
    last_triggered_at: toIso(automation.last_triggered_at),
    created_by_user_id: created_by_user_public_id,
    updated_by_user_id: updated_by_user_public_id,
    created_at: automation.created_at.toISOString(),
    updated_at: automation.updated_at.toISOString(),
  };
}

/**
 * Shapes one automation as the Automation list row of route 27 (routes-final § 4.A.6): its all-time
 * `runs_started` and `tapped_percent` (D61) from the summed slot rows; a draft's `updated_at`
 * ("edited 1h ago").
 *
 * @remarks
 * Pure.
 */
export function serializeAutomationListRow({
  automation,
  channel_account_public_id,
  counts,
}: {
  automation: AutomationSerializableRow;
  channel_account_public_id: string;
  counts: AutomationCountsOutput | undefined;
}): AutomationListRowOutput {
  return {
    id: automation.public_id,
    channel_account_id: channel_account_public_id,
    name: automation.name,
    status: automation.status as AutomationStatus,
    trigger_type: automation.trigger_type as AutomationTriggerType,
    stopped_reason: automation.stopped_reason,
    runs_started: counts?.runs_started ?? 0,
    tapped_percent: counts?.tapped_percent ?? null,
    last_triggered_at: toIso(automation.last_triggered_at),
    updated_at: automation.updated_at.toISOString(),
    created_at: automation.created_at.toISOString(),
  };
}
