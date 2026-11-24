-- Migration: app_automations
-- Created: 2026-11-21T15:01:35.850Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty tables created in this file"
-- migration-safety: allow add_foreign_key_without_not_valid reason="The two contact keys land on tables created earlier in this same pre-release iteration, before any row exists - nothing to validate."
--
-- launch-2026-11-20-ujai, ROUTE R9 — changed in place by feat-instagram-dm-sending-2026-11-23-oxak,
-- ROUTE R13 (routes-final § 4.3, 4.A.3 — AU8, AU9, AU19, AU34; AUC1, AUC5, AUC7, AUC13; P29: the
-- launch's app migrations change in place, nothing was deployed). The automations shared by every
-- channel (P48), in the `app` schema R1 created (20261121050908_app_schema.sql):
--
--   app.automations              one automation of one channel account: how it starts (flat
--                                columns — 15 ways, also-start-from, target, ref code, starter
--                                questions, ad, trigger tag, default-reply mode), its public reply
--                                and its pacing, and one `steps` object for what it sends (hello,
--                                follow, email, phone, 1–10 messages, tags). draft -> live <-> paused,
--                                by actions only (AU3). Soft-deleted, the reason optional (AU16).
--   app.automation_counts        its all-time counters in 16 slot rows (AU19, D36, D61).
--   app.automation_reply_states  its "Reply like a person" pacing, one per automation (AU19, D32).
--   app.automation_backfills     its past-comments reads, at most one queued or reading (ROUTE R15,
--                                § 4.C.3 — AU31–AU33).
--
-- And the two keys sub-domain 3 left for this migration (§ 4.3): contacts.first_automation_id and
-- contact_tag_events.source_automation_id -> app.automations (organization_id, id), each
-- ON DELETE SET NULL (<column>) — the purge clears them, never the organization column.
--
-- New, empty tables: their keys, CHECKs and indexes are created with them, inside this file's
-- transaction — nothing to lock against, nothing to validate. The account link is the composite key
-- (organization_id, channel_account_id) -> app.channel_accounts (organization_id, id), ON DELETE
-- RESTRICT (an account is revoked, never deleted). The unique (organization_id, id) index is the
-- parent key of every composite reference into automations.
--
-- Two levels of CHECKs (AU9): every save (value lists, lengths, counts, ranges, steps an object of at
-- most 64 KB), and the go-live rules written `status = 'draft' OR (...)`, so a live or paused row must
-- pass them; the API checks every rule first and answers with the problems.
--
-- Row-level security: ENABLE + FORCE on all four. automations: one policy FOR ALL — USING the
-- organization arm plus the retention sweep arm bound to the maintenance role (the purge reads and
-- deletes across organizations), WITH CHECK the organization arm only. Backfills: as automations (the read's watch
-- sweeps across organizations — R41). Counts and reply states: the
-- organization arm only (they go with their automation by cascade).

CREATE TABLE IF NOT EXISTS app.automations (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  channel VARCHAR(10) NOT NULL DEFAULT 'instagram',
  name VARCHAR(255) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'draft',
  trigger_type VARCHAR(20) NOT NULL,
  also_start_from TEXT[] NOT NULL DEFAULT '{}',
  target_scope VARCHAR(10) NOT NULL DEFAULT 'any',
  target_instagram_media_id VARCHAR(64),
  target_instagram_story_id VARCHAR(64),
  target_starts_at TIMESTAMPTZ,
  target_ends_at TIMESTAMPTZ,
  next_post_status VARCHAR(10),
  next_post_linked_at TIMESTAMPTZ,
  keywords TEXT[] NOT NULL DEFAULT '{}',
  ref_code VARCHAR(64),
  starter_questions TEXT[] NOT NULL DEFAULT '{}',
  ad_id VARCHAR(64),
  trigger_tag VARCHAR(50),
  default_reply_mode VARCHAR(12),
  is_public_reply_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  public_reply_texts TEXT[] NOT NULL DEFAULT '{}',
  is_public_reply_mention_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_reply_like_person_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  public_reply_hour_limit SMALLINT,
  is_hide_comment_after_direct_message_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  steps JSONB NOT NULL DEFAULT '{}'::jsonb,
  stopped_reason VARCHAR(20),
  stopped_at TIMESTAMPTZ,
  cancelled_before_at TIMESTAMPTZ,
  last_triggered_at TIMESTAMPTZ,
  created_by_user_id BIGINT,
  updated_by_user_id BIGINT,
  deleted_at TIMESTAMPTZ,
  delete_reason VARCHAR(20),
  delete_note VARCHAR(280),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automations_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT automations_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT automations_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT automations_updated_by_user_id_users_id_fk FOREIGN KEY (updated_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  -- Every save (AU9 level 1).
  CONSTRAINT chk_automations_status CHECK (status IN ('draft', 'live', 'paused')),
  CONSTRAINT chk_automations_trigger_type CHECK (trigger_type IN ('comment', 'live_comment', 'story_reply', 'story_mention', 'story_repost', 'dm_keyword', 'first_message', 'shared_post', 'starter_question', 'ref_link', 'default_reply', 'ad_comment', 'ad_message', 'tag_added', 'tag_removed')),
  CONSTRAINT chk_automations_channel CHECK (channel IN ('instagram')),
  CONSTRAINT chk_automations_target_scope CHECK (target_scope IN ('any', 'specific', 'next', 'between')),
  CONSTRAINT chk_automations_next_post_status CHECK (next_post_status IN ('waiting', 'linked')),
  CONSTRAINT chk_automations_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 255),
  CONSTRAINT chk_automations_also_start_from CHECK (also_start_from <@ ARRAY['story_reply', 'dm']::text[] AND cardinality(also_start_from) <= 2 AND array_position(also_start_from, NULL) IS NULL),
  CONSTRAINT chk_automations_target_dates CHECK (target_ends_at > target_starts_at),
  CONSTRAINT chk_automations_next_post_linked CHECK ((next_post_status IS NOT DISTINCT FROM 'linked') = (next_post_linked_at IS NOT NULL)),
  CONSTRAINT chk_automations_keywords CHECK (cardinality(keywords) <= 50 AND array_position(keywords, NULL) IS NULL),
  CONSTRAINT chk_automations_ref_code CHECK (ref_code ~ '^[A-Za-z0-9_=-]{1,64}$'),
  CONSTRAINT chk_automations_starter_questions CHECK (cardinality(starter_questions) <= 4 AND array_position(starter_questions, NULL) IS NULL),
  CONSTRAINT chk_automations_instagram_ids CHECK (target_instagram_media_id ~ '^[0-9]{1,64}$' AND target_instagram_story_id ~ '^[0-9]{1,64}$' AND ad_id ~ '^[0-9]{1,64}$'),
  CONSTRAINT chk_automations_trigger_tag CHECK (char_length(btrim(trigger_tag)) BETWEEN 1 AND 50),
  CONSTRAINT chk_automations_default_reply_mode CHECK (default_reply_mode IN ('once_a_day', 'every_time')),
  CONSTRAINT chk_automations_public_reply_texts CHECK (cardinality(public_reply_texts) <= 20 AND array_position(public_reply_texts, NULL) IS NULL),
  CONSTRAINT chk_automations_public_reply_hour_limit CHECK (public_reply_hour_limit IN (10, 20, 30, 60, 100)),
  CONSTRAINT chk_automations_steps CHECK (jsonb_typeof(steps) = 'object' AND octet_length(steps::text) <= 65536),
  CONSTRAINT chk_automations_stopped_reason CHECK (stopped_reason IN ('bad_text', 'post_deleted')),
  CONSTRAINT chk_automations_stopped CHECK ((stopped_reason IS NULL) = (stopped_at IS NULL)),
  CONSTRAINT chk_automations_delete_reason CHECK (delete_reason IN ('mistake', 'duplicate', 'not_needed', 'other')),
  CONSTRAINT chk_automations_delete_reason_when_deleted CHECK (delete_reason IS NULL OR deleted_at IS NOT NULL),
  CONSTRAINT chk_automations_delete_note_when_other CHECK (delete_reason IS DISTINCT FROM 'other' OR delete_note IS NOT NULL),
  CONSTRAINT chk_automations_updated CHECK (updated_at >= created_at),
  -- Go live (AU9 level 2): a draft passes, a live or paused row must hold the rule.
  CONSTRAINT chk_automations_live_trigger_fields CHECK (status = 'draft' OR (
    (trigger_type <> 'ref_link' OR ref_code IS NOT NULL)
    AND (trigger_type <> 'starter_question' OR cardinality(starter_questions) BETWEEN 1 AND 4)
    AND (trigger_type NOT IN ('ad_comment', 'ad_message') OR ad_id IS NOT NULL)
    AND (trigger_type NOT IN ('tag_added', 'tag_removed') OR trigger_tag IS NOT NULL)
    AND (trigger_type <> 'default_reply' OR default_reply_mode IS NOT NULL)
    AND (trigger_type <> 'dm_keyword' OR cardinality(keywords) >= 1)
  )),
  CONSTRAINT chk_automations_live_target CHECK (status = 'draft' OR (
    (trigger_type = 'comment' OR target_scope IN ('any', 'specific'))
    AND (trigger_type IN ('comment', 'story_reply', 'shared_post') OR target_scope = 'any')
    AND (target_scope <> 'specific' OR trigger_type = 'story_reply' OR (target_instagram_media_id IS NOT NULL AND target_instagram_story_id IS NULL))
    AND (target_scope <> 'specific' OR trigger_type <> 'story_reply' OR (target_instagram_story_id IS NOT NULL AND target_instagram_media_id IS NULL))
    AND (target_scope NOT IN ('any', 'between') OR (target_instagram_media_id IS NULL AND target_instagram_story_id IS NULL))
    AND (target_scope <> 'next' OR target_instagram_story_id IS NULL)
  )),
  CONSTRAINT chk_automations_live_also_start_from CHECK (status = 'draft' OR (
    CASE trigger_type
      WHEN 'comment' THEN also_start_from <@ ARRAY['story_reply', 'dm']::text[]
      WHEN 'story_reply' THEN also_start_from <@ ARRAY['dm']::text[]
      WHEN 'dm_keyword' THEN also_start_from <@ ARRAY['story_reply']::text[]
      ELSE cardinality(also_start_from) = 0
    END
  )),
  CONSTRAINT chk_automations_live_next_post CHECK (status = 'draft' OR (
    (target_scope = 'next') = (next_post_status IS NOT NULL)
    AND (target_scope <> 'next' OR (target_starts_at IS NOT NULL AND target_ends_at IS NULL))
    AND (target_scope <> 'next' OR (next_post_status = 'linked') = (target_instagram_media_id IS NOT NULL))
  )),
  CONSTRAINT chk_automations_live_between CHECK (status = 'draft' OR (
    target_scope <> 'between' OR (target_starts_at IS NOT NULL AND target_ends_at IS NOT NULL)
  )),
  CONSTRAINT chk_automations_live_public_reply CHECK (status = 'draft' OR (
    NOT is_public_reply_enabled
    OR (trigger_type IN ('comment', 'ad_comment') AND cardinality(public_reply_texts) >= 1
      AND (NOT is_reply_like_person_enabled OR cardinality(public_reply_texts) >= 3))
  )),
  CONSTRAINT chk_automations_live_hide CHECK (status = 'draft' OR (
    NOT is_hide_comment_after_direct_message_enabled OR trigger_type IN ('comment', 'ad_comment')
  )),
  CONSTRAINT chk_automations_live_messages CHECK (status = 'draft' OR (
    jsonb_typeof(steps -> 'messages') = 'array' AND jsonb_array_length(steps -> 'messages') BETWEEN 1 AND 10
  )),
  -- Replaces the launch's chk_automations_comment_opening_button (P2): a hello that is on has a
  -- "sends your next step" button in every version, for every way to start.
  CONSTRAINT chk_automations_live_hello_next_button CHECK (status = 'draft' OR (
    steps -> 'hello' -> 'on' IS DISTINCT FROM 'true'::jsonb
    OR NOT jsonb_path_exists(steps, '$.hello.versions[*] ? (!exists(@.buttons[*] ? (@.action == "next")))')
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_automations_public_id ON app.automations USING btree (public_id);
--> statement-breakpoint
-- The parent key of every composite reference into automations (runs, logs, counts, reply states,
-- the two contact keys); it also serves the organization cascade.
CREATE UNIQUE INDEX IF NOT EXISTS idx_automations_organization_id_id ON app.automations USING btree (organization_id, id);
--> statement-breakpoint
-- The account reference (every foreign key indexed — not partial, so it covers soft-deleted rows).
CREATE INDEX IF NOT EXISTS idx_automations_organization_id_channel_account_id ON app.automations USING btree (organization_id, channel_account_id);
--> statement-breakpoint
-- One index per list sort over one account's automations (AU10 — the list names its account).
CREATE INDEX IF NOT EXISTS idx_automations_account_created_at_id ON app.automations USING btree (organization_id, channel_account_id, created_at, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_automations_account_name_id ON app.automations USING btree (organization_id, channel_account_id, name, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- last_triggered_at with never-triggered last in both directions: one index each way (launch
-- follow-up 2).
CREATE INDEX IF NOT EXISTS idx_automations_account_last_triggered_at_id ON app.automations USING btree (organization_id, channel_account_id, last_triggered_at ASC NULLS LAST, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_automations_account_last_triggered_at_desc_id ON app.automations USING btree (organization_id, channel_account_id, last_triggered_at DESC NULLS LAST, id DESC) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- The list's `q` over the name, any case. pg_trgm is already installed.
CREATE INDEX IF NOT EXISTS idx_automations_name_trgm ON app.automations USING gin (name gin_trgm_ops) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- An event's candidates, of the event's account only.
CREATE INDEX IF NOT EXISTS idx_automations_live_triggers ON app.automations USING btree (organization_id, channel_account_id, trigger_type) WHERE status = 'live' AND deleted_at IS NULL;
--> statement-breakpoint
-- A comment's post-linked automations and "already targeted".
CREATE INDEX IF NOT EXISTS idx_automations_target_media ON app.automations USING btree (organization_id, channel_account_id, target_instagram_media_id) WHERE target_instagram_media_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
-- The linking sweep's live, waiting "next post" automations of an account (AU20, WC-43 — no end date).
CREATE INDEX IF NOT EXISTS idx_automations_next_post_waiting ON app.automations USING btree (organization_id, channel_account_id) WHERE next_post_status = 'waiting' AND status = 'live' AND deleted_at IS NULL;
--> statement-breakpoint
-- ref_code unique per account, drafts included (D43).
CREATE UNIQUE INDEX IF NOT EXISTS idx_automations_account_ref_code ON app.automations USING btree (organization_id, channel_account_id, ref_code) WHERE ref_code IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
-- The tombstone purge: only the soft-deleted rows, so live writes never maintain it.
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app.automation_counts (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  automation_id BIGINT NOT NULL,
  slot SMALLINT NOT NULL,
  runs_started BIGINT NOT NULL DEFAULT 0,
  taps BIGINT NOT NULL DEFAULT 0,
  typed_answers BIGINT NOT NULL DEFAULT 0,
  runs_by_version JSONB NOT NULL DEFAULT '{}'::jsonb,
  taps_by_version JSONB NOT NULL DEFAULT '{}'::jsonb,
  typed_by_version JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automation_counts_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT automation_counts_automation_fk FOREIGN KEY (organization_id, automation_id) REFERENCES app.automations (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_automation_counts_slot CHECK (slot BETWEEN 0 AND 15),
  CONSTRAINT chk_automation_counts_values CHECK (runs_started >= 0 AND taps >= 0 AND typed_answers >= 0),
  CONSTRAINT chk_automation_counts_by_version CHECK (jsonb_typeof(runs_by_version) = 'object' AND jsonb_typeof(taps_by_version) = 'object' AND jsonb_typeof(typed_by_version) = 'object')
);
--> statement-breakpoint
-- One row per automation and slot: the upsert target (the plan's key) and the automation key's index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_counts_automation_slot ON app.automation_counts USING btree (organization_id, automation_id, slot);
--> statement-breakpoint
ALTER TABLE app.automation_counts OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.automation_counts TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.automation_counts_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.automation_counts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.automation_counts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS automation_counts_tenant_isolation ON app.automation_counts;
--> statement-breakpoint
CREATE POLICY automation_counts_tenant_isolation ON app.automation_counts
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
CREATE TABLE IF NOT EXISTS app.automation_reply_states (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  automation_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  box_start TIMESTAMPTZ,
  last_text_number SMALLINT,
  waiting_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automation_reply_states_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT automation_reply_states_automation_fk FOREIGN KEY (organization_id, automation_id) REFERENCES app.automations (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT automation_reply_states_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_automation_reply_states_waiting_count CHECK (waiting_count >= 0),
  CONSTRAINT chk_automation_reply_states_last_text_number CHECK (last_text_number >= 1)
);
--> statement-breakpoint
-- One per automation: the upsert target and the automation key's index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_reply_states_automation ON app.automation_reply_states USING btree (organization_id, automation_id);
--> statement-breakpoint
-- The account key and the reply pick's per-account read.
CREATE INDEX IF NOT EXISTS idx_automation_reply_states_account ON app.automation_reply_states USING btree (organization_id, channel_account_id);
--> statement-breakpoint
ALTER TABLE app.automation_reply_states OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.automation_reply_states TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.automation_reply_states_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.automation_reply_states ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.automation_reply_states FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS automation_reply_states_tenant_isolation ON app.automation_reply_states;
--> statement-breakpoint
CREATE POLICY automation_reply_states_tenant_isolation ON app.automation_reply_states
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
-- Sub-domain 3's two keys into automations (§ 4.3; R10, R11): new constraints on tables created
-- earlier in this release, before any row exists — added validated.
ALTER TABLE app.contacts ADD CONSTRAINT contacts_first_automation_fk FOREIGN KEY (organization_id, first_automation_id) REFERENCES app.automations (organization_id, id) ON DELETE SET NULL (first_automation_id);
--> statement-breakpoint
ALTER TABLE app.contact_tag_events ADD CONSTRAINT contact_tag_events_source_automation_fk FOREIGN KEY (organization_id, source_automation_id) REFERENCES app.automations (organization_id, id) ON DELETE SET NULL (source_automation_id);
--> statement-breakpoint
-- ROUTE R15 (routes-final § 4.C.3 — AU31–AU33, AUC12; changed in place, P29): one past-comments read
-- of a live comment or ad-comment automation. At most one queued or reading per automation (the
-- partial unique index); the account is a copy (one read at a time per account — the read job, R41).
-- The automation key cascades (the purge takes it along); the account key restricts (an account is
-- revoked, never deleted).
CREATE TABLE IF NOT EXISTS app.automation_backfills (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  automation_id BIGINT NOT NULL,
  days SMALLINT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'queued',
  posts_read INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  queued_count INTEGER NOT NULL DEFAULT 0,
  fail_reason VARCHAR(30),
  last_error VARCHAR(500),
  requested_by_user_id BIGINT,
  started_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automation_backfills_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT automation_backfills_automation_fk FOREIGN KEY (organization_id, automation_id) REFERENCES app.automations (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT automation_backfills_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT automation_backfills_requested_by_user_id_users_id_fk FOREIGN KEY (requested_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT chk_automation_backfills_days CHECK (days BETWEEN 1 AND 7),
  CONSTRAINT chk_automation_backfills_status CHECK (status IN ('queued', 'reading', 'done', 'failed')),
  CONSTRAINT chk_automation_backfills_fail_reason CHECK ((status = 'failed') = (fail_reason IS NOT NULL) AND (fail_reason IS NULL OR fail_reason IN ('meta_error', 'plan_feature_off'))),
  CONSTRAINT chk_automation_backfills_counters CHECK (posts_read >= 0 AND found >= 0 AND matched >= 0 AND queued_count >= 0),
  CONSTRAINT chk_automation_backfills_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_backfills_public_id ON app.automation_backfills USING btree (public_id);
--> statement-breakpoint
-- One queued or reading read per automation (route 38's 409 automation_backfill_in_progress).
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_backfills_open ON app.automation_backfills USING btree (organization_id, automation_id) WHERE status IN ('queued', 'reading');
--> statement-breakpoint
-- The automation key's index (the open index is partial, so the cascade cannot use it).
CREATE INDEX IF NOT EXISTS idx_automation_backfills_automation_created_at ON app.automation_backfills USING btree (organization_id, automation_id, created_at);
--> statement-breakpoint
-- The account key's index (the queued index is partial, so the key cannot use it).
CREATE INDEX IF NOT EXISTS idx_automation_backfills_organization_id_channel_account_id ON app.automation_backfills USING btree (organization_id, channel_account_id);
--> statement-breakpoint
-- The read's 10-minute watch across organizations (AU32, R41).
CREATE INDEX IF NOT EXISTS idx_automation_backfills_watch ON app.automation_backfills USING btree (status, updated_at) WHERE status IN ('queued', 'reading');
--> statement-breakpoint
-- The next queued read of an account (AU32, R41).
CREATE INDEX IF NOT EXISTS idx_automation_backfills_account_queued ON app.automation_backfills USING btree (organization_id, channel_account_id, created_at) WHERE status = 'queued';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_automation_backfills_requested_by_user_id ON app.automation_backfills USING btree (requested_by_user_id) WHERE requested_by_user_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE app.automation_backfills OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.automation_backfills TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.automation_backfills_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.automation_backfills ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.automation_backfills FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS automation_backfills_tenant_isolation ON app.automation_backfills;
--> statement-breakpoint
CREATE POLICY automation_backfills_tenant_isolation ON app.automation_backfills
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
