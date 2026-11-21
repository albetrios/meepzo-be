-- Migration: app_instagram_account
-- Created: 2026-11-21T06:45:29.532Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty tables created in this file"
--
-- launch-2026-11-20-ujai, ROUTE R3 (routes-final.md § 1.3, 1.A.3, 1.B.3 — IA5, IA6, IA11, IAC5,
-- IAC6): the organization's connected Instagram professional account, its encrypted token and
-- its automation settings, in the `app` schema R1 created (20261121050908_app_schema.sql).
--
--   app.instagram_accounts          one row per organization and Instagram account; at most one
--                                   not-revoked row per organization (D5) and one per Instagram
--                                   account across all organizations (IA11). No soft delete:
--                                   `revoked` stands in, and the row stays until the organization
--                                   is deleted.
--   app.instagram_account_tokens    the long-lived token, ciphertext only (IA5), one per account.
--   app.instagram_account_settings  the automation switch and public reply safety, one per account.
--
-- New, empty tables: the keys, CHECKs and indexes are created with them, inside this file's
-- transaction — nothing to lock against, nothing to validate. The children reference the account
-- through the composite key (organization_id, instagram_account_id) -> (organization_id, id), so a
-- row cannot name another organization's account (B2-5, named `<table>_<parent>_fk` as
-- 20261101101100_tenant_composite_foreign_keys.sql names them).
--
-- Row-level security: ENABLE + FORCE on all three, one `<table>_tenant_isolation` policy FOR ALL —
-- USING the organization arm, plus the retention sweep arm bound to the maintenance role on the
-- account and the settings (the daily sweep, IA8), WITH CHECK the organization arm only. The token
-- table has NO sweep arm (IA5): no maintenance process reads a token; the expiry the sweep needs is
-- copied onto app.instagram_accounts.token_expires_at in the same transaction.
--
-- Two SECURITY DEFINER resolvers (IA6) answer "which organization" before the organization is
-- known — connect's "connected elsewhere" check and webhook routing; Meta's callbacks — and return
-- organization public ids only. Like billing.resolve_organization_public_id_for_stripe_subscription,
-- they stay owned by the migration-executing role (role taxonomy, 20260827050000: a definer owned by
-- meepzo_be_owner would be subject to FORCE RLS and return nothing), pin search_path, and are
-- executable by the two runtime roles only (20261010135529).

