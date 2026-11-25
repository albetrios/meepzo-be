-- Migration: app_segments
-- Created: 2026-11-24T18:43:21.872Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty table created in this file"
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R21 (routes-final.md § 7.3, § 7.B.3 — BC1,
-- BC4, BC5, BC12; BCC1, BCC8): the saved audiences broadcasts reuse, shared by every channel (P48).
--
--   app.segments   a saved audience of one channel account: a name and a condition tree (jsonb,
--                  at most 2 levels and 20 conditions — the validator's rule, BC12) read over the
--                  account's contacts. Soft-deleted (BC4, P9); purged 90 days later (P75) by the
--                  hourly purge (WC-62, ROUTE R50).
--
-- A new, empty table: its keys, CHECKs and indexes are created with it, inside this file's
-- transaction — nothing to lock against, nothing to validate. The account link is the composite
-- key (organization_id, channel_account_id) -> app.channel_accounts (organization_id, id), so a
-- segment cannot name another organization's account, ON DELETE CASCADE (7.3). The unique
-- (organization_id, id) index is the parent key of the broadcasts' segment reference (R22). The
-- first of sub-domain 7's files: segments -> broadcasts -> recipients -> the messages' key (BCC1).

CREATE TABLE IF NOT EXISTS app.segments (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  channel VARCHAR(10) NOT NULL DEFAULT 'instagram',
  name VARCHAR(255) NOT NULL,
  conditions JSONB NOT NULL,
  created_by_user_id BIGINT,
  updated_by_user_id BIGINT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT segments_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT segments_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT segments_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT segments_updated_by_user_id_users_id_fk FOREIGN KEY (updated_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT chk_segments_channel CHECK (channel IN ('instagram')),
  CONSTRAINT chk_segments_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 255),
  CONSTRAINT chk_segments_conditions CHECK (jsonb_typeof(conditions) = 'object'),
  CONSTRAINT chk_segments_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_segments_public_id ON app.segments USING btree (public_id);
--> statement-breakpoint
-- The broadcasts' composite key (organization_id, segment_id) -> (organization_id, id) (R22).
CREATE UNIQUE INDEX IF NOT EXISTS idx_segments_organization_id_id ON app.segments USING btree (organization_id, id);
--> statement-breakpoint
-- Route 77 by name (the default sort) over one account's live segments; also the account key's index.
CREATE INDEX IF NOT EXISTS idx_segments_account_name_id ON app.segments USING btree (organization_id, channel_account_id, name, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- Route 77 newest first.
CREATE INDEX IF NOT EXISTS idx_segments_account_created_at_id ON app.segments USING btree (organization_id, channel_account_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- The purge (BC4, WC-62): only the soft-deleted rows, so live writes never maintain it.
CREATE INDEX IF NOT EXISTS idx_segments_tombstoned ON app.segments USING btree (deleted_at) WHERE deleted_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_segments_created_by_user_id ON app.segments USING btree (created_by_user_id) WHERE created_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_segments_updated_by_user_id ON app.segments USING btree (updated_by_user_id) WHERE updated_by_user_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE app.segments OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.segments TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.segments_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.segments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.segments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS segments_tenant_isolation ON app.segments;
--> statement-breakpoint
CREATE POLICY segments_tenant_isolation ON app.segments
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    organization_id = (
      SELECT organizations.id FROM tenancy.organizations
      WHERE organizations.public_id = (SELECT current_setting('app.current_organization_public_id', true))
    )
    OR (
      (SELECT current_setting('app.global_retention_cleanup', true)) = 'true'
      AND (SELECT current_user) = 'meepzo_be_maintenance'
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT organizations.id FROM tenancy.organizations
      WHERE organizations.public_id = (SELECT current_setting('app.current_organization_public_id', true))
    )
  );
