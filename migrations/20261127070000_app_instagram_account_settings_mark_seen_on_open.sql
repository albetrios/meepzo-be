-- Migration: app_instagram_account_settings_mark_seen_on_open
-- Created: 2026-11-27T07:00:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-inbox-2026-11-26-bcar, ROUTE R6 (routes-final.md § 2.A, CV8; plans/db-changes.md DB-8):
-- the Instagram account's "mark seen on open" switch, beside is_mark_seen_after_reply_enabled.
--
--   app.instagram_account_settings.is_mark_seen_on_open_enabled   off by default; when on, marking a
--                                                                 conversation read (route 162) also
--                                                                 sends Meta's mark_seen — behind the
--                                                                 same plan feature and Meta test.
--
-- A NOT NULL column with a constant default is a catalog-only change (no table rewrite); the previous
-- release, which knows no such column, keeps inserting and gets the default. Indexes and the
-- organization policy are unchanged.

ALTER TABLE app.instagram_account_settings
  ADD COLUMN IF NOT EXISTS is_mark_seen_on_open_enabled BOOLEAN NOT NULL DEFAULT FALSE;
