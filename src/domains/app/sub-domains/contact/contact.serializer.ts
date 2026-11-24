import { CONTACT_CHAT_WINDOW_MS } from './contact.constants.js';
import type { ContactDetailOutput, ContactOutput, ContactTagCountOutput } from './contact.types.js';

/** The columns the Contact object reads: the contact's, its activity row's and two public ids. */
export interface ContactSerializableRow {
  public_id: string;
  channel: string;
  instagram_user_id: string | null;
  username: string | null;
  full_name: string | null;
  profile_picture_url: string | null;
  followers_count: number | null;
  is_following_account: boolean | null;
  follow_checked_at: Date | null;
  email: string | null;
  email_collected_at: Date | null;
  phone: string | null;
  phone_collected_at: Date | null;
  tags: string[];
  opted_out_at: Date | null;
  automations_off_at: Date | null;
  came_in_via: string | null;
  came_in_ref: string | null;
  first_seen_at: Date;
  last_message_received_at: Date;
  last_direct_message_received_at: Date | null;
  last_message_sent_at: Date | null;
  first_message_at: Date | null;
  last_comment_at: Date | null;
  comment_count: number;
  last_story_activity_at: Date | null;
  last_broadcast_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /** `cha_…` of the contact's account. */
  channel_account_public_id: string;
  /** `aut_…` of her first run's automation, or `null`. */
  first_automation_public_id: string | null;
}

/** The detail's extra columns (CT13). */
export interface ContactDetailSerializableRow extends ContactSerializableRow {
  note: string | null;
  last_opening_message_at: Date | null;
  first_automation_name: string | null;
  open_run_count: number;
}

/** An optional time as ISO 8601, or `null`. */
function isoOrNull(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

/**
 * Maps a live contact (its row, activity times and the two public ids) to the Contact object
 * (routes-final § 3.A.6).
 *
 * @remarks
 * - **Algorithm:** names every key (no row spread): `id` from `public_id`, `channel_account_id` the
 *   account's `cha_…`, `first_automation_id` the automation's `aut_…`; the two pauses as a flag and
 *   a time; `is_chat_open` when her last DM, story reply or tap plus 24 h − 15 min is after `now`.
 * - **Failure modes:** none — a pure mapping; only live rows reach it, so `instagram_user_id` is set
 *   (an empty string stands in otherwise).
 * - **Side effects:** none.
 * - **Notes:** the internal ids, the note (the detail's) and `deleted_at` never leave; the email and
 *   phone are shown to everyone holding `contact:read`.
 */
export function serializeContact({
  contact,
  now,
}: {
  contact: ContactSerializableRow;
  /** The time `is_chat_open` is judged at. */
  now: Date;
}): ContactOutput {
  const lastDirect = contact.last_direct_message_received_at;
  return {
    id: contact.public_id,
    channel_account_id: contact.channel_account_public_id,
    channel: contact.channel,
    instagram_user_id: contact.instagram_user_id ?? '',
    username: contact.username,
    full_name: contact.full_name,
    profile_picture_url: contact.profile_picture_url,
    followers_count: contact.followers_count,
    is_following_account: contact.is_following_account,
    follow_checked_at: isoOrNull(contact.follow_checked_at),
    email: contact.email,
    email_collected_at: isoOrNull(contact.email_collected_at),
    phone: contact.phone,
    phone_collected_at: isoOrNull(contact.phone_collected_at),
    tags: [...contact.tags],
    is_opted_out: contact.opted_out_at !== null,
    opted_out_at: isoOrNull(contact.opted_out_at),
    is_automations_paused: contact.automations_off_at !== null,
    automations_paused_at: isoOrNull(contact.automations_off_at),
    came_in_via: contact.came_in_via,
    came_in_ref: contact.came_in_ref,
    first_automation_id: contact.first_automation_public_id,
    first_seen_at: contact.first_seen_at.toISOString(),
    last_message_received_at: contact.last_message_received_at.toISOString(),
    last_direct_message_received_at: isoOrNull(lastDirect),
    last_message_sent_at: isoOrNull(contact.last_message_sent_at),
    first_message_at: isoOrNull(contact.first_message_at),
    last_comment_at: isoOrNull(contact.last_comment_at),
    comment_count: contact.comment_count,
    last_story_activity_at: isoOrNull(contact.last_story_activity_at),
    last_broadcast_at: isoOrNull(contact.last_broadcast_at),
    is_chat_open:
      lastDirect !== null && lastDirect.getTime() + CONTACT_CHAT_WINDOW_MS > now.getTime(),
    created_at: contact.created_at.toISOString(),
    updated_at: contact.updated_at.toISOString(),
  };
}

/**
 * Maps a live contact and its detail reads to the Contact detail object (routes 19, 20; CT13).
 *
 * @remarks
 * - **Algorithm:** {@link serializeContact}, then `note`, `automations_paused_by_user_id` (the
 *   caller-resolved `usr_…`), `last_opening_message_at`, `first_automation` (`{ id, name }` when the
 *   automation row is still there, else `null`) and `open_run_count`.
 * - **Failure modes:** none. **Side effects:** none.
 */
export function serializeContactDetail({
  contact,
  automations_paused_by_user_public_id,
  now,
}: {
  contact: ContactDetailSerializableRow;
  /** `usr_…` of who paused her, or `null`. */
  automations_paused_by_user_public_id: string | null;
  now: Date;
}): ContactDetailOutput {
  return {
    ...serializeContact({ contact, now }),
    note: contact.note,
    automations_paused_by_user_id: automations_paused_by_user_public_id,
    last_opening_message_at: isoOrNull(contact.last_opening_message_at),
    first_automation:
      contact.first_automation_public_id === null || contact.first_automation_name === null
        ? null
        : { id: contact.first_automation_public_id, name: contact.first_automation_name },
    open_run_count: contact.open_run_count,
  };
}

/** Maps one tag count row to the Contact tag count object (route 22). Pure; never fails. */
export function serializeContactTagCount(row: {
  tag: string;
  contact_count: number;
}): ContactTagCountOutput {
  return { tag: row.tag, contact_count: row.contact_count };
}
