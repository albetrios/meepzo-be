-- migration-safety: allow create_index_without_concurrently reason="new empty table created in this file"
-- Migration: billing_organization_entitlement_overrides
-- Created: 2026-11-26T12:00:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- Per-organization exceptions to the plan (iteration feat-instagram-dm-sending-2026-11-23-oxak, plan-gating
-- close, P270). A new billing migration — no merged migration is edited.
--
--   billing.organization_entitlement_overrides   one organization's override of a plan feature switch (a JSON
--                                                boolean) or a plan limit (a JSON number), optionally until
--                                                expires_at, set by a global admin with a reason. At most one
--                                                live (deleted_at IS NULL) row per organization and key; read in
--                                                the plan entitlement's one query (BL2) and merged while
--                                                expires_at is null or ahead.
--
-- Deletion: soft delete (deleted_at) for a remove; the rows go with their organization (ON DELETE CASCADE).
--
-- RLS: the organization arm in USING and WITH CHECK, enabled and FORCED (no bypass arm). The admin remove
-- names only the override's public id, so `billing.resolve_organization_public_id_for_entitlement_override(text)`
-- (SECURITY DEFINER) answers its organization's public id — nothing else — and the write runs under that
-- organization's context.

CREATE TABLE IF NOT EXISTS billing.organization_entitlement_overrides (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  key VARCHAR(64) NOT NULL,
  value JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  reason VARCHAR(500) NOT NULL,
  created_by_user_id BIGINT,
  updated_by_user_id BIGINT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT organization_entitlement_overrides_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT organization_entitlement_overrides_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT organization_entitlement_overrides_updated_by_user_id_users_id_fk FOREIGN KEY (updated_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT chk_organization_entitlement_overrides_key CHECK (key IN ('email_ask', 'phone_ask', 'reply_like_person', 'multiple_public_reply_lines', 'message_versions', 'broadcasts', 'segments', 'past_comments', 'extra_delay', 'starter_questions', 'mark_seen', 'message_month_limit', 'channel_accounts_max')),
  CONSTRAINT chk_organization_entitlement_overrides_value CHECK (jsonb_typeof(value) IN ('boolean', 'number')),
  CONSTRAINT chk_organization_entitlement_overrides_reason CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT chk_organization_entitlement_overrides_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_entitlement_overrides_public_id ON billing.organization_entitlement_overrides (public_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_entitlement_overrides_organization_key_live ON billing.organization_entitlement_overrides (organization_id, key) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_organization_entitlement_overrides_created_by_user_id ON billing.organization_entitlement_overrides (created_by_user_id) WHERE created_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_organization_entitlement_overrides_updated_by_user_id ON billing.organization_entitlement_overrides (updated_by_user_id) WHERE updated_by_user_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE billing.organization_entitlement_overrides OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.organization_entitlement_overrides TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE billing.organization_entitlement_overrides_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE billing.organization_entitlement_overrides ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE billing.organization_entitlement_overrides FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS organization_entitlement_overrides_tenant_isolation ON billing.organization_entitlement_overrides;
--> statement-breakpoint
CREATE POLICY organization_entitlement_overrides_tenant_isolation ON billing.organization_entitlement_overrides
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    organization_id = (
      SELECT organizations.id FROM tenancy.organizations
      WHERE organizations.public_id = (SELECT current_setting('app.current_organization_public_id', true))
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT organizations.id FROM tenancy.organizations
      WHERE organizations.public_id = (SELECT current_setting('app.current_organization_public_id', true))
    )
  );
--> statement-breakpoint
-- P270: the organization of one override (its public id only) — the admin remove's way in.
CREATE OR REPLACE FUNCTION billing.resolve_organization_public_id_for_entitlement_override (
  override_public_id_param TEXT
) RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = billing, public
AS $$
  SELECT o.public_id::text
  FROM billing.organization_entitlement_overrides AS e
  JOIN tenancy.organizations AS o ON o.id = e.organization_id
  WHERE e.public_id = override_public_id_param AND e.deleted_at IS NULL;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION billing.resolve_organization_public_id_for_entitlement_override (TEXT) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing.resolve_organization_public_id_for_entitlement_override (TEXT) TO meepzo_be_app, meepzo_be_maintenance;
