-- Migration: app_instagram_account
-- Created: 2026-11-21T06:45:29.532Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty tables created in this file"
--
-- launch-2026-11-20-ujai, ROUTE R3 (routes-final.md § 1.3, 1.A.3, 1.B.3 — IA5, IA6, IA11, IAC5,
-- IAC6), changed in place by feat-instagram-dm-sending-2026-11-23-oxak ROUTE R3 (P29; routes-final
-- § 1.3 MC1, MC9, MC18, MC19 / S13, P107, P111), ROUTE R5 (§ 1B.3 CAC1, CAQ1 — P116) and ROUTE R6
-- (§ 2.A.3 IA8, IAC6 — P120): the provider login an organization connects its
-- accounts through, its encrypted token and Meta's usage per connection; the organization's
-- connected Instagram professional accounts and their automation settings, in the `app` schema R1
-- created (20261121050908_app_schema.sql).
--
--   app.channel_connections         one provider login of an organization for one business (Meta's
--                                   Unified Login: one business portfolio). One row per organization,
--                                   provider and business, a revoked one reused. No soft delete:
--                                   `revoked` stands in.
--   app.channel_connection_tokens   its token, ciphertext only (MC9), one per connection; deleted
--                                   when the connection is revoked.
--   app.channel_connection_usages   Meta's usage per connection, asset and use-case type (S13, P107):
--                                   the newest reading wins. Postgres holds it; Redis keeps a copy.
--   app.channel_accounts            one connected inbox of an organization, whatever its channel
--                                   (feat-instagram-dm-sending ROUTE R5, routes-final § 1B.3, P42): the
--                                   connection it came through, the provider's account id, its status,
--                                   pause, suspend, plan stop and automation switch. Many per
--                                   organization up to the plan's limit (D26, checked at the pick under
--                                   the organization lock) and one not-revoked row per provider account
--                                   across all organizations (CAQ1, P60). No soft delete: `revoked`
--                                   stands in.
--   app.instagram_accounts          the Instagram part of a channel account, 1:1 through
--                                   `channel_account_id` (ROUTE row R6, routes-final § 2.A.3, IA8):
--                                   the Instagram user id, profile, account type, private flag,
--                                   webhook stamp and starter-question time. No public id, status or
--                                   connection columns of its own — those are the channel account's.
--   app.instagram_account_settings  the automation switch and public reply safety, one per account.
--
-- The launch's app.instagram_account_tokens (the Instagram Login token, renewed daily) is gone: the
-- token lives on the connection (D24); no data moves (plan:L2924).
--
-- New, empty tables: the keys, CHECKs and indexes are created with them, inside this file's
-- transaction — nothing to lock against, nothing to validate. The children reference their parent
-- through the composite key (organization_id, <parent>_id) -> (organization_id, id), so a row cannot
-- name another organization's parent (B2-5, named `<table>_<parent>_fk` as
-- 20261101101100_tenant_composite_foreign_keys.sql names them).
--
-- Row-level security: ENABLE + FORCE on all six, one `<table>_tenant_isolation` policy FOR ALL —
-- USING the organization arm, plus the retention sweep arm bound to the maintenance role on the
-- connection (the daily token check's sweep, MC10), the channel account (the subscription check and
-- the plan-change sweep, 1B.3), the Instagram account and the settings (the daily sweep,
-- IA8), WITH CHECK the organization arm only. The token and usage tables have NO sweep arm (MC9): no
-- maintenance process reads a token or a connection's usage.
--
-- Two SECURITY DEFINER resolvers (IA6) answer "which organization" before the organization is
-- known — the pick's "connected elsewhere" check and webhook routing; Meta's callbacks — and return
-- organization public ids only. Like billing.resolve_organization_public_id_for_stripe_subscription,
-- they stay owned by the migration-executing role (role taxonomy, 20260827050000: a definer owned by
-- meepzo_be_owner would be subject to FORCE RLS and return nothing), pin search_path, and are
-- executable by the two runtime roles only (20261010135529).

