-- Migration: app_instagram_accounts_message_access
-- Created: 2026-11-26T16:00:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-meta-connect-flow-2026-11-26-bqmw, ROUTE row R1 (routes-final § 3.3, IG1): an Instagram account
-- keeps the answer of its last "Allow access to messages" probe — `on`, `off` or `unknown` — and when
-- it was read. Today the set-up job only logs the probe; R5 writes these columns and route 154 re-checks.
--
-- Expand only: `message_access` is added NOT NULL with its constant default 'unknown' (Postgres fills
-- existing rows from the default without a rewrite), `message_access_checked_at` nullable; the CHECK
-- lists the three values, added NOT VALID then validated (every existing row holds the default).
-- The previous release never reads or writes either column. RLS is row-level and unchanged.

ALTER TABLE app.instagram_accounts ADD COLUMN IF NOT EXISTS message_access VARCHAR(10) NOT NULL DEFAULT 'unknown';
--> statement-breakpoint

ALTER TABLE app.instagram_accounts ADD COLUMN IF NOT EXISTS message_access_checked_at TIMESTAMPTZ NULL;
--> statement-breakpoint

ALTER TABLE app.instagram_accounts DROP CONSTRAINT IF EXISTS chk_instagram_accounts_message_access;
--> statement-breakpoint

ALTER TABLE app.instagram_accounts ADD CONSTRAINT chk_instagram_accounts_message_access CHECK (
  message_access IN ('on', 'off', 'unknown')
) NOT VALID;
--> statement-breakpoint

ALTER TABLE app.instagram_accounts VALIDATE CONSTRAINT chk_instagram_accounts_message_access;
