-- Migration: app_broadcasts
-- Created: 2026-11-25T12:00:00.000Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty table created in this file; app.instagram_messages is new and empty (ROUTE R19, not yet deployed)"
-- migration-safety: allow drop_index_without_concurrently reason="app.instagram_messages is new and empty (ROUTE R19, not yet deployed); a partitioned index cannot be dropped CONCURRENTLY"
-- migration-safety: allow add_foreign_key_without_not_valid reason="app.instagram_messages is new and empty, and a partitioned table takes no NOT VALID foreign key"
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R22 (routes-final.md § 7.3, § 7.A.3 — BC1,
-- BC4, BC5, BC8, BC9, BC18; BCC1, BCC6; P48, P99): the broadcast itself, shared by every channel.
-- The second of sub-domain 7's files: segments (20261124184321) -> broadcasts -> recipients (R23)
-- -> the messages' key (here, BCC1 — the key needs only this table).
--
--   app.broadcasts   1 to 3 messages of one channel account and its audience — a saved segment or
--                    one-off conditions, copied at send — with its status (moved by actions only,
--                    BC9), the mode chosen at send, its times and its six numbers. Soft-deleted
--                    (BC4, P9) in draft, done or cancelled only; purged 90 days later (P75) by the
--                    hourly purge (WC-62, ROUTE R50).
--
-- A new, empty table: its keys, CHECKs and indexes are created with it, inside this file's
-- transaction. Keys, each composite with organization_id so a broadcast cannot name another
-- organization's row:
--   (organization_id, channel_account_id) -> app.channel_accounts  ON DELETE CASCADE (7.3)
--   (organization_id, segment_id)         -> app.segments          ON DELETE SET NULL (segment_id)
--   (organization_id, start_automation_id) -> app.automations      ON DELETE SET NULL (start_automation_id)
-- `start_automation_id` is the automation the broadcast's button starts (BC8, 7.A.10 — P213).
-- The unique (organization_id, id) index is the parent key of the recipients (R23) and the messages.
--
-- The messages' link (SN17, BCC1): app.instagram_messages (organization_id, broadcast_id) ->
-- app.broadcasts (organization_id, id) ON DELETE CASCADE — the purge takes a broadcast's messages
-- with it (BC4). Its index: R19's `idx_instagram_messages_broadcast (broadcast_id, status)` is
-- rebuilt as (organization_id, broadcast_id, status) so the cascade can use it (index hygiene); every
-- statement already names the organization.
--
-- Row-level security: ENABLE + FORCE, one `broadcasts_tenant_isolation` policy FOR ALL — USING the
-- organization arm plus the retention sweep arm bound to the maintenance role (the start and end
-- duties and the purge read across organizations, 7.3), WITH CHECK the organization arm only.

CREATE TABLE IF NOT EXISTS app.broadcasts (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  channel VARCHAR(10) NOT NULL DEFAULT 'instagram',
  name VARCHAR(255) NOT NULL,
  status VARCHAR(17) NOT NULL DEFAULT 'draft',
  mode VARCHAR(15) NOT NULL DEFAULT 'now',
  segment_id BIGINT,
  conditions JSONB,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  start_automation_id BIGINT,
  scheduled_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason VARCHAR(16),
  matched INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  taps INTEGER NOT NULL DEFAULT 0,
  created_by_user_id BIGINT,
  updated_by_user_id BIGINT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT broadcasts_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT broadcasts_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT broadcasts_segment_fk FOREIGN KEY (organization_id, segment_id) REFERENCES app.segments (organization_id, id) ON DELETE SET NULL (segment_id),
  CONSTRAINT broadcasts_start_automation_fk FOREIGN KEY (organization_id, start_automation_id) REFERENCES app.automations (organization_id, id) ON DELETE SET NULL (start_automation_id),
  CONSTRAINT broadcasts_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT broadcasts_updated_by_user_id_users_id_fk FOREIGN KEY (updated_by_user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT chk_broadcasts_channel CHECK (channel IN ('instagram')),
  CONSTRAINT chk_broadcasts_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 255),
  CONSTRAINT chk_broadcasts_status CHECK (status IN ('draft', 'scheduled', 'sending', 'waiting_for_chats', 'done', 'cancelled')),
  CONSTRAINT chk_broadcasts_mode CHECK (mode IN ('now', 'scheduled', 'when_chat_opens')),
  CONSTRAINT chk_broadcasts_cancel_reason CHECK (cancel_reason IN ('owner', 'plan_feature_off')),
  -- 7.A.3: the messages are an array of at most 3 and 64 KB; 1–3 once sent (a draft may hold 0).
  CONSTRAINT chk_broadcasts_messages CHECK (
    jsonb_typeof(messages) = 'array'
    AND jsonb_array_length(messages) <= 3
    AND octet_length(messages::text) <= 65536
    AND (status IN ('draft', 'cancelled') OR jsonb_array_length(messages) >= 1)
  ),
  -- 7.A.3: the conditions (one-off, then the copy) are an object, set once sent; a draft names one
  -- audience at most (BC8). A draft cancelled before its send keeps what it had.
  CONSTRAINT chk_broadcasts_conditions CHECK (
    (conditions IS NULL OR jsonb_typeof(conditions) = 'object')
    AND (status IN ('draft', 'cancelled') OR conditions IS NOT NULL)
    AND (status <> 'draft' OR segment_id IS NULL OR conditions IS NULL)
  ),
  CONSTRAINT chk_broadcasts_scheduled_at CHECK ((mode = 'scheduled') = (scheduled_at IS NOT NULL)),
  CONSTRAINT chk_broadcasts_ends_at CHECK ((mode = 'when_chat_opens') = (ends_at IS NOT NULL)),
  CONSTRAINT chk_broadcasts_cancelled CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
    AND (cancel_reason IS NULL) = (cancelled_at IS NULL)
  ),
  CONSTRAINT chk_broadcasts_numbers CHECK (matched >= 0 AND sent >= 0 AND skipped >= 0 AND failed >= 0 AND replies >= 0 AND taps >= 0),
  -- BC11: only a broadcast that is not active may be deleted.
  CONSTRAINT chk_broadcasts_deleted CHECK (deleted_at IS NULL OR status IN ('draft', 'done', 'cancelled')),
  CONSTRAINT chk_broadcasts_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcasts_public_id ON app.broadcasts USING btree (public_id);
