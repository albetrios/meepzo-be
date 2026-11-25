-- Migration: auth_users_onboarding_fields
-- Created: 2026-11-24T22:16:23.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R34 (routes-final.md § 11.A.1 UN3, § 11.A.11 UNC3):
-- onboarding's two profile fields on `auth.users`, both optional ("Skip for now"):
--
--   instagram_handle   varchar(30) — saved without `@`, lower case; letters, digits, `.` and `_`, 1–30
--                      (Instagram's rule). A profile note only: it connects nothing.
--   goal               varchar(20) — capture_leads · drive_sales · grow_community
--
-- Two nullable columns with no default — metadata-only, no rewrite. Every existing row is NULL, so the
-- checks are added NOT VALID and validated at once (a no-op scan). No index (the row is read by its
-- key); the owner-only FORCE RLS policy is unchanged.

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS instagram_handle VARCHAR(30);
--> statement-breakpoint

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS goal VARCHAR(20);
--> statement-breakpoint

ALTER TABLE auth.users
  ADD CONSTRAINT chk_users_instagram_handle
  CHECK (instagram_handle ~ '^[a-z0-9._]{1,30}$')
  NOT VALID;
--> statement-breakpoint

ALTER TABLE auth.users
  VALIDATE CONSTRAINT chk_users_instagram_handle;
--> statement-breakpoint

ALTER TABLE auth.users
  ADD CONSTRAINT chk_users_goal
  CHECK (goal IN ('capture_leads', 'drive_sales', 'grow_community'))
  NOT VALID;
--> statement-breakpoint

ALTER TABLE auth.users
  VALIDATE CONSTRAINT chk_users_goal;
