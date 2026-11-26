-- Migration: app_channel_accounts_scopes
-- Created: 2026-11-26T16:01:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-meta-connect-flow-2026-11-26-bqmw, ROUTE row R2 (routes-final § 2.3, AC5): a channel account may
-- keep its own Meta permissions — the daily token check (R6) fills them from `/debug_token`'s
-- `granular_scopes` once owner test O1 confirms that answer; `NULL` means the connection's `scopes`
-- stand for the account, so nothing changes until then. `scopes_read_at` says when they were read.
--
-- Expand only: both columns nullable (no backfill); the cardinality CHECK (at most 20 names — the same
-- cap as `app.channel_connections.scopes`, `META_PERMISSION_NAMES_MAX`) added NOT VALID then validated
-- (every existing row is NULL). The previous release never reads or writes them. RLS unchanged.

ALTER TABLE app.channel_accounts ADD COLUMN IF NOT EXISTS scopes TEXT[] NULL;
--> statement-breakpoint

ALTER TABLE app.channel_accounts ADD COLUMN IF NOT EXISTS scopes_read_at TIMESTAMPTZ NULL;
--> statement-breakpoint

ALTER TABLE app.channel_accounts DROP CONSTRAINT IF EXISTS chk_channel_accounts_scopes;
--> statement-breakpoint

ALTER TABLE app.channel_accounts ADD CONSTRAINT chk_channel_accounts_scopes CHECK (
  scopes IS NULL OR cardinality(scopes) <= 20
) NOT VALID;
--> statement-breakpoint

ALTER TABLE app.channel_accounts VALIDATE CONSTRAINT chk_channel_accounts_scopes;