CREATE TABLE IF NOT EXISTS app.channel_connections (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  provider VARCHAR(20) NOT NULL DEFAULT 'meta',
  client_business_id VARCHAR(64) NOT NULL,
  config_id VARCHAR(64) NOT NULL,
  login_type VARCHAR(20) NOT NULL DEFAULT 'unified',
  status VARCHAR(10) NOT NULL DEFAULT 'connected',
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scopes TEXT[] NOT NULL DEFAULT '{}',
  connected_by_user_id BIGINT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checked_at TIMESTAMPTZ,
  last_check_error VARCHAR(500),
  disconnected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT channel_connections_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT channel_connections_connected_by_user_id_users_id_fk FOREIGN KEY (connected_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT chk_channel_connections_provider CHECK (provider IN ('meta')),
  CONSTRAINT chk_channel_connections_status CHECK (status IN ('connected', 'error', 'revoked')),
  CONSTRAINT chk_channel_connections_login_type CHECK (login_type IN ('unified')),
  CONSTRAINT chk_channel_connections_client_business_id CHECK (client_business_id ~ '^[0-9]{1,64}$'),
  CONSTRAINT chk_channel_connections_disconnected CHECK ((status = 'revoked') = (disconnected_at IS NOT NULL)),
  CONSTRAINT chk_channel_connections_scopes CHECK (cardinality(scopes) <= 20),
  CONSTRAINT chk_channel_connections_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_connections_public_id ON app.channel_connections USING btree (public_id);
--> statement-breakpoint
-- The children's composite key (organization_id, channel_connection_id) -> (organization_id, id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_connections_organization_id_id ON app.channel_connections USING btree (organization_id, id);
--> statement-breakpoint
-- One row per organization, provider and business: a reconnect reuses it, revoked included (MC5).
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_connections_organization_business ON app.channel_connections USING btree (organization_id, provider, client_business_id);
--> statement-breakpoint
-- Meta's callbacks matched by business across organizations (MC15, P56).
CREATE INDEX IF NOT EXISTS idx_channel_connections_provider_business ON app.channel_connections USING btree (provider, client_business_id);
--> statement-breakpoint
-- The daily token check's sweep across organizations (MC10).
CREATE INDEX IF NOT EXISTS idx_channel_connections_check_due ON app.channel_connections USING btree (last_checked_at) WHERE status = 'connected';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_channel_connections_connected_by_user_id ON app.channel_connections USING btree (connected_by_user_id) WHERE connected_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.channel_connection_tokens (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  channel_connection_id BIGINT NOT NULL,
  encrypted_access_token TEXT NOT NULL,
  token_type VARCHAR(20) NOT NULL DEFAULT 'system_user',
  encrypted_refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT channel_connection_tokens_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT channel_connection_tokens_channel_connection_fk FOREIGN KEY (organization_id, channel_connection_id) REFERENCES app.channel_connections (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_channel_connection_tokens_token_type CHECK (token_type IN ('system_user', 'oauth_user')),
  CONSTRAINT chk_channel_connection_tokens_encrypted_access_token_not_empty CHECK (length(encrypted_access_token) > 0),
  CONSTRAINT chk_channel_connection_tokens_encrypted_refresh_token_not_empty CHECK (encrypted_refresh_token IS NULL OR length(encrypted_refresh_token) > 0),
  CONSTRAINT chk_channel_connection_tokens_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
-- One token per connection, and the composite key's index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_connection_tokens_organization_connection ON app.channel_connection_tokens USING btree (organization_id, channel_connection_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.channel_connection_usages (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  channel_connection_id BIGINT NOT NULL,
  asset_id VARCHAR(64) NOT NULL,
  usage_type VARCHAR(64) NOT NULL,
  usage_percent SMALLINT NOT NULL,
  wait_until TIMESTAMPTZ,
  read_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT channel_connection_usages_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT channel_connection_usages_channel_connection_fk FOREIGN KEY (organization_id, channel_connection_id) REFERENCES app.channel_connections (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_channel_connection_usages_usage_percent CHECK (usage_percent BETWEEN 0 AND 100),
  CONSTRAINT chk_channel_connection_usages_asset_id CHECK (length(asset_id) > 0),
  CONSTRAINT chk_channel_connection_usages_usage_type CHECK (length(usage_type) > 0),
  CONSTRAINT chk_channel_connection_usages_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
-- One reading per connection, asset and use-case type (S13), and the composite key's index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_connection_usages_connection_asset_type ON app.channel_connection_usages USING btree (organization_id, channel_connection_id, asset_id, usage_type);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.channel_accounts (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  channel VARCHAR(20) NOT NULL DEFAULT 'instagram',
  channel_connection_id BIGINT NOT NULL,
  provider_account_id VARCHAR(64) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  connection_status VARCHAR(20) NOT NULL DEFAULT 'connected',
  is_automation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  paused_at TIMESTAMPTZ,
  paused_by_user_id BIGINT,
  suspended_at TIMESTAMPTZ,
  plan_stop_reason VARCHAR(14),
  plan_stopped_at TIMESTAMPTZ,
  connected_by_user_id BIGINT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disconnected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT channel_accounts_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT channel_accounts_channel_connection_fk FOREIGN KEY (organization_id, channel_connection_id) REFERENCES app.channel_connections (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT channel_accounts_connected_by_user_id_users_id_fk FOREIGN KEY (connected_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT channel_accounts_paused_by_user_id_users_id_fk FOREIGN KEY (paused_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT chk_channel_accounts_channel CHECK (channel IN ('instagram')),
  CONSTRAINT chk_channel_accounts_connection_status CHECK (connection_status IN ('connected', 'error', 'revoked')),
  CONSTRAINT chk_channel_accounts_disconnected CHECK ((connection_status = 'revoked') = (disconnected_at IS NOT NULL)),
  CONSTRAINT chk_channel_accounts_paused_by CHECK (paused_by_user_id IS NULL OR paused_at IS NOT NULL),
  CONSTRAINT chk_channel_accounts_provider_account_id CHECK (provider_account_id ~ '^[0-9]{1,64}$'),
  CONSTRAINT chk_channel_accounts_display_name CHECK (length(display_name) > 0),
  CONSTRAINT chk_channel_accounts_plan_stop CHECK (
    (plan_stop_reason IS NULL OR plan_stop_reason IN ('plan_limit', 'plan_ended', 'plan_downgrade'))
    AND (plan_stop_reason IS NULL) = (plan_stopped_at IS NULL)
  ),
  CONSTRAINT chk_channel_accounts_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_accounts_public_id ON app.channel_accounts USING btree (public_id);
--> statement-breakpoint
-- The parent key of every channel_account_id (organization_id, channel_account_id) -> (organization_id, id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_accounts_organization_id_id ON app.channel_accounts USING btree (organization_id, id);
--> statement-breakpoint
-- One row per organization and provider account: the pick brings a revoked one back (AC-2.5).
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_accounts_organization_provider_account ON app.channel_accounts USING btree (organization_id, channel, provider_account_id);
--> statement-breakpoint
-- One organization at a time per provider account (CAQ1, P60) — decides a race between two organizations.
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_accounts_provider_account_live ON app.channel_accounts USING btree (channel, provider_account_id) WHERE connection_status <> 'revoked';
--> statement-breakpoint
-- Meta's callbacks matched by account across organizations, any status (MC15 (1), P56 — ROUTE row R9).
CREATE INDEX IF NOT EXISTS idx_channel_accounts_provider_account ON app.channel_accounts USING btree (provider_account_id);
--> statement-breakpoint
-- Route 6: the organization's not-revoked accounts of a channel, oldest connected first.
CREATE INDEX IF NOT EXISTS idx_channel_accounts_organization_channel ON app.channel_accounts USING btree (organization_id, channel, connected_at) WHERE connection_status <> 'revoked';
--> statement-breakpoint
-- The composite key's index and "the accounts of a connection" (reconnect, break, disconnect business).
CREATE INDEX IF NOT EXISTS idx_channel_accounts_connection ON app.channel_accounts USING btree (organization_id, channel_connection_id);
--> statement-breakpoint
-- The 10-minute subscription check pages the connected accounts across organizations (sub-domain 2).
CREATE INDEX IF NOT EXISTS idx_channel_accounts_connected_check ON app.channel_accounts USING btree (id) WHERE connection_status = 'connected';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_channel_accounts_connected_by_user_id ON app.channel_accounts USING btree (connected_by_user_id) WHERE connected_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_channel_accounts_paused_by_user_id ON app.channel_accounts USING btree (paused_by_user_id) WHERE paused_by_user_id IS NOT NULL;
--> statement-breakpoint
-- The month wake and the plan change read the plan-stopped accounts of an organization (rev 5).
CREATE INDEX IF NOT EXISTS idx_channel_accounts_plan_stop ON app.channel_accounts USING btree (organization_id, plan_stop_reason) WHERE plan_stop_reason IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.instagram_accounts (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  instagram_user_id VARCHAR(64) NOT NULL,
  username VARCHAR(64),
  biography TEXT,
  website TEXT,
  profile_picture_url TEXT,
  account_type VARCHAR(20),
  is_private BOOLEAN NOT NULL DEFAULT FALSE,
  followers_count INTEGER NOT NULL DEFAULT 0,
  follows_count INTEGER NOT NULL DEFAULT 0,
  media_count INTEGER NOT NULL DEFAULT 0,
  webhook_subscribed_at TIMESTAMPTZ,
  starter_questions_set_at TIMESTAMPTZ,
  profile_synced_at TIMESTAMPTZ,
  profile_erased_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instagram_accounts_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_accounts_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_instagram_accounts_instagram_user_id CHECK (instagram_user_id ~ '^[0-9]{1,64}$'),
  CONSTRAINT chk_instagram_accounts_account_type CHECK (account_type IS NULL OR account_type IN ('business', 'creator')),
  CONSTRAINT chk_instagram_accounts_counts CHECK (followers_count >= 0 AND follows_count >= 0 AND media_count >= 0),
  CONSTRAINT chk_instagram_accounts_username_unless_erased CHECK (username IS NOT NULL OR profile_erased_at IS NOT NULL),
  CONSTRAINT chk_instagram_accounts_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
-- The children's composite key (organization_id, instagram_account_id) -> (organization_id, id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_accounts_organization_id_id ON app.instagram_accounts USING btree (organization_id, id);
--> statement-breakpoint
-- One row per Instagram account per organization: a pick brings a revoked one back with its settings.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_accounts_organization_instagram_user ON app.instagram_accounts USING btree (organization_id, instagram_user_id);
--> statement-breakpoint
-- The 1:1 extension of the channel account and its composite key's index (2.A.3).
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_accounts_channel_account ON app.instagram_accounts USING btree (organization_id, channel_account_id);
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
ALTER TABLE app.channel_connections OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.channel_connection_tokens OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.channel_connection_usages OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.channel_accounts OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.instagram_accounts OWNER TO meepzo_be_owner;
--> statement-breakpoint
ALTER TABLE app.instagram_account_settings OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.channel_connections, app.channel_connection_tokens, app.channel_connection_usages, app.channel_accounts, app.instagram_accounts, app.instagram_account_settings TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.channel_connections_id_seq, app.channel_connection_tokens_id_seq, app.channel_connection_usages_id_seq, app.channel_accounts_id_seq, app.instagram_accounts_id_seq, app.instagram_account_settings_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.channel_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.channel_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.channel_connection_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.channel_connection_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.channel_connection_usages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.channel_connection_usages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.channel_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.channel_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_account_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_account_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- MC10: the connection's sweep arm (USING only) for the daily token check's sweep.
DROP POLICY IF EXISTS channel_connections_tenant_isolation ON app.channel_connections;
--> statement-breakpoint
CREATE POLICY channel_connections_tenant_isolation ON app.channel_connections
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
-- MC9: the organization arm only, in USING and WITH CHECK — no sweep arm on the token table.
DROP POLICY IF EXISTS channel_connection_tokens_tenant_isolation ON app.channel_connection_tokens;
--> statement-breakpoint
CREATE POLICY channel_connection_tokens_tenant_isolation ON app.channel_connection_tokens
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
-- S13: the organization arm only — usage is read and written inside an organization's scope.
DROP POLICY IF EXISTS channel_connection_usages_tenant_isolation ON app.channel_connection_usages;
--> statement-breakpoint
CREATE POLICY channel_connection_usages_tenant_isolation ON app.channel_connection_usages
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
-- 1B.3: the organization arm, plus the sweep arm in USING only (the 10-minute subscription check and
-- the plan-change sweep read across organizations).
DROP POLICY IF EXISTS channel_accounts_tenant_isolation ON app.channel_accounts;
--> statement-breakpoint
CREATE POLICY channel_accounts_tenant_isolation ON app.channel_accounts
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
-- IA6 (1): the organization whose NOT-revoked channel account has this Instagram user id (the
-- webhook entry.id) — webhook routing (sub-domain 5). Since ROUTE row R6 the status is the channel
-- account's (2.A.3): at most one row matches (idx_channel_accounts_provider_account_live); NULL when none.
CREATE OR REPLACE FUNCTION app.resolve_organization_public_id_for_instagram_user (
  instagram_user_id_param TEXT
) RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, tenancy, public
AS $$
  SELECT o.public_id
  FROM app.channel_accounts AS c
  INNER JOIN tenancy.organizations AS o ON o.id = c.organization_id
  WHERE c.channel = 'instagram'
    AND c.provider_account_id = instagram_user_id_param
    AND c.connection_status <> 'revoked'
  LIMIT 1;
$$;
--> statement-breakpoint
-- MC15 (1) (ROUTE row R9, P56): every organization with a channel account of this provider's
-- channels and provider account id (for meta: an Instagram account's instagram_user_id), any status —
-- Meta's deauthorize and data-deletion callbacks, tried first. Public ids only, one per organization.
CREATE OR REPLACE FUNCTION app.resolve_organization_public_ids_for_provider_account (
  provider_param TEXT,
  provider_account_id_param TEXT
) RETURNS SETOF TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, tenancy, public
AS $$
  SELECT DISTINCT o.public_id::text
  FROM app.channel_accounts AS a
  INNER JOIN app.channel_connections AS c
    ON c.organization_id = a.organization_id AND c.id = a.channel_connection_id
  INNER JOIN tenancy.organizations AS o ON o.id = a.organization_id
  WHERE a.provider_account_id = provider_account_id_param
    AND c.provider = provider_param;
$$;
--> statement-breakpoint
-- MC15 (2) (ROUTE row R9, P56): every organization with a connection of this provider and
-- client_business_id, any status (idx_channel_connections_provider_business) — Meta's callbacks when
-- (1) finds none. Public ids only, one per organization.
CREATE OR REPLACE FUNCTION app.resolve_organization_public_ids_for_provider_business (
  provider_param TEXT,
  client_business_id_param TEXT
) RETURNS SETOF TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, tenancy, public
AS $$
  SELECT DISTINCT o.public_id::text
  FROM app.channel_connections AS c
  INNER JOIN tenancy.organizations AS o ON o.id = c.organization_id
  WHERE c.provider = provider_param
    AND c.client_business_id = client_business_id_param;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.resolve_organization_public_id_for_instagram_user (TEXT) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_organization_public_id_for_instagram_user (TEXT) TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.resolve_organization_public_ids_for_provider_account (TEXT, TEXT) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_organization_public_ids_for_provider_account (TEXT, TEXT) TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.resolve_organization_public_ids_for_provider_business (TEXT, TEXT) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_organization_public_ids_for_provider_business (TEXT, TEXT) TO meepzo_be_app, meepzo_be_maintenance;
