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
-- New, empty tables: the keys, CHECKs and indexes are created with them, inside this file's
-- transaction — nothing to lock against, nothing to validate. The account link is the composite key
-- (organization_id, channel_account_id) -> app.channel_accounts (organization_id, id) since ROUTE R10
-- (launch: -> app.instagram_accounts), so a contact cannot name another organization's account
-- (B2-5), ON DELETE RESTRICT — an account is never deleted, only revoked.
--
-- The upsert target is the unique (organization_id, channel_account_id, instagram_user_id) index.
-- It is NOT partial: an erased contact holds NULL there, which never collides, so a fresh contact can
-- follow an erased one (CT9). Its name is shorter than the review's
-- `idx_contacts_organization_id_instagram_account_id_instagram_user_id` (67 characters), which
-- Postgres would cut at 63.
--
-- Row-level security: ENABLE + FORCE, one `contacts_tenant_isolation` policy FOR ALL — USING the
-- organization arm plus the retention sweep arm bound to the maintenance role, WITH CHECK the
-- organization arm only (the member-role.schema.ts pattern). No cross-organization resolver: event
-- processing routes an event to its organization before any contact is read.

-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R10 (routes-final.md § 3, § 3.A.3 — CT2, CT3, CT9,
-- CT11, CT18; P29: this launch migration changes in place; P48: shared by every channel; P97 S5–S7):
--
--   app.contacts            keyed by the channel account (`channel_account_id` → app.channel_accounts,
--                           was instagram_account_id → app.instagram_accounts), with `channel`, the
--                           owner's note and pause, her opt-out and how she came in. The fast-changing
--                           activity times moved out to app.contact_activities (S5), so an inbound event
--                           no longer rewrites a row with two GIN indexes.
--   app.contact_activities  NEW, 1:1 with a live contact (S5): her message, comment, story and broadcast
--                           times, written by every inbound event; fillfactor 70 and only the indexes
--                           the list sort, broadcasts and segments read. Deleted with the erase (CT11).
--   app.contact_tag_counts  NEW (S7): how many live contacts of one account hold each tag, kept in the
--                           tag change's commit — route 22 reads it instead of unnest(tags) over the
--                           account's contacts. A row at 0 is deleted.
--
-- S6: the search and the tags filter lead with the account through btree_gin (a trusted contrib
-- extension), so a `q` never pulls candidates from another tenant's contacts.
--
-- `first_automation_id`'s key into app.automations is added by the automations migration (sub-domain
-- 4 builds after contacts — routes-final § 3.3).

