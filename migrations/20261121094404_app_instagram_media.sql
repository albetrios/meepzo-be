-- Migration: app_instagram_media
-- Created: 2026-11-21T09:44:04.255Z
-- Reference: docs/reference/data/migrations.md
-- migration-safety: allow create_index_without_concurrently reason="a new empty table created in this file"
--
-- launch-2026-11-20-ujai, ROUTE R5 (routes-final.md § 1.3, 1.C.3 — IA17, IQ4, IAC15): the stored
-- posts of an Instagram account, in the `app` schema R1 created (20261121050908_app_schema.sql),
-- beside the account R3 created (20261121064529_app_instagram_account.sql).
--
--   app.instagram_media   a post or reel an automation ran on — one row per organization and
--                         Instagram media id, owned by one Instagram account. Written only through
--                         InstagramMediaService.upsertFromInstagram (sub-domain 4's event
--                         processing, sub-domain 3's "next post" link); routes 5–6 read Instagram
--                         live and never write it. Kept until the organization is deleted (D8) or
--                         Meta's data deletion erases the account's posts (IA20, IQ4). No public id:
--                         a post is addressed by its Instagram media id. `owner_username` (the drop's)
--                         is dropped — it is the account's own username (IA17).
--
-- A new, empty table: the keys, CHECKs and indexes are created with it, inside this file's
-- transaction — nothing to lock against, nothing to validate. It references the account through the
-- composite key (organization_id, channel_account_id) -> app.channel_accounts (organization_id,
-- id) ON DELETE RESTRICT (R8 below), so a post can never name another organization's account (B2-5, named
-- `<table>_<parent>_fk` as R3 names its children's keys). The drop's (organization_id,
-- published_at DESC) index is not created: no list reads it (1.C.3); the account's posts by date
-- lead with the composite key instead.
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R8 (routes-final § 2.C.3 — IA17, IAC10; P29: this
-- launch `app` migration changed in place): the post names its channel account — `channel_account_id`
-- (P47, was `instagram_account_id`) with the composite key -> app.channel_accounts (organization_id,
-- id) ON DELETE RESTRICT (2.3); the missed-comment watch (`comments_checked_at`,
-- `comments_next_check_at` — empty = not watched — `last_comment_at`) and a Live's end
-- (`live_ended_at`, D40); `media_product_type` adds `live` (Meta's Live value, lowered — a Meta test
-- names it, plan §43); and `idx_instagram_media_comments_next_check`, the watch's due read across
-- organizations through the maintenance arm.
--
-- Row-level security: ENABLE + FORCE, one `instagram_media_tenant_isolation` policy FOR ALL — USING
-- the organization arm plus the retention sweep arm bound to the maintenance role (1.3: on accounts,
-- settings and media), WITH CHECK the organization arm only.

CREATE TABLE IF NOT EXISTS app.instagram_media (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL,
  channel_account_id BIGINT NOT NULL,
  instagram_media_id VARCHAR(64) NOT NULL,
  shortcode VARCHAR(64),
  media_type VARCHAR(20),
  media_product_type VARCHAR(20),
  caption TEXT,
  media_url TEXT,
  thumbnail_url TEXT,
  permalink TEXT,
  published_at TIMESTAMPTZ NOT NULL,
  comments_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  is_comment_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  graph_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  comments_checked_at TIMESTAMPTZ,
  comments_next_check_at TIMESTAMPTZ,
  last_comment_at TIMESTAMPTZ,
  live_ended_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instagram_media_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES tenancy.organizations (id) ON DELETE CASCADE,
  CONSTRAINT instagram_media_channel_account_fk FOREIGN KEY (organization_id, channel_account_id) REFERENCES app.channel_accounts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_instagram_media_instagram_media_id CHECK (instagram_media_id ~ '^[0-9]{1,64}$'),
  CONSTRAINT chk_instagram_media_media_type CHECK (media_type IN ('image', 'video', 'carousel_album')),
  CONSTRAINT chk_instagram_media_media_product_type CHECK (media_product_type IN ('feed', 'reels', 'story', 'ad', 'live')),
  CONSTRAINT chk_instagram_media_counts CHECK (comments_count >= 0 AND like_count >= 0),
  CONSTRAINT chk_instagram_media_graph_data_object CHECK (jsonb_typeof(graph_data) = 'object'),
  CONSTRAINT chk_instagram_media_updated CHECK (updated_at >= created_at)
);
--> statement-breakpoint
-- One row per Instagram media id per organization — the upsert's key (the drop's unique index).
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_media_organization_media ON app.instagram_media USING btree (organization_id, instagram_media_id);
--> statement-breakpoint
-- The composite key's index, and the account's posts by date (Meta's data deletion erases them, IA20).
CREATE INDEX IF NOT EXISTS idx_instagram_media_organization_account_published ON app.instagram_media USING btree (organization_id, channel_account_id, published_at DESC);
--> statement-breakpoint
-- The missed-comment watch's due posts, read across organizations (the maintenance arm, § 2.C.3).
CREATE INDEX IF NOT EXISTS idx_instagram_media_comments_next_check ON app.instagram_media USING btree (comments_next_check_at) WHERE comments_next_check_at IS NOT NULL;
--> statement-breakpoint
ALTER TABLE app.instagram_media OWNER TO meepzo_be_owner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.instagram_media TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE app.instagram_media_id_seq TO meepzo_be_app, meepzo_be_maintenance;
--> statement-breakpoint
ALTER TABLE app.instagram_media ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.instagram_media FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS instagram_media_tenant_isolation ON app.instagram_media;
--> statement-breakpoint
CREATE POLICY instagram_media_tenant_isolation ON app.instagram_media
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
