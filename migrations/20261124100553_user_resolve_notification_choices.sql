-- Migration: user_resolve_notification_choices
-- Created: 2026-11-24T10:05:53.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R36 (routes-final.md § 11.C.1 UN11, § 11.C.11 UNC8):
-- the check before each send. A notification's dispatch runs in the ORGANIZATION's database context
-- (an event handler inside the tenancy write, or an organization-scoped worker job), while
-- `auth.user_notification_preferences` is FORCE ROW LEVEL SECURITY behind the owner policy keyed on
-- `app.current_user_public_id` — a plain read of the recipients' choices there matches ZERO rows as
-- the `meepzo_be_app` role. Mirror the established siblings (`auth.resolve_user_public_ids_by_ids`,
-- `auth.resolve_user_summaries_by_ids`): a narrow SECURITY DEFINER reader, array input so the
-- dispatch reads every recipient's choices for the kind's types in ONE query.
--
--   auth.resolve_notification_choices_by_user_ids(user_ids, notification_types)
--     user_id, notification_type, channel, is_enabled   — the stored rows only; a missing row is
--                                                          the kind's default (NOTIFICATION_KINDS)
--
-- Exposes only the choice columns. Callers pass the internal ids of recipients they already resolved
-- inside the organization's RLS context. No table, column, index or policy change: the unique
-- `idx_user_notif_prefs_user_type_channel_unique (user_id, notification_type, channel)` serves the
-- lookup.

CREATE OR REPLACE FUNCTION auth.resolve_notification_choices_by_user_ids (
  user_ids_param BIGINT[],
  notification_types_param TEXT[]
) RETURNS TABLE (
  user_id BIGINT,
  notification_type TEXT,
  channel TEXT,
  is_enabled BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = auth, public
AS $$
  SELECT
    preference_row.user_id,
    preference_row.notification_type::text,
    preference_row.channel::text,
    preference_row.is_enabled
  FROM auth.user_notification_preferences AS preference_row
  WHERE preference_row.user_id = ANY (user_ids_param)
    AND preference_row.notification_type = ANY (notification_types_param);
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION auth.resolve_notification_choices_by_user_ids (BIGINT[], TEXT[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.resolve_notification_choices_by_user_ids (BIGINT[], TEXT[]) TO meepzo_be_app, meepzo_be_maintenance;
