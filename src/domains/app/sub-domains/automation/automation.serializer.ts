import type {
  AutomationNextPostStatus,
  AutomationStatus,
  AutomationTargetScope,
  AutomationTriggerType,
} from './automation.constants.js';
import type {
  AutomationFinalMessage,
  AutomationFollowRequestMessage,
  AutomationOpeningMessage,
  AutomationOutput,
  AutomationTextMessage,
} from './automation.types.js';

/** The `app.automations` columns the automation object reads. */
interface AutomationSerializableRow {
  public_id: string;
  name: string;
  status: string;
  trigger_type: string;
  target_scope: string;
  target_instagram_media_id: string | null;
  target_instagram_story_id: string | null;
  next_post_starts_at: Date | null;
  next_post_ends_at: Date | null;
  next_post_status: string | null;
  next_post_linked_at: Date | null;
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
  final_message: AutomationFinalMessage;
  completed_run_count: number;
  last_triggered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** A stored opening message as the API shows it — `button_title` always present. */
function serializeOpeningMessage(
  message: AutomationOpeningMessage | null,
): AutomationOpeningMessage | null {
  return message === null
    ? null
    : { text: message.text, button_title: message.button_title ?? null };
}

/** A stored final message as the API shows it — `links` always an array (never null, D19). */
function serializeFinalMessage(message: AutomationFinalMessage): AutomationFinalMessage {
  return {
    text: message.text,
    links: (message.links ?? []).map((link) => ({ title: link.title, url: link.url })),
  };
}

/**
 * Maps a live `app.automations` row, its Instagram account's public id and its two users' public
 * ids to the automation object (routes-final § 3.A.6).
 *
 * @remarks
 * - **Algorithm:** names every key (no row spread): `id` from `public_id`, `instagram_account_id`
 *   the caller-resolved `iga_…` (AU27), `created_by_user_id` / `updated_by_user_id` the
 *   caller-resolved `usr_…` (or `null`), timestamps as ISO 8601, arrays and message objects copied
 *   key by key; each value list typed as its list (D19).
 * - **Failure modes:** none — a pure mapping. Only live rows reach it.
 * - **Side effects:** none.
 * - **Notes:** the internal ids and the soft-delete columns (`deleted_at`, `delete_reason`,
 *   `delete_note`) never leave.
 */
export function serializeAutomation({
  automation,
  instagram_account_public_id,
  created_by_user_public_id,
  updated_by_user_public_id,
}: {
  automation: AutomationSerializableRow;
  /** `iga_…` of the automation's account. */
  instagram_account_public_id: string;
  /** `usr_…` of the creator, or `null`. */
  created_by_user_public_id: string | null;
  /** `usr_…` of the last editor, or `null`. */
  updated_by_user_public_id: string | null;
}): AutomationOutput {
  return {
    id: automation.public_id,
    instagram_account_id: instagram_account_public_id,
    name: automation.name,
    status: automation.status as AutomationStatus,
    trigger_type: automation.trigger_type as AutomationTriggerType,
    target_scope: automation.target_scope as AutomationTargetScope,
    target_instagram_media_id: automation.target_instagram_media_id,
    target_instagram_story_id: automation.target_instagram_story_id,
    next_post_starts_at: automation.next_post_starts_at?.toISOString() ?? null,
    next_post_ends_at: automation.next_post_ends_at?.toISOString() ?? null,
    next_post_status: automation.next_post_status as AutomationNextPostStatus | null,
    next_post_linked_at: automation.next_post_linked_at?.toISOString() ?? null,
    is_dm_keyword_trigger_enabled: automation.is_dm_keyword_trigger_enabled,
    keywords: [...automation.keywords],
    tags: [...automation.tags],
    is_public_reply_enabled: automation.is_public_reply_enabled,
    public_reply_texts: [...automation.public_reply_texts],
    is_opening_message_enabled: automation.is_opening_message_enabled,
    opening_message: serializeOpeningMessage(automation.opening_message),
    is_follow_required: automation.is_follow_required,
    follow_request_message:
      automation.follow_request_message === null
        ? null
        : {
            text: automation.follow_request_message.text,
            following_button_title: automation.follow_request_message.following_button_title,
            profile_button_title: automation.follow_request_message.profile_button_title,
          },
    is_email_collection_enabled: automation.is_email_collection_enabled,
    email_request_message:
      automation.email_request_message === null
        ? null
        : { text: automation.email_request_message.text },
    is_phone_collection_enabled: automation.is_phone_collection_enabled,
    phone_request_message:
      automation.phone_request_message === null
        ? null
        : { text: automation.phone_request_message.text },
    final_message: serializeFinalMessage(automation.final_message),
    completed_run_count: automation.completed_run_count,
    last_triggered_at: automation.last_triggered_at?.toISOString() ?? null,
    created_by_user_id: created_by_user_public_id,
    updated_by_user_id: updated_by_user_public_id,
    created_at: automation.created_at.toISOString(),
    updated_at: automation.updated_at.toISOString(),
  };
}
