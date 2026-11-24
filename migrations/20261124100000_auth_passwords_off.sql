-- Migration: auth_passwords_off
-- Created: 2026-11-24T10:00:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R30 (routes-final.md § 10.1 AT1, § 10.11 ATC1;
-- decision P84): passwords are off everywhere. The four password routes and every password code
-- path are removed in the same change; this migration empties the stored credentials.
--
--   auth.users          password_hash → NULL on every row (the column stays, nullable and empty —
--                       dropping it is a later clean-up with the user domain).
--   auth.auth_methods   every live PASSWORD row revoked (revoked_at = the migration time).
--
-- Idempotent: both updates only touch rows not yet in the after-state. The data migration reads and
-- writes FORCE RLS tables, so each sits between NO FORCE and FORCE ROW LEVEL SECURITY (lint rule
-- force_rls_data_migration_without_owner_bracket).

ALTER TABLE auth.users NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE auth.auth_methods NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE auth.users
SET password_hash = NULL
WHERE password_hash IS NOT NULL;
--> statement-breakpoint
UPDATE auth.auth_methods
SET revoked_at = now()
WHERE method_type = 'PASSWORD'
  AND revoked_at IS NULL;
--> statement-breakpoint
ALTER TABLE auth.auth_methods FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE auth.users FORCE ROW LEVEL SECURITY;
