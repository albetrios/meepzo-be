-- Migration: app_contacts
-- Created: 2026-11-21T09:45:03.849Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty table created in this file"
--
-- launch-2026-11-20-ujai, ROUTE R8 (routes-final.md § 2.3 — CT1, CT7, CT10, CT13; CTC1): the people
-- who interacted with one of the organization's Instagram accounts, in the `app` schema R1 created
-- (20261121050908_app_schema.sql).
--
--   app.contacts   one Instagram user who commented on, messaged, replied to a story of or clicked a
--                  button of one of the organization's Instagram accounts (CT13: a contact belongs to
--                  the account it came from). Written only by event processing through the contact
--                  service (CT2); erased in place by the team (route 10, D22, CT7): `deleted_at` set
--                  and every personal column cleared, the row kept so the runs that point at it stay.
--
-- New, empty table: the keys, CHECKs and indexes are created with it, inside this file's
-- transaction — nothing to lock against, nothing to validate. The account link is the composite key
-- (organization_id, instagram_account_id) -> app.instagram_accounts (organization_id, id), so a
-- contact cannot name another organization's account (B2-5), ON DELETE RESTRICT — an account is
-- never deleted, only revoked (CT13).
--
-- The upsert target is the unique (organization_id, instagram_account_id, instagram_user_id) index.
-- It is NOT partial: an erased contact holds NULL there, which never collides, so a fresh contact can
-- follow an erased one (CT9). Its name is shorter than the review's
-- `idx_contacts_organization_id_instagram_account_id_instagram_user_id` (67 characters), which
-- Postgres would cut at 63.
--
-- Row-level security: ENABLE + FORCE, one `contacts_tenant_isolation` policy FOR ALL — USING the
-- organization arm plus the retention sweep arm bound to the maintenance role, WITH CHECK the
-- organization arm only (the member-role.schema.ts pattern). No cross-organization resolver: event
-- processing routes an event to its organization before any contact is read.

CREATE TABLE IF NOT EXISTS app.contacts (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  instagram_account_id BIGINT NOT NULL,
  instagram_user_id VARCHAR(64),
  username VARCHAR(64),
  full_name VARCHAR(255),
  profile_picture_url TEXT,
  followers_count INTEGER,
  is_following_account BOOLEAN,
  follow_checked_at TIMESTAMPTZ,
  email VARCHAR(255),
  email_collected_at TIMESTAMPTZ,
  phone VARCHAR(20),
  phone_collected_at TIMESTAMPTZ,
  tags TEXT[] NOT NULL DEFAULT '{}',
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_message_received_at TIMESTAMPTZ NOT NULL,
  last_direct_message_received_at TIMESTAMPTZ,
  last_message_sent_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contacts_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT contacts_instagram_account_fk FOREIGN KEY (organization_id, instagram_account_id) REFERENCES app.instagram_accounts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_contacts_instagram_user_id CHECK (instagram_user_id ~ '^[0-9]{1,64}$'),
  CONSTRAINT chk_contacts_email CHECK (email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT chk_contacts_phone CHECK (phone ~ '^\+?[0-9]{10,15}$'),
  CONSTRAINT chk_contacts_email_collected CHECK ((email IS NULL) = (email_collected_at IS NULL)),
  CONSTRAINT chk_contacts_phone_collected CHECK ((phone IS NULL) = (phone_collected_at IS NULL)),
  CONSTRAINT chk_contacts_follow_checked CHECK ((is_following_account IS NULL) = (follow_checked_at IS NULL)),
  CONSTRAINT chk_contacts_followers_count CHECK (followers_count >= 0),
  CONSTRAINT chk_contacts_profile_picture_url CHECK (profile_picture_url ~ '^https://'),
  CONSTRAINT chk_contacts_tags CHECK (cardinality(tags) <= 50 AND array_position(tags, NULL) IS NULL),
  CONSTRAINT chk_contacts_erased CHECK (
    (deleted_at IS NULL) = (instagram_user_id IS NOT NULL)
    AND (
      deleted_at IS NULL
      OR (
        num_nonnulls(username, full_name, profile_picture_url, followers_count, is_following_account, follow_checked_at, email, email_collected_at, phone, phone_collected_at) = 0
        AND cardinality(tags) = 0
      )
    )
  ),
  CONSTRAINT chk_contacts_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_public_id ON app.contacts USING btree (public_id);
--> statement-breakpoint
-- The parent key of the runs' composite reference (sub-domain 3): (organization_id, contact_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_organization_id_id ON app.contacts USING btree (organization_id, id);
--> statement-breakpoint
-- The upsert target (CT13) and the account reference's index; leads with organization_id, so it also
-- serves the organization cascade.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_organization_account_instagram_user ON app.contacts USING btree (organization_id, instagram_account_id, instagram_user_id);
--> statement-breakpoint
-- One index per list sort over the live contacts (CT6, CQ2). The two time sorts read theirs forwards
-- and backwards; the username sort needs two, since its contacts without a username come last in both
-- directions: read backwards the ascending index puts them first (and the id tie-break reversed).
CREATE INDEX IF NOT EXISTS idx_contacts_organization_id_last_message_received_at_id ON app.contacts USING btree (organization_id, last_message_received_at, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_contacts_organization_id_first_seen_at_id ON app.contacts USING btree (organization_id, first_seen_at, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_contacts_organization_id_username_id ON app.contacts USING btree (organization_id, username, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_contacts_organization_id_username_desc_id ON app.contacts USING btree (organization_id, username DESC NULLS LAST, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- The list's `q` (CT4): username, full name and email in one expression — the repository searches
-- this expression verbatim. pg_trgm is already installed.
CREATE INDEX IF NOT EXISTS idx_contacts_search_trgm ON app.contacts USING gin ((coalesce(username, '') || ' ' || coalesce(full_name, '') || ' ' || coalesce(email, '')) gin_trgm_ops) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- The list's `tags` filter: `tags @> $1` (CT4).
CREATE INDEX IF NOT EXISTS idx_contacts_tags_gin ON app.contacts USING gin (tags) WHERE deleted_at IS NULL;
--> statement-breakpoint
ALTER TABLE app.contacts OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.contacts TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.contacts_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.contacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.contacts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS contacts_tenant_isolation ON app.contacts;
--> statement-breakpoint
CREATE POLICY contacts_tenant_isolation ON app.contacts
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