--> statement-breakpoint
-- The parent key of the recipients (R23) and the messages (organization_id, broadcast_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcasts_organization_id_id ON app.broadcasts USING btree (organization_id, id);
--> statement-breakpoint
-- The account key's cascade (every broadcast of the account, soft-deleted too), full.
CREATE INDEX IF NOT EXISTS idx_broadcasts_channel_account ON app.broadcasts USING btree (organization_id, channel_account_id);
--> statement-breakpoint
-- Route 70 newest first (the default sort) over one account's live broadcasts.
CREATE INDEX IF NOT EXISTS idx_broadcasts_account_created_at_id ON app.broadcasts USING btree (organization_id, channel_account_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- Route 70 by name.
CREATE INDEX IF NOT EXISTS idx_broadcasts_account_name_id ON app.broadcasts USING btree (organization_id, channel_account_id, name, id) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- The start duty (WC-28, R47): due scheduled broadcasts.
CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduled_at ON app.broadcasts USING btree (scheduled_at) WHERE status = 'scheduled';
--> statement-breakpoint
-- Intake's "does a broadcast wait for her" (R47, BC7).
CREATE INDEX IF NOT EXISTS idx_broadcasts_account_waiting_for_chats ON app.broadcasts USING btree (organization_id, channel_account_id) WHERE status = 'waiting_for_chats';
--> statement-breakpoint
-- The end duty (WC-29, R47): waiting-for-chats past ends_at, and the sending / cancelled to settle.
CREATE INDEX IF NOT EXISTS idx_broadcasts_waiting_ends_at ON app.broadcasts USING btree (ends_at) WHERE status = 'waiting_for_chats';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_broadcasts_to_settle ON app.broadcasts USING btree (organization_id, id) WHERE status IN ('sending', 'cancelled');
--> statement-breakpoint
-- The purge (BC4, WC-62): only the soft-deleted rows, so live writes never maintain it.
CREATE INDEX IF NOT EXISTS idx_broadcasts_tombstoned ON app.broadcasts USING btree (deleted_at) WHERE deleted_at IS NOT NULL;
--> statement-breakpoint
-- The segment key's SET NULL, and the segment delete's draft step (BC17).
CREATE INDEX IF NOT EXISTS idx_broadcasts_segment ON app.broadcasts USING btree (organization_id, segment_id) WHERE segment_id IS NOT NULL;
--> statement-breakpoint
-- The button automation key's SET NULL.
CREATE INDEX IF NOT EXISTS idx_broadcasts_start_automation ON app.broadcasts USING btree (organization_id, start_automation_id) WHERE start_automation_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_broadcasts_created_by_user_id ON app.broadcasts USING btree (created_by_user_id) WHERE created_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_broadcasts_updated_by_user_id ON app.broadcasts USING btree (updated_by_user_id) WHERE updated_by_user_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE app.broadcasts OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.broadcasts TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.broadcasts_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.broadcasts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.broadcasts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS broadcasts_tenant_isolation ON app.broadcasts;
--> statement-breakpoint
CREATE POLICY broadcasts_tenant_isolation ON app.broadcasts
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
-- The messages' link to broadcasts (SN17, BCC1): the index the cascade uses, then the key.
DROP INDEX IF EXISTS app.idx_instagram_messages_broadcast;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_instagram_messages_broadcast ON app.instagram_messages USING btree (organization_id, broadcast_id, status) WHERE broadcast_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE app.instagram_messages
  ADD CONSTRAINT instagram_messages_broadcast_fk FOREIGN KEY (organization_id, broadcast_id)
  REFERENCES app.broadcasts (organization_id, id) ON DELETE CASCADE;
