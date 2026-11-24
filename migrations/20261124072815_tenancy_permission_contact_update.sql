-- Migration: tenancy_permission_contact_update
-- Created: 2026-11-24T07:28:15.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R28 (routes-final.md § 9.1 TN2, § 9.11 TNC1;
-- decision P20): the one new code `contact:update` — a contact's note, tags and pause.
--
--   tenancy.permissions        + the catalog row (the permission catalog seed writes the same row;
--                                ON CONFLICT keeps whichever came first).
--   tenancy.role_permissions   + `contact:update` for the live system Owner, Admin and Editor (still
--                                named Member until `tenancy_roles_editor_viewer` runs next) of every
--                                live TEAM organization.
--
-- Idempotent: both inserts are ON CONFLICT DO NOTHING. Runs before `tenancy_roles_editor_viewer`,
-- which renames Member to Editor. The default-role reconcile (`reconcileDefaultTeamRoles`, every
-- deploy after the migrations) grants the same code from `DEFAULT_TEAM_ROLES`, so a team the previous
-- release creates while this applies gets it at the next deploy.
--
-- The grant reads and writes FORCE RLS tables, so each sits between NO FORCE and FORCE ROW LEVEL
-- SECURITY (lint rule force_rls_data_migration_without_owner_bracket).

ALTER TABLE tenancy.permissions NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.organizations NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.role_permissions NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO tenancy.permissions (code, name, category)
VALUES ('contact:update', 'Update Contacts', 'contacts')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
INSERT INTO tenancy.role_permissions (role_id, permission_code)
SELECT roles.id, 'contact:update'
FROM tenancy.roles AS roles
JOIN tenancy.organizations AS organizations ON organizations.id = roles.organization_id
WHERE organizations.type = 'TEAM'
  AND organizations.deleted_at IS NULL
  AND roles.deleted_at IS NULL
  AND roles.is_system
  AND roles.name IN ('Owner', 'Admin', 'Member', 'Editor')
ON CONFLICT (role_id, permission_code) DO NOTHING;
--> statement-breakpoint
ALTER TABLE tenancy.permissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.roles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.role_permissions FORCE ROW LEVEL SECURITY;
