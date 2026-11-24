-- Migration: user_settings_reduce_motion
-- Created: 2026-11-24T22:16:24.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R34 (routes-final.md § 11.A.1 UN4, § 11.A.11 UNC3):
-- the person's reduce-motion choice, next to `is_dark_mode_enabled` (the plan's `reduce_motion` in the
-- P21 form). NOT NULL with a constant default — metadata-only on PostgreSQL 11+, no rewrite. The
-- owner-only FORCE RLS policy of `auth.user_settings` is unchanged.

ALTER TABLE auth.user_settings
  ADD COLUMN IF NOT EXISTS is_reduce_motion_enabled BOOLEAN NOT NULL DEFAULT false;
