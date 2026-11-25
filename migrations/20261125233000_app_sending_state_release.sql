-- Migration: app_sending_state_release
-- Created: 2026-11-25T23:30:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R62 (plan §33.6 rules 2–3; AC-27.8): after an
-- all-accounts stop ends, the first lane that wakes takes the one test (the existing testing_lane /
-- testing_until pair); a good test releases the lanes spread over 5 minutes at half speed. The
-- release needs its start, kept once for the whole app on the tenantless app.sending_states row
-- (P16; the row's policy, grants and maintenance-only access are unchanged —
-- 20261124143012_app_instagram_sending.sql).
--
--   all_release_started_at  when the good test released the lanes; empty while a stop or its test
--                           holds them, and from each new all-accounts stop
--
-- One nullable column on a one-row table.

ALTER TABLE app.sending_states ADD COLUMN IF NOT EXISTS all_release_started_at TIMESTAMPTZ;
