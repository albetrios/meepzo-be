-- Migration: app_instagram_attachments
-- Created: 2026-11-25T12:15:30.000Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty table created in this file"
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R20 (routes-final § 6.C.3 — SN20, SN21; SNC15;
-- P25, P43): Meta's id for a message file uploaded once per Instagram account, in the `app` schema,
-- after the channel account (20261121064529) and the sending root
-- (20261124143012_app_instagram_sending.sql).
--
--   app.instagram_attachments  one row per channel account and upload: the upload's public id
--                              (`upl_…`, read through the upload service — no key into
--                              upload.uploads, P25) and Meta's `attachment_id`. Written once the
--                              first send or the attachment task uploaded the file (AC-15.4),
--                              deleted when Meta says the file is gone (`attachment_failed`).
--
-- The account is referenced through the composite key (organization_id, channel_account_id) ->
-- app.channel_accounts (organization_id, id) ON DELETE CASCADE, so a row cannot name another
-- organization's account (B2-5). No public id, no routes, no soft delete.
--
-- Row-level security: ENABLE + FORCE, one `instagram_attachments_tenant_isolation` policy FOR ALL —
-- USING the organization arm plus the retention sweep arm bound to the maintenance role (the
-- deleted-automation purge, WC-47, reads across organizations), WITH CHECK the organization arm only.

CREATE TABLE IF NOT EXISTS app.instagram_attachments (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  upload_public_id VARCHAR(28) NOT NULL,
  attachment_id VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instagram_attachments_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_attachments_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_instagram_attachments_upload_public_id CHECK (upload_public_id ~ '^upl_[a-z0-9]{21}$'),
  CONSTRAINT chk_instagram_attachments_attachment_id CHECK (char_length(attachment_id) > 0),
  CONSTRAINT chk_instagram_attachments_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
-- One Meta id per account and file (SN20) — the look-up before every send of a file, and the
-- composite key's index (it leads with organization_id, channel_account_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_attachments_account_upload ON app.instagram_attachments USING btree (organization_id, channel_account_id, upload_public_id);
--> statement-breakpoint
ALTER TABLE app.instagram_attachments OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.instagram_attachments TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.instagram_attachments_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.instagram_attachments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_attachments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS instagram_attachments_tenant_isolation ON app.instagram_attachments;
--> statement-breakpoint
CREATE POLICY instagram_attachments_tenant_isolation ON app.instagram_attachments
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
