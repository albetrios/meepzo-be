-- Migration: tenancy_roles_editor_viewer
-- Created: 2026-11-24T07:28:16.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R28 (routes-final.md § 9.1 TN1, § 9.B.3,
-- § 9.11 TNC1; D55): every live TEAM organization holds the four locked system roles Owner, Admin,
-- Editor and Viewer.
--
--   tenancy.roles              a live custom role already named Editor or Viewer in an organization
--                              that needs the name becomes "Editor (custom)" / "Viewer (custom)"
--                              (launch IQ5 — id, people and codes kept; "(custom <n>)" when taken);
--                              the system Member becomes Editor (the same row: public id, people and
--                              grants kept; the new description); a Viewer row (is_system, is_locked,
--                              tone sky) is added where there is none.
--   tenancy.role_permissions   Editor + automation:delete, contact:update, upload:manage;
--                              Viewer + organization:read, instagram-account:read, automation:read,
--                              contact:read.
--
-- The same definitions live in `DEFAULT_TEAM_ROLES` (organization-provisioning.ts), which new teams
-- get at provisioning and existing ones get from the default-role reconcile on every deploy after the
-- migrations — including a team the previous release creates (with Member) while this applies.
-- Idempotent: each step only touches what is still missing. Runs after
-- `tenancy_permission_contact_update` (the Editor grant needs the catalog row).
--
-- The fill reads and writes FORCE RLS tables, so each sits between NO FORCE and FORCE ROW LEVEL
-- SECURITY (lint rule force_rls_data_migration_without_owner_bracket). A few rows per organization.

ALTER TABLE tenancy.organizations NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.role_permissions NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Free the names: a live custom role named Editor (where a system Member or no system Editor is
-- present) or Viewer (where no system Viewer is) moves to "<name> (custom)", or "(custom <n>)".
DO $$
DECLARE
  custom_role record;
  free_name text;
  counter integer;
BEGIN
  FOR custom_role IN
    SELECT roles.id, roles.organization_id, roles.name
    FROM tenancy.roles AS roles
    JOIN tenancy.organizations AS organizations ON organizations.id = roles.organization_id
    WHERE organizations.type = 'TEAM'
      AND organizations.deleted_at IS NULL
      AND roles.deleted_at IS NULL
      AND NOT roles.is_system
      AND roles.name IN ('Editor', 'Viewer')
      AND NOT EXISTS (
        SELECT 1 FROM tenancy.roles AS system_roles
        WHERE system_roles.organization_id = roles.organization_id
          AND system_roles.deleted_at IS NULL
          AND system_roles.is_system
          AND system_roles.name = roles.name
      )
  LOOP
    free_name := custom_role.name || ' (custom)';
    counter := 2;
    WHILE EXISTS (
      SELECT 1 FROM tenancy.roles
      WHERE organization_id = custom_role.organization_id
        AND deleted_at IS NULL
        AND name = free_name
    ) LOOP
      free_name := custom_role.name || ' (custom ' || counter || ')';
      counter := counter + 1;
    END LOOP;
    UPDATE tenancy.roles SET name = free_name, updated_at = now() WHERE id = custom_role.id;
  END LOOP;
END;
$$;
--> statement-breakpoint
-- Member becomes Editor: the same row.
UPDATE tenancy.roles AS roles
SET name = 'Editor',
    description = 'Makes and runs automations and keeps contacts tidy.',
    updated_at = now()
FROM tenancy.organizations AS organizations
WHERE organizations.id = roles.organization_id
  AND organizations.type = 'TEAM'
  AND organizations.deleted_at IS NULL
  AND roles.deleted_at IS NULL
  AND roles.is_system
  AND roles.name = 'Member'
  AND NOT EXISTS (
    SELECT 1 FROM tenancy.roles AS editor_roles
    WHERE editor_roles.organization_id = roles.organization_id
      AND editor_roles.deleted_at IS NULL
      AND editor_roles.name = 'Editor'
  );
--> statement-breakpoint
INSERT INTO tenancy.role_permissions (role_id, permission_code)
SELECT roles.id, codes.code
FROM tenancy.roles AS roles
JOIN tenancy.organizations AS organizations ON organizations.id = roles.organization_id
CROSS JOIN (VALUES ('automation:delete'), ('contact:update'), ('upload:manage')) AS codes (code)
WHERE organizations.type = 'TEAM'
  AND organizations.deleted_at IS NULL
  AND roles.deleted_at IS NULL
  AND roles.is_system
  AND roles.name = 'Editor'
ON CONFLICT (role_id, permission_code) DO NOTHING;
--> statement-breakpoint
-- Viewer where there is none; sorted beside the other system roles (the Admin row's created_at).
INSERT INTO tenancy.roles (public_id, organization_id, name, description, tone, is_system, is_locked, created_at, updated_at)
SELECT
  'rol_' || (
    SELECT string_agg(substr('0123456789abcdefghijklmnopqrstuvwxyz', 1 + floor(random() * 36)::integer, 1), '')
    FROM generate_series(1, 21 + 0 * organizations.id)
  ),
  organizations.id,
  'Viewer',
  'Sees automations, contacts and the Instagram account; changes nothing.',
  'sky',
  true,
  true,
  COALESCE(
    (
      SELECT min(admin_roles.created_at) FROM tenancy.roles AS admin_roles
      WHERE admin_roles.organization_id = organizations.id
        AND admin_roles.deleted_at IS NULL
        AND admin_roles.is_system
        AND admin_roles.name = 'Admin'
    ),
    now()
  ),
  now()
FROM tenancy.organizations AS organizations
WHERE organizations.type = 'TEAM'
  AND organizations.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM tenancy.roles AS viewer_roles
    WHERE viewer_roles.organization_id = organizations.id
      AND viewer_roles.deleted_at IS NULL
      AND viewer_roles.name = 'Viewer'
  );
--> statement-breakpoint
INSERT INTO tenancy.role_permissions (role_id, permission_code)
SELECT roles.id, codes.code
FROM tenancy.roles AS roles
JOIN tenancy.organizations AS organizations ON organizations.id = roles.organization_id
CROSS JOIN (
  VALUES ('organization:read'), ('instagram-account:read'), ('automation:read'), ('contact:read')
) AS codes (code)
WHERE organizations.type = 'TEAM'
  AND organizations.deleted_at IS NULL
  AND roles.deleted_at IS NULL
  AND roles.is_system
  AND roles.name = 'Viewer'
ON CONFLICT (role_id, permission_code) DO NOTHING;
--> statement-breakpoint
ALTER TABLE tenancy.organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.roles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.role_permissions FORCE ROW LEVEL SECURITY;
