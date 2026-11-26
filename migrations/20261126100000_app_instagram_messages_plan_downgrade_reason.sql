-- Migration: app_instagram_messages_plan_downgrade_reason
-- Created: 2026-11-26T10:00:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, Close (owner 2026-11-26, P265; AS-BUILT Owner item 23 (b)):
-- a waiting DM that the 7-day expiry (WC-15) ends while its account is held by a `plan_downgrade`
-- stop ends `expired` · `plan_downgrade` — its own reason, as `plan_limit` already is behind the
-- month stop — instead of the plain `expired`. The message reason list
-- (20261125090000_app_instagram_messages.sql, INSTAGRAM_MESSAGE_REASONS) gains the value.
--
-- The CHECK is widened, never narrowed: every existing row already passes it. Added NOT VALID, then
-- validated (a split table: the parent's constraint reaches every part).

ALTER TABLE app.instagram_messages DROP CONSTRAINT IF EXISTS chk_instagram_messages_reason;
--> statement-breakpoint

ALTER TABLE app.instagram_messages ADD CONSTRAINT chk_instagram_messages_reason CHECK (
  reason IN ('opted_out', 'hour_limit', 'duplicate', 'window_closed', 'deleted_comment', 'person_error', 'wrong_permission', 'once_per_post', 'broadcast_cancelled', 'recent_broadcast', 'owner_chat', 'plan_feature_off', 'contact_excluded', 'automation_deleted', 'contact_deleted', 'restore', 'cancelled_by_owner', 'answered', 'replaced', 'wait_expired', 'expired', 'reply_too_old', 'live_ended', 'plan_limit', 'plan_downgrade', 'bad_text', 'tries_used_up', 'attachment_failed', 'no_answer', 'worker_lost', 'assumed_following', 'following', 'not_following')
) NOT VALID;
--> statement-breakpoint

ALTER TABLE app.instagram_messages VALIDATE CONSTRAINT chk_instagram_messages_reason;
