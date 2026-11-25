-- Migration: app_broadcast_recipients
-- Created: 2026-11-25T18:30:00.000Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="new empty table created in this file"
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R23 (routes-final.md § 7.3, § 7.C.3 — BC16,
-- BC17, BC18; BCC9, BCC10; P33, P96): who a broadcast goes to and what happened to her first
-- message, shared by every channel. The third of sub-domain 7's files: segments (20261124184321) ->
-- broadcasts (20261125120000, with the messages' key) -> recipients (here).
--
--   app.broadcast_recipients   one person a broadcast goes to: `waiting`, then her first message's
--                              result (`sent` with sent_at, `skipped` / `failed` with a reason,
--                              `unknown`); her first reply after it (replied_at, set once). No public
--                              id, no soft delete, no *_by_user_id; never listed (7.C.6).
--
-- A PLAIN table (P33, P96 — about 120 M rows at target, revisited with S24), so "once per person per
-- broadcast" is a real unique key: (organization_id, broadcast_id, contact_id). A `skipped` ·
-- `owner_chat` row is put back to `waiting` instead of a second row (plan §20.10). Rows are deleted
-- 90 days after they were made (BC16, P92) by the hourly, time-budgeted clean-up (WC-53, ROUTE R50)
-- through idx_broadcast_recipients_created_at, whatever the broadcast's state.
--
-- Keys, each composite with organization_id so a recipient cannot name another organization's row:
--   (organization_id, broadcast_id) -> app.broadcasts  ON DELETE CASCADE (the purge takes them)
--   (organization_id, contact_id)   -> app.contacts    ON DELETE RESTRICT (contacts are erased in place)
-- channel_account_id is a copy of the broadcast's, for the lane's pick — no key of its own (7.C.3).
--
-- Row-level security: ENABLE + FORCE, one `broadcast_recipients_tenant_isolation` policy FOR ALL —
-- USING the organization arm plus the retention sweep arm bound to the maintenance role (the
-- clean-up reads across organizations), WITH CHECK the organization arm only.

CREATE TABLE IF NOT EXISTS app.broadcast_recipients (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  broadcast_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  status VARCHAR(7) NOT NULL DEFAULT 'waiting',
  reason VARCHAR(30),
  version_number SMALLINT,
  sent_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT broadcast_recipients_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT broadcast_recipients_broadcast_fk FOREIGN KEY (organization_id, broadcast_id) REFERENCES app.broadcasts (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT broadcast_recipients_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES app.contacts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_broadcast_recipients_status CHECK (status IN ('waiting', 'sent', 'skipped', 'failed', 'unknown')),
  -- 7.C.3: a reason exactly with skipped and failed (an unknown may keep the channel's), none with
  -- waiting or sent; the shape only — the message reasons are each channel's (BC18).
  CONSTRAINT chk_broadcast_recipients_reason CHECK (
    (reason IS NULL OR reason ~ '^[a-z][a-z_]{0,29}$')
    AND (status NOT IN ('skipped', 'failed') OR reason IS NOT NULL)
    AND (status NOT IN ('waiting', 'sent') OR reason IS NULL)
  ),
  CONSTRAINT chk_broadcast_recipients_sent_at CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT chk_broadcast_recipients_version_number CHECK (version_number IS NULL OR version_number BETWEEN 1 AND 3),
  CONSTRAINT chk_broadcast_recipients_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
-- Once per person per broadcast (BC16) — also the broadcast key's cascade.
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast_contact ON app.broadcast_recipients USING btree (organization_id, broadcast_id, contact_id);
--> statement-breakpoint
-- The end duty and the numbers (R47).
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast_status ON app.broadcast_recipients USING btree (organization_id, broadcast_id, status);
--> statement-breakpoint
-- The contact key, her erasure and pause, her reply.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_contact ON app.broadcast_recipients USING btree (organization_id, contact_id);
--> statement-breakpoint
-- The 90-day clean-up (WC-53, R50).
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_created_at ON app.broadcast_recipients USING btree (created_at);
--> statement-breakpoint
ALTER TABLE app.broadcast_recipients OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.broadcast_recipients TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.broadcast_recipients_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.broadcast_recipients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.broadcast_recipients FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS broadcast_recipients_tenant_isolation ON app.broadcast_recipients;
--> statement-breakpoint
CREATE POLICY broadcast_recipients_tenant_isolation ON app.broadcast_recipients
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