CREATE EXTENSION IF NOT EXISTS btree_gin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.contacts (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  channel VARCHAR(10) NOT NULL DEFAULT 'instagram',
  instagram_user_id VARCHAR(64),
  username VARCHAR(64),
  full_name VARCHAR(255),
  profile_picture_url TEXT,
  followers_count INTEGER,
  is_following_account BOOLEAN,
  follow_checked_at TIMESTAMPTZ,
  email VARCHAR(254),
  email_collected_at TIMESTAMPTZ,
  phone VARCHAR(20),
  phone_collected_at TIMESTAMPTZ,
  tags TEXT[] NOT NULL DEFAULT '{}',
  note TEXT,
  opted_out_at TIMESTAMPTZ,
  automations_off_at TIMESTAMPTZ,
  automations_off_by_user_id BIGINT,
  first_automation_id BIGINT,
  came_in_via VARCHAR(20),
  came_in_ref VARCHAR(64),
  first_seen_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contacts_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT contacts_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT contacts_automations_off_by_user_id_users_id_fk FOREIGN KEY (automations_off_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT chk_contacts_channel CHECK (channel IN ('instagram')),
  CONSTRAINT chk_contacts_instagram_user_id CHECK (instagram_user_id ~ '^[0-9]{1,64}$'),
  CONSTRAINT chk_contacts_email CHECK (char_length(email) <= 254 AND email ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'),
  CONSTRAINT chk_contacts_phone CHECK (phone ~ '^\+?[0-9]{10,15}$'),
  CONSTRAINT chk_contacts_email_collected CHECK ((email IS NULL) = (email_collected_at IS NULL)),
  CONSTRAINT chk_contacts_phone_collected CHECK ((phone IS NULL) = (phone_collected_at IS NULL)),
  CONSTRAINT chk_contacts_follow_checked CHECK ((is_following_account IS NULL) = (follow_checked_at IS NULL)),
  CONSTRAINT chk_contacts_followers_count CHECK (followers_count >= 0),
  CONSTRAINT chk_contacts_profile_picture_url CHECK (profile_picture_url ~ '^https://'),
  CONSTRAINT chk_contacts_tags CHECK (cardinality(tags) <= 50 AND array_position(tags, NULL) IS NULL),
  CONSTRAINT chk_contacts_note CHECK (char_length(note) BETWEEN 1 AND 2000),
  CONSTRAINT chk_contacts_automations_off CHECK (automations_off_by_user_id IS NULL OR automations_off_at IS NOT NULL),
  CONSTRAINT chk_contacts_came_in_via CHECK (came_in_via IN ('comment', 'live_comment', 'story_reply', 'story_mention', 'story_repost', 'dm_keyword', 'first_message', 'shared_post', 'starter_question', 'ref_link', 'default_reply', 'ad_comment', 'ad_message', 'tag_added', 'tag_removed')),
  CONSTRAINT chk_contacts_erased CHECK (
    (deleted_at IS NULL) = (instagram_user_id IS NOT NULL)
    AND (
      deleted_at IS NULL
      OR (
        num_nonnulls(username, full_name, profile_picture_url, followers_count, is_following_account, follow_checked_at, email, email_collected_at, phone, phone_collected_at, note, opted_out_at, automations_off_at, automations_off_by_user_id, came_in_ref) = 0
        AND cardinality(tags) = 0
      )
    )
  ),
  CONSTRAINT chk_contacts_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_public_id ON app.contacts USING btree (public_id);
--> statement-breakpoint
-- The parent key of the runs' and the activity row's composite reference: (organization_id, contact_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_organization_id_id ON app.contacts USING btree (organization_id, id);
--> statement-breakpoint
-- The upsert target (CT18: the provider's person id unique per organization and channel account) and
-- the account reference's index. Not partial: an erased contact holds NULL, which never collides (CT9).
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_organization_account_instagram_user ON app.contacts USING btree (organization_id, channel_account_id, instagram_user_id);
--> statement-breakpoint
-- The list's two contact-side sorts, re-led with the account (CT2). The `last_message_received_at`
-- sort reads app.contact_activities' index (S5). The username sort needs one index per direction —
-- its contacts without a username come last in both.
CREATE INDEX IF NOT EXISTS idx_contacts_account_first_seen_at_id ON app.contacts USING btree (organization_id, channel_account_id, first_seen_at, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_contacts_account_username_id ON app.contacts USING btree (organization_id, channel_account_id, username, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_contacts_account_username_desc_id ON app.contacts USING btree (organization_id, channel_account_id, username DESC NULLS LAST, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- The list's `q` (CT12, S6): username, full name, email and phone in one expression, led by the
-- account (btree_gin) — the repository searches this expression verbatim with ≥ 3 characters.
CREATE INDEX IF NOT EXISTS idx_contacts_search_trgm ON app.contacts USING gin (channel_account_id, (coalesce(username, '') || ' ' || coalesce(full_name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(phone, '')) gin_trgm_ops) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- The list's `tags` filter, `tags @> $1`, led by the account (S6).
CREATE INDEX IF NOT EXISTS idx_contacts_tags_gin ON app.contacts USING gin (channel_account_id, tags) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- The future key into app.automations (added by the automations migration) and the list's filter.
CREATE INDEX IF NOT EXISTS idx_contacts_first_automation ON app.contacts USING btree (organization_id, first_automation_id) WHERE first_automation_id IS NOT NULL;
--> statement-breakpoint
-- The user key's index (a user delete empties the pointer).
CREATE INDEX IF NOT EXISTS idx_contacts_automations_off_by_user_id ON app.contacts USING btree (automations_off_by_user_id) WHERE automations_off_by_user_id IS NOT NULL;
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
--> statement-breakpoint
-- app.contact_activities (S5): one row per live contact, written with it by every inbound event —
-- unique on the contact (the upsert target); `channel_account_id` is a copy of the contact's, so the list's
-- "last message" sort reads one account in index order. No public id, no timestamps of its own: it is
-- never returned on its own and never edited by a person. fillfactor 70 leaves room for HOT updates of
-- the columns no index reads (sent, opening, story, broadcast, first message, comment count).
CREATE TABLE IF NOT EXISTS app.contact_activities (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT NOT NULL,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  last_message_received_at TIMESTAMPTZ NOT NULL,
  last_direct_message_received_at TIMESTAMPTZ,
  last_message_sent_at TIMESTAMPTZ,
  last_opening_message_at TIMESTAMPTZ,
  first_message_at TIMESTAMPTZ,
  last_comment_at TIMESTAMPTZ,
  comment_count INTEGER NOT NULL DEFAULT 0,
  last_story_activity_at TIMESTAMPTZ,
  last_broadcast_at TIMESTAMPTZ,
  CONSTRAINT contact_activities_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT contact_activities_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES app.contacts (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT contact_activities_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_contact_activities_comment_count CHECK (comment_count >= 0)
) WITH (fillfactor = 70);
--> statement-breakpoint
-- One activity row per contact: the upsert target and the contact key's index (organization first,
-- as the composite key it backs).
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_activities_organization_contact ON app.contact_activities USING btree (organization_id, contact_id);
--> statement-breakpoint
-- The list's default sort (newest message first) over one account, and the account key's index.
CREATE INDEX IF NOT EXISTS idx_contact_activities_account_last_message_received_at ON app.contact_activities USING btree (organization_id, channel_account_id, last_message_received_at, contact_id);
--> statement-breakpoint
-- A broadcast's "chat open" (D68, sub-domain 7): her last DM, story reply or tap, per account.
CREATE INDEX IF NOT EXISTS idx_contact_activities_chat_open ON app.contact_activities USING btree (organization_id, channel_account_id, last_direct_message_received_at) WHERE last_direct_message_received_at IS NOT NULL;
--> statement-breakpoint
-- A segment's "commented in the last N days" (D68, sub-domain 7).
CREATE INDEX IF NOT EXISTS idx_contact_activities_last_comment ON app.contact_activities USING btree (organization_id, channel_account_id, last_comment_at) WHERE last_comment_at IS NOT NULL;
--> statement-breakpoint
ALTER TABLE app.contact_activities OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.contact_activities TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.contact_activities_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.contact_activities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.contact_activities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS contact_activities_tenant_isolation ON app.contact_activities;
--> statement-breakpoint
CREATE POLICY contact_activities_tenant_isolation ON app.contact_activities
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
-- app.contact_tag_counts (S7): per account and tag, how many live contacts hold it — moved in the same
-- commit as every tag change (routes 20 and 21, the tag step, the erase). A row reaching 0 is deleted,
-- so the table holds only the tags in use.
CREATE TABLE IF NOT EXISTS app.contact_tag_counts (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  tag VARCHAR(50) NOT NULL,
  contact_count INTEGER NOT NULL,
  CONSTRAINT contact_tag_counts_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT contact_tag_counts_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_contact_tag_counts_contact_count CHECK (contact_count >= 0),
  CONSTRAINT chk_contact_tag_counts_tag CHECK (char_length(tag) BETWEEN 1 AND 50)
);
--> statement-breakpoint
-- One row per account and tag: the upsert target and the account key's index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_tag_counts_account_tag ON app.contact_tag_counts USING btree (organization_id, channel_account_id, tag);
--> statement-breakpoint
-- Route 22's order: most contacts first, then the tag A→Z.
CREATE INDEX IF NOT EXISTS idx_contact_tag_counts_account_count ON app.contact_tag_counts USING btree (organization_id, channel_account_id, contact_count DESC, tag);
--> statement-breakpoint
ALTER TABLE app.contact_tag_counts OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.contact_tag_counts TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.contact_tag_counts_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.contact_tag_counts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.contact_tag_counts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS contact_tag_counts_tenant_isolation ON app.contact_tag_counts;
--> statement-breakpoint
CREATE POLICY contact_tag_counts_tenant_isolation ON app.contact_tag_counts
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
