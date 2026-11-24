-- Migration: auth_trusted_devices
-- Created: 2026-11-24T11:00:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R32 (routes-final.md § 10.C AT17, ATC10; D56):
-- "trust this device for 30 days". After a right 2FA code with the box ticked, POST /auth/mfa/login
-- stores one row here and sets the `trusted_device` cookie; the next sign-in on that browser within
-- 30 days skips the 2FA code (never in an organization that requires 2FA, never for a super_admin,
-- never for a step-up). Only the SHA-256 of the cookie is stored; at most 10 live rows per person.
--
-- A new, empty table: the foreign key, the CHECK and the indexes are created with it, inside this
-- file's transaction — nothing to lock against, nothing to validate.
-- migration-safety: allow create_index_without_concurrently reason="new empty table created in this file"
--
-- Row-level security: ENABLE + FORCE, one user policy on app.current_user_public_id (USING and
-- WITH CHECK) — the auth.sessions shape — plus, in USING only, the session clean-up's maintenance
-- arm (app.session_retention_cleanup, bound to meepzo_be_maintenance) for the hourly DELETE of rows
-- expired or revoked over 30 days ago (WC-64, ROUTE R50). The clean-up only deletes, so no bypass
-- arm sits in WITH CHECK (no maintenance process can write a row for any person).

CREATE TABLE IF NOT EXISTS auth.trusted_devices (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  user_id BIGINT NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  user_agent VARCHAR(512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT trusted_devices_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE,
  CONSTRAINT chk_trusted_devices_expires CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS trusted_devices_public_id_unique ON auth.trusted_devices USING btree (public_id);
CREATE UNIQUE INDEX IF NOT EXISTS trusted_devices_token_hash_unique ON auth.trusted_devices USING btree (token_hash);
CREATE INDEX IF NOT EXISTS idx_trusted_devices_user_id_created_at_live ON auth.trusted_devices USING btree (user_id, created_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_trusted_devices_user_id ON auth.trusted_devices USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_trusted_devices_expires_at ON auth.trusted_devices USING btree (expires_at);

ALTER TABLE auth.trusted_devices OWNER TO meepzo_be_owner;

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.trusted_devices TO meepzo_be_app, meepzo_be_maintenance;
GRANT USAGE, SELECT ON SEQUENCE auth.trusted_devices_id_seq TO meepzo_be_app, meepzo_be_maintenance;

ALTER TABLE auth.trusted_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.trusted_devices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trusted_devices_user_access ON auth.trusted_devices;
CREATE POLICY trusted_devices_user_access ON auth.trusted_devices
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    user_id = (
      SELECT users.id FROM auth.users
      WHERE users.public_id = (SELECT current_setting('app.current_user_public_id', true))
        AND users.deleted_at IS NULL
    )
    OR (
      (SELECT current_setting('app.session_retention_cleanup', true)) = 'true'
      AND (SELECT current_user) = 'meepzo_be_maintenance'
    )
  )
  WITH CHECK (
    user_id = (
      SELECT users.id FROM auth.users
      WHERE users.public_id = (SELECT current_setting('app.current_user_public_id', true))
        AND users.deleted_at IS NULL
    )
  );
