-- Migration: tenancy_permission_channel_account
-- Created: 2026-11-24T10:15:30.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R3 (routes-final.md § 9.1 TN12, § 9.11 TNC8;
-- decision P59): the two codes of the shared channel routes — `channel-account:read` (the
-- connections and accounts lists and reads) and `channel-account:manage` (connect, pick, reconnect,
-- disconnect). P59 calls it a rename; it is add-and-copy, because Instagram's settings and media keep
-- their `instagram-account:*` codes.
--
--   tenancy.permissions        + the two catalog rows (the permission catalog seed writes the same
--                                rows; ON CONFLICT keeps whichever came first).
--   tenancy.role_permissions   + each code for every live role of every organization that holds its
--                                `instagram-account:*` twin — Owner and Admin both, Editor and Viewer
--                                read (system roles; a custom role keeps the same reach).
--
-- Idempotent: both inserts are ON CONFLICT DO NOTHING. Runs after `tenancy_permission_contact_update`
-- and `tenancy_roles_editor_viewer`. The default-role reconcile (`reconcileDefaultTeamRoles`, every
-- deploy after the migrations) grants the same codes from `APP_PERMISSION_DEFAULT_TEAM_GRANTS`, so a
-- team the previous release creates while this applies gets them at the next deploy.
--
-- The grant reads and writes FORCE RLS tables, so each sits between NO FORCE and FORCE ROW LEVEL
-- SECURITY (lint rule force_rls_data_migration_without_owner_bracket).

ALTER TABLE tenancy.permissions NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.role_permissions NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO tenancy.permissions (code, name, category)
VALUES
  ('channel-account:read', 'View Channel Accounts', 'instagram'),
  ('channel-account:manage', 'Manage Channel Accounts', 'instagram')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
INSERT INTO tenancy.role_permissions (role_id, permission_code)
SELECT granted.role_id, replace(granted.permission_code, 'instagram-account:', 'channel-account:')
FROM tenancy.role_permissions AS granted
JOIN tenancy.roles AS roles ON roles.id = granted.role_id
WHERE roles.deleted_at IS NULL
  AND granted.permission_code IN ('instagram-account:read', 'instagram-account:manage')
ON CONFLICT (role_id, permission_code) DO NOTHING;
--> statement-breakpoint
ALTER TABLE tenancy.permissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.roles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.role_permissions FORCE ROW LEVEL SECURITY;
