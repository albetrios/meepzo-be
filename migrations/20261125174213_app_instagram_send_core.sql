-- Migration: app_instagram_send_core
-- Created: 2026-11-25T17:42:13.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R42 (routes-final § 6 SN5, SNC4; plan §33.6):
-- the send core's app-limit rule — "code 4 without a subcode from 2 accounts within 5 minutes stops
-- every account" (AC-17.11) — needs the last account that met the app limit and when, kept once
-- for the whole app on the tenantless app.sending_states row (P16; the row's policy, grants and
-- maintenance-only access are unchanged — 20261124143012_app_instagram_sending.sql).
--
--   app_limit_channel_account_id  the channel account (internal id) that last met the app limit
--   app_limit_seen_at             when; both empty, or both set
--
-- Two nullable columns and one CHECK (added NOT VALID, then validated) on a one-row table.

ALTER TABLE app.sending_states ADD COLUMN IF NOT EXISTS app_limit_channel_account_id BIGINT;
--> statement-breakpoint
ALTER TABLE app.sending_states ADD COLUMN IF NOT EXISTS app_limit_seen_at TIMESTAMPTZ;
--> statement-breakpoint
ALTER TABLE app.sending_states DROP CONSTRAINT IF EXISTS chk_sending_states_app_limit_seen;
--> statement-breakpoint
ALTER TABLE app.sending_states ADD CONSTRAINT chk_sending_states_app_limit_seen CHECK ((app_limit_channel_account_id IS NULL) = (app_limit_seen_at IS NULL)) NOT VALID;
--> statement-breakpoint
ALTER TABLE app.sending_states VALIDATE CONSTRAINT chk_sending_states_app_limit_seen;
