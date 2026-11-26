-- Migration: app_channel_connections_provider_user_id
-- Created: 2026-11-26T13:01:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- fix-meta-unified-login-2026-11-26-ceuy, ROUTE row F3: a connection keeps the Meta system user its
-- token belongs to — the `id` of `GET /me?fields=client_business_id` (the answer already carried
-- it; it was thrown away). Written on every connect and reconnect; internal, never serialized.
--
-- Expand only: a nullable column (rows connected before this stay NULL until their next
-- reconnect) and a digits-only CHECK added NOT VALID, then validated (every existing row is NULL,
-- so the scan is trivial). The table's RLS policy is row-level and unchanged.

ALTER TABLE app.channel_connections ADD COLUMN IF NOT EXISTS provider_user_id VARCHAR(64) NULL;
--> statement-breakpoint

ALTER TABLE app.channel_connections DROP CONSTRAINT IF EXISTS chk_channel_connections_provider_user_id;
--> statement-breakpoint

ALTER TABLE app.channel_connections ADD CONSTRAINT chk_channel_connections_provider_user_id CHECK (
  provider_user_id IS NULL OR provider_user_id ~ '^[0-9]{1,64}$'
) NOT VALID;
--> statement-breakpoint

ALTER TABLE app.channel_connections VALIDATE CONSTRAINT chk_channel_connections_provider_user_id;
