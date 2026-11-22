-- Migration: app_automations
-- Created: 2026-11-21T15:01:35.850Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty table created in this file"
--
-- launch-2026-11-20-ujai, ROUTE R9 (routes-final.md § 3.3, 3.A.3 — AU7–AU15, AU27; AUC5): the
-- automations an organization builds to answer comments, DMs and story replies on its Instagram
-- account, in the `app` schema R1 created (20261121050908_app_schema.sql).
--
--   app.automations   one automation of one Instagram account — the account connected when it was
--                     created, never changed (AU27): its trigger, target, keywords, tags, the
--                     message of each step (JSON objects, schema-routes § 10) and the counters the
--                     run engine keeps (AU10). Always a complete flow (AU8). Soft-deleted with the
--                     confirm drawer's reason and note (AU12, as tenancy.roles); purged 180 days
--                     later once nothing points at it (AQ7).
--
-- A new, empty table: its keys, CHECKs and indexes are created with it, inside this file's
-- transaction — nothing to lock against, nothing to validate. The account link is the composite
-- key (organization_id, instagram_account_id) -> app.instagram_accounts (organization_id, id), so an
-- automation cannot name another organization's account (B2-5), ON DELETE RESTRICT — an account is
-- never deleted, only revoked (AU27, as contacts CT13). The unique (organization_id, id) index is
-- the parent key of the runs' and comment logs' composite references (sub-domain 3.B, R10).
--
-- The "next post" columns (AU9, AU15): the window and next_post_status are set exactly on
-- target_scope 'next'; the media id is set exactly when linked. The overlap check and linking read
-- idx_automations_next_post_waiting; the 15-minute expiry scan reads idx_automations_next_post_expiry
-- across organizations. No GIN index on keywords (3.A.3 drops the drop's): the overlap check reads
-- one account's few waiting automations, and its "either has no keywords" arm is an OR a GIN index
-- cannot serve.
--
-- Row-level security: ENABLE + FORCE, one `automations_tenant_isolation` policy FOR ALL — USING the
-- organization arm plus the retention sweep arm bound to the maintenance role (the expiry scan and
-- the purge read across organizations), WITH CHECK the organization arm only (the member-role.schema.ts
-- pattern), so the sweep can read and delete but never update across organizations.

CREATE TABLE IF NOT EXISTS app.automations (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  instagram_account_id BIGINT NOT NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'inactive',
  trigger_type VARCHAR(15) NOT NULL,
  target_scope VARCHAR(10) NOT NULL DEFAULT 'any',
  target_instagram_media_id VARCHAR(64),
  target_instagram_story_id VARCHAR(64),
  next_post_starts_at TIMESTAMPTZ,
  next_post_ends_at TIMESTAMPTZ,
  next_post_status VARCHAR(10),
  next_post_linked_at TIMESTAMPTZ,
  is_dm_keyword_trigger_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  keywords TEXT[] NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  is_public_reply_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  public_reply_texts TEXT[] NOT NULL DEFAULT '{}',
  is_opening_message_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  opening_message JSONB,
  is_follow_required BOOLEAN NOT NULL DEFAULT FALSE,
  follow_request_message JSONB,
  is_email_collection_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  email_request_message JSONB,
  is_phone_collection_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  phone_request_message JSONB,
  final_message JSONB NOT NULL,
  completed_run_count INTEGER NOT NULL DEFAULT 0,
  last_triggered_at TIMESTAMPTZ,
  created_by_user_id BIGINT,
  updated_by_user_id BIGINT,
  deleted_at TIMESTAMPTZ,
  delete_reason VARCHAR(20),
  delete_note VARCHAR(280),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automations_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT automations_instagram_account_fk FOREIGN KEY (organization_id, instagram_account_id) REFERENCES app.instagram_accounts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT automations_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT automations_updated_by_user_id_users_id_fk FOREIGN KEY (updated_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT chk_automations_status CHECK (status IN ('live', 'inactive')),
  CONSTRAINT chk_automations_trigger_type CHECK (trigger_type IN ('comment', 'story_reply', 'dm')),
  CONSTRAINT chk_automations_target_scope CHECK (target_scope IN ('any', 'specific', 'next')),
  CONSTRAINT chk_automations_next_post_status CHECK (next_post_status IN ('waiting', 'linked', 'expired')),
  CONSTRAINT chk_automations_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 255),
  CONSTRAINT chk_automations_next_only_comment CHECK (target_scope <> 'next' OR trigger_type = 'comment'),
  CONSTRAINT chk_automations_dm_scope CHECK (trigger_type <> 'dm' OR target_scope = 'any'),
  CONSTRAINT chk_automations_dm_keyword_trigger CHECK (trigger_type <> 'dm' OR is_dm_keyword_trigger_enabled),
  CONSTRAINT chk_automations_dm_needs_keywords CHECK (trigger_type <> 'dm' OR cardinality(keywords) >= 1),
  CONSTRAINT chk_automations_specific_target CHECK (
    (target_scope <> 'specific' OR trigger_type <> 'comment' OR (target_instagram_media_id IS NOT NULL AND target_instagram_story_id IS NULL))
    AND (target_scope <> 'specific' OR trigger_type <> 'story_reply' OR (target_instagram_story_id IS NOT NULL AND target_instagram_media_id IS NULL))
    AND (target_scope <> 'any' OR (target_instagram_media_id IS NULL AND target_instagram_story_id IS NULL))
    AND (target_scope <> 'next' OR target_instagram_story_id IS NULL)
  ),
  CONSTRAINT chk_automations_next_post_fields CHECK (
    (target_scope = 'next') = (next_post_status IS NOT NULL)
    AND (target_scope = 'next') = (next_post_starts_at IS NOT NULL)
    AND (target_scope = 'next') = (next_post_ends_at IS NOT NULL)
  ),
  CONSTRAINT chk_automations_next_post_window CHECK (next_post_ends_at > next_post_starts_at),
  CONSTRAINT chk_automations_next_post_linked CHECK (
    (next_post_status IS NOT DISTINCT FROM 'linked') = (next_post_linked_at IS NOT NULL)
    AND (target_scope <> 'next' OR (next_post_status IS NOT DISTINCT FROM 'linked') = (target_instagram_media_id IS NOT NULL))
  ),
  CONSTRAINT chk_automations_keywords CHECK (cardinality(keywords) <= 50 AND array_position(keywords, NULL) IS NULL),
  CONSTRAINT chk_automations_tags CHECK (cardinality(tags) <= 20 AND array_position(tags, NULL) IS NULL),
  CONSTRAINT chk_automations_public_reply_texts CHECK (cardinality(public_reply_texts) <= 20 AND array_position(public_reply_texts, NULL) IS NULL),
  CONSTRAINT chk_automations_public_reply CHECK (NOT is_public_reply_enabled OR (trigger_type = 'comment' AND cardinality(public_reply_texts) >= 1)),
  CONSTRAINT chk_automations_message_objects CHECK (
    (opening_message IS NULL OR jsonb_typeof(opening_message) = 'object')
    AND (follow_request_message IS NULL OR jsonb_typeof(follow_request_message) = 'object')
    AND (email_request_message IS NULL OR jsonb_typeof(email_request_message) = 'object')
    AND (phone_request_message IS NULL OR jsonb_typeof(phone_request_message) = 'object')
    AND jsonb_typeof(final_message) = 'object'
  ),
  CONSTRAINT chk_automations_enabled_steps_have_messages CHECK (
    (NOT is_opening_message_enabled OR opening_message IS NOT NULL)
    AND (NOT is_follow_required OR follow_request_message IS NOT NULL)
  ),
  CONSTRAINT chk_automations_comment_opening_button CHECK (trigger_type <> 'comment' OR NOT is_opening_message_enabled OR coalesce(jsonb_typeof(opening_message -> 'button_title') = 'string', false)),
  CONSTRAINT chk_automations_instagram_ids CHECK (target_instagram_media_id ~ '^[0-9]{1,64}$' AND target_instagram_story_id ~ '^[0-9]{1,64}$'),
  CONSTRAINT chk_automations_completed_run_count CHECK (completed_run_count >= 0),
  CONSTRAINT chk_automations_delete_reason CHECK (delete_reason IN ('mistake', 'duplicate', 'not_needed', 'other')),
  CONSTRAINT chk_automations_delete_reason_when_deleted CHECK (delete_reason IS NULL OR deleted_at IS NOT NULL),
  CONSTRAINT chk_automations_delete_note_when_other CHECK (delete_reason IS DISTINCT FROM 'other' OR delete_note IS NOT NULL),
  CONSTRAINT chk_automations_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_automations_public_id ON app.automations USING btree (public_id);
--> statement-breakpoint
-- The parent key of the runs' and comment logs' composite references (sub-domain 3.B); it also
-- serves the organization cascade.
CREATE UNIQUE INDEX IF NOT EXISTS idx_automations_organization_id_id ON app.automations USING btree (organization_id, id);
--> statement-breakpoint
-- The account reference (every foreign key indexed — not partial, so it covers soft-deleted rows)
-- and the list's instagram_account_id filter (AU13, AU27).
CREATE INDEX IF NOT EXISTS idx_automations_organization_id_instagram_account_id ON app.automations USING btree (organization_id, instagram_account_id);
--> statement-breakpoint
-- One index per list sort over the live automations, each serving both directions (AU13, AQ9).
CREATE INDEX IF NOT EXISTS idx_automations_organization_id_created_at_id ON app.automations USING btree (organization_id, created_at, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_automations_organization_id_name_id ON app.automations USING btree (organization_id, name, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_automations_organization_id_last_triggered_at_id ON app.automations USING btree (organization_id, last_triggered_at, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_automations_organization_id_completed_run_count_id ON app.automations USING btree (organization_id, completed_run_count, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- The list's `q` over the name, any case (AU13). pg_trgm is already installed.
CREATE INDEX IF NOT EXISTS idx_automations_name_trgm ON app.automations USING gin (name gin_trgm_ops) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- An event's candidates, of the event's account only (AU16, AU27).
CREATE INDEX IF NOT EXISTS idx_automations_live_triggers ON app.automations USING btree (organization_id, instagram_account_id, trigger_type) WHERE status = 'live' AND deleted_at IS NULL;
--> statement-breakpoint
-- A comment's post-linked automations (AU16) and "already targeted" (AU15).
CREATE INDEX IF NOT EXISTS idx_automations_target_media ON app.automations USING btree (organization_id, instagram_account_id, target_instagram_media_id) WHERE target_instagram_media_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
-- Linking and the overlap check, per account (AU9, AU15).
CREATE INDEX IF NOT EXISTS idx_automations_next_post_waiting ON app.automations USING btree (organization_id, instagram_account_id, next_post_ends_at) WHERE next_post_status = 'waiting' AND deleted_at IS NULL;
--> statement-breakpoint
-- The 15-minute expiry scan across organizations (AU15, D9).
CREATE INDEX IF NOT EXISTS idx_automations_next_post_expiry ON app.automations USING btree (next_post_ends_at) WHERE next_post_status = 'waiting' AND deleted_at IS NULL;
--> statement-breakpoint
-- The tombstone purge (AQ7): only the soft-deleted rows, so live writes never maintain it.
CREATE INDEX IF NOT EXISTS idx_automations_tombstoned ON app.automations USING btree (deleted_at) WHERE deleted_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_automations_created_by_user_id ON app.automations USING btree (created_by_user_id) WHERE created_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_automations_updated_by_user_id ON app.automations USING btree (updated_by_user_id) WHERE updated_by_user_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE app.automations OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.automations TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.automations_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.automations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.automations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS automations_tenant_isolation ON app.automations;
--> statement-breakpoint
CREATE POLICY automations_tenant_isolation ON app.automations
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
