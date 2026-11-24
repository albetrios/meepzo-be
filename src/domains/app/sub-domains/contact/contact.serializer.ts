import type { ContactOutput } from './contact.types.js';

/** The `app.contacts` columns the contact object reads (plus its account's public id). */
interface ContactSerializableRow {
  public_id: string;
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
  first_seen_at: Date;
  last_message_received_at: Date;
  last_direct_message_received_at: Date | null;
  last_message_sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Maps a live `app.contacts` row and its Instagram account's public id to the contact object
 * (routes-final § 2.6).
 *
 * @remarks
 * - **Algorithm:** names every key (no row spread): `id` from `public_id`, `instagram_account_id`
 *   the caller-resolved `cha_…` (CT13), timestamps as ISO 8601, `tags` copied.
 * - **Failure modes:** none — a pure mapping. Only live rows reach it (the list reads
 *   `deleted_at IS NULL`), so `instagram_user_id` is set; an empty string stands in otherwise.
 * - **Side effects:** none.
 * - **Notes:** the internal ids, `instagram_account_id`'s bigint and `deleted_at` never leave; the
 *   email and phone are shown to everyone holding `contact:read` (D2).
 */
export function serializeContact({
  contact,
  instagram_account_public_id,
}: {
  contact: ContactSerializableRow;
  /** `cha_…` of the contact's account. */
  instagram_account_public_id: string;
}): ContactOutput {
  return {
    id: contact.public_id,
    instagram_account_id: instagram_account_public_id,
    instagram_user_id: contact.instagram_user_id ?? '',
    username: contact.username,
    full_name: contact.full_name,
    profile_picture_url: contact.profile_picture_url,
    followers_count: contact.followers_count,
    is_following_account: contact.is_following_account,
    follow_checked_at: contact.follow_checked_at?.toISOString() ?? null,
    email: contact.email,
    email_collected_at: contact.email_collected_at?.toISOString() ?? null,
    phone: contact.phone,
    phone_collected_at: contact.phone_collected_at?.toISOString() ?? null,
    tags: [...contact.tags],
    first_seen_at: contact.first_seen_at.toISOString(),
    last_message_received_at: contact.last_message_received_at.toISOString(),
    last_direct_message_received_at: contact.last_direct_message_received_at?.toISOString() ?? null,
    last_message_sent_at: contact.last_message_sent_at?.toISOString() ?? null,
    created_at: contact.created_at.toISOString(),
    updated_at: contact.updated_at.toISOString(),
  };
}