CREATE TABLE IF NOT EXISTS app.instagram_accounts (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  instagram_user_id VARCHAR(64) NOT NULL,
  instagram_app_user_id VARCHAR(64) NOT NULL,
  username VARCHAR(64),
  name VARCHAR(255),
  biography TEXT,
  website TEXT,
  profile_picture_url TEXT,
  followers_count INTEGER NOT NULL DEFAULT 0,
  follows_count INTEGER NOT NULL DEFAULT 0,
  media_count INTEGER NOT NULL DEFAULT 0,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  connection_status VARCHAR(20) NOT NULL DEFAULT 'connected',
  connection_status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  token_expires_at TIMESTAMPTZ,
  webhook_subscribed_at TIMESTAMPTZ,
  connected_by_user_id BIGINT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disconnected_at TIMESTAMPTZ,
  profile_synced_at TIMESTAMPTZ,
  profile_erased_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instagram_accounts_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_accounts_connected_by_user_id_users_id_fk FOREIGN KEY (connected_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT chk_instagram_accounts_connection_status CHECK (connection_status IN ('connected', 'expired', 'error', 'revoked')),
  CONSTRAINT chk_instagram_accounts_instagram_user_id CHECK (instagram_user_id ~ '^[0-9]{1,64}$'),
  CONSTRAINT chk_instagram_accounts_instagram_app_user_id CHECK (instagram_app_user_id ~ '^[0-9]{1,64}$'),
  CONSTRAINT chk_instagram_accounts_counts CHECK (followers_count >= 0 AND follows_count >= 0 AND media_count >= 0),
  CONSTRAINT chk_instagram_accounts_scopes CHECK (cardinality(scopes) <= 20),
  CONSTRAINT chk_instagram_accounts_username_unless_revoked CHECK (username IS NOT NULL OR connection_status = 'revoked'),
  CONSTRAINT chk_instagram_accounts_disconnected CHECK ((connection_status = 'revoked') = (disconnected_at IS NOT NULL)),
  CONSTRAINT chk_instagram_accounts_profile_erased CHECK (profile_erased_at IS NULL OR connection_status = 'revoked'),
  CONSTRAINT chk_instagram_accounts_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_accounts_public_id ON app.instagram_accounts USING btree (public_id);
--> statement-breakpoint
-- The children's composite key (organization_id, instagram_account_id) -> (organization_id, id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_accounts_organization_id_id ON app.instagram_accounts USING btree (organization_id, id);
--> statement-breakpoint
-- One row per Instagram account per organization: a reconnect reuses it, revoked included (IA11).
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_accounts_organization_instagram_user ON app.instagram_accounts USING btree (organization_id, instagram_user_id);
--> statement-breakpoint
-- At most one not-revoked account per organization (D5).
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_accounts_organization_live ON app.instagram_accounts USING btree (organization_id) WHERE connection_status <> 'revoked';
--> statement-breakpoint
-- One organization at a time per Instagram account — decides a race between two organizations.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_accounts_instagram_user_live ON app.instagram_accounts USING btree (instagram_user_id) WHERE connection_status <> 'revoked';
--> statement-breakpoint
-- The Meta callbacks' resolver: every row of an app-scoped id, any status (IA6).
CREATE INDEX IF NOT EXISTS idx_instagram_accounts_instagram_app_user_id ON app.instagram_accounts USING btree (instagram_app_user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_instagram_accounts_connected_by_user_id ON app.instagram_accounts USING btree (connected_by_user_id) WHERE connected_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.instagram_account_tokens (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  instagram_account_id BIGINT NOT NULL,
  encrypted_access_token TEXT NOT NULL,
  token_type VARCHAR(20) NOT NULL DEFAULT 'long_lived',
  expires_at TIMESTAMPTZ,
  last_refreshed_at TIMESTAMPTZ,
  last_refresh_error VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instagram_account_tokens_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_account_tokens_instagram_account_fk FOREIGN KEY (organization_id, instagram_account_id) REFERENCES app.instagram_accounts (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_instagram_account_tokens_token_type CHECK (token_type IN ('long_lived')),
  CONSTRAINT chk_instagram_account_tokens_encrypted_access_token_not_empty CHECK (length(encrypted_access_token) > 0),
  CONSTRAINT chk_instagram_account_tokens_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
-- One token per account, and the composite key's index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_account_tokens_organization_account ON app.instagram_account_tokens USING btree (organization_id, instagram_account_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.instagram_account_settings (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  instagram_account_id BIGINT NOT NULL,
  is_automation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_public_reply_safety_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  public_reply_chance_percent SMALLINT NOT NULL DEFAULT 80,
  public_reply_hour_limit SMALLINT NOT NULL DEFAULT 60,
  public_reply_gap_min_seconds SMALLINT NOT NULL DEFAULT 20,
  public_reply_gap_max_seconds SMALLINT NOT NULL DEFAULT 60,
  updated_by_user_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instagram_account_settings_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_account_settings_instagram_account_fk FOREIGN KEY (organization_id, instagram_account_id) REFERENCES app.instagram_accounts (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT instagram_account_settings_updated_by_user_id_users_id_fk FOREIGN KEY (updated_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT chk_instagram_account_settings_chance CHECK (public_reply_chance_percent BETWEEN 0 AND 100),
  CONSTRAINT chk_instagram_account_settings_hour_limit CHECK (public_reply_hour_limit BETWEEN 1 AND 1000),
  CONSTRAINT chk_instagram_account_settings_gap_min CHECK (public_reply_gap_min_seconds BETWEEN 5 AND 3600),
  CONSTRAINT chk_instagram_account_settings_gap_max CHECK (public_reply_gap_max_seconds BETWEEN 5 AND 3600),
  CONSTRAINT chk_instagram_account_settings_gap_order CHECK (public_reply_gap_max_seconds >= public_reply_gap_min_seconds),
  CONSTRAINT chk_instagram_account_settings_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
-- One settings row per account, and the composite key's index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_account_settings_organization_account ON app.instagram_account_settings USING btree (organization_id, instagram_account_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_instagram_account_settings_updated_by_user_id ON app.instagram_account_settings USING btree (updated_by_user_id) WHERE updated_by_user_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE app.instagram_accounts OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.instagram_account_tokens OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.instagram_account_settings OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.instagram_accounts, app.instagram_account_tokens, app.instagram_account_settings TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.instagram_accounts_id_seq, app.instagram_account_tokens_id_seq, app.instagram_account_settings_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.instagram_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_account_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_account_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_account_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_account_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS instagram_accounts_tenant_isolation ON app.instagram_accounts;
--> statement-breakpoint
CREATE POLICY instagram_accounts_tenant_isolation ON app.instagram_accounts
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
--> statement-breakpoint
-- IA5: the organization arm only, in USING and WITH CHECK — no sweep arm on the token table.
DROP POLICY IF EXISTS instagram_account_tokens_tenant_isolation ON app.instagram_account_tokens;
--> statement-breakpoint
CREATE POLICY instagram_account_tokens_tenant_isolation ON app.instagram_account_tokens
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
DROP POLICY IF EXISTS instagram_account_settings_tenant_isolation ON app.instagram_account_settings;
--> statement-breakpoint
CREATE POLICY instagram_account_settings_tenant_isolation ON app.instagram_account_settings
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
--> statement-breakpoint
-- IA6 (1): the organization whose NOT-revoked account has this Instagram user id (`/me` user_id,
-- the webhook entry.id) — connect's "connected elsewhere" check; webhook routing (sub-domain 4).
-- At most one row matches (idx_instagram_accounts_instagram_user_live); NULL when none.
CREATE OR REPLACE FUNCTION app.resolve_organization_public_id_for_instagram_user (
  instagram_user_id_param TEXT
) RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, tenancy, public
AS $$
  SELECT o.public_id
  FROM app.instagram_accounts AS a
  INNER JOIN tenancy.organizations AS o ON o.id = a.organization_id
  WHERE a.instagram_user_id = instagram_user_id_param
    AND a.connection_status <> 'revoked'
  LIMIT 1;
$$;
--> statement-breakpoint
-- IA6 (2): every organization holding a row of this app-scoped id (`/me` id), any status — Meta's
-- deauthorize and data-deletion callbacks (1.D, IQ3). Public ids only, one per organization.
CREATE OR REPLACE FUNCTION app.resolve_organization_public_ids_for_instagram_app_user (
  instagram_app_user_id_param TEXT
) RETURNS SETOF TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, tenancy, public
AS $$
  SELECT DISTINCT o.public_id::text
  FROM app.instagram_accounts AS a
  INNER JOIN tenancy.organizations AS o ON o.id = a.organization_id
  WHERE a.instagram_app_user_id = instagram_app_user_id_param;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.resolve_organization_public_id_for_instagram_user (TEXT) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_organization_public_id_for_instagram_user (TEXT) TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.resolve_organization_public_ids_for_instagram_app_user (TEXT) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_organization_public_ids_for_instagram_app_user (TEXT) TO meepzo_be_app, meepzo_be_maintenance;
