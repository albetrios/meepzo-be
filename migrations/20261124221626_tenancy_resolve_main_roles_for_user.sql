-- Migration: tenancy_resolve_main_roles_for_user
-- Created: 2026-11-24T22:16:26.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R34 (routes-final.md § 11.A.1 UN5, § 11.A.11 UNC4):
-- the organization chooser answers each organization's `role` — the caller's MAIN role `{ id, name }`.
-- The chooser runs in the caller's USER context: `memberships_user_self_discovery` shows the caller's
-- own memberships there, but `tenancy.roles` is behind the organization-only tenant policy, so a plain
-- join reads no role. One narrow SECURITY DEFINER reader, the form of
-- `tenancy.resolve_membership_invitation_preview`: it answers only the caller's own ACTIVE memberships.
--
--   tenancy.resolve_main_roles_for_user(user_public_id, organization_ids)
--     organization_id, role_public_id, role_name
--
-- No table, index or policy change: `idx_memberships_user_status` and the roles primary key serve it.

CREATE OR REPLACE FUNCTION tenancy.resolve_main_roles_for_user (
  user_public_id_param TEXT,
  organization_ids_param BIGINT[]
) RETURNS TABLE (
  organization_id BIGINT,
  role_public_id TEXT,
  role_name TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, auth, public
AS $$
  SELECT
    membership_row.organization_id,
    role_row.public_id::text AS role_public_id,
    role_row.name::text AS role_name
  FROM tenancy.memberships AS membership_row
  INNER JOIN auth.users AS user_row
    ON user_row.id = membership_row.user_id
   AND user_row.public_id = user_public_id_param
   AND user_row.deleted_at IS NULL
  INNER JOIN tenancy.roles AS role_row ON role_row.id = membership_row.role_id
  WHERE membership_row.organization_id = ANY (organization_ids_param)
    AND membership_row.status = 'active'
    AND membership_row.deleted_at IS NULL;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION tenancy.resolve_main_roles_for_user (TEXT, BIGINT[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenancy.resolve_main_roles_for_user (TEXT, BIGINT[]) TO meepzo_be_app, meepzo_be_maintenance;
