-- Migration: app_broadcast_audience_built
-- Created: 2026-11-25T20:31:17.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R46 (routes-final § 7.A.10, § 7.C BCC9; WC-40;
-- P217): the "audience built" mark the end duty reads (7.A.10 — "the end duty never ends a
-- `sending` broadcast before its audience job is done"). The `broadcast-audience` task sets it in
-- the commit of its last piece; the end duty (WC-29, ROUTE R47) ends a `sending` broadcast only
-- once it is set and nobody waits.
--
--   audience_built_at   when the last piece of the audience build committed; empty until then
--                       (and for a draft, a scheduled one, a "when her chat opens" one)
--
-- One nullable column and one CHECK (added NOT VALID, then validated): the mark only once the
-- broadcast started. No index: the end duty reads `idx_broadcasts_to_settle` and filters the mark.

ALTER TABLE app.broadcasts ADD COLUMN IF NOT EXISTS audience_built_at TIMESTAMPTZ;
--> statement-breakpoint
ALTER TABLE app.broadcasts DROP CONSTRAINT IF EXISTS chk_broadcasts_audience_built;
--> statement-breakpoint
ALTER TABLE app.broadcasts ADD CONSTRAINT chk_broadcasts_audience_built CHECK (audience_built_at IS NULL OR started_at IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE app.broadcasts VALIDATE CONSTRAINT chk_broadcasts_audience_built;
