-- Migration: app_member_organization_counts
-- Created: 2026-11-24T22:16:25.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R34 (routes-final.md § 11.A.1 UN5, § 11.A.3,
-- § 11.A.11 UNC4; the plan's `app_member_workspace_counts`, full names, P72): the organization chooser's
-- counts (`GET /users/me/organizations`, route 132). The chooser lists organizations across tenants in
-- the caller's USER context, where the organization-scoped FORCE RLS of `app.*` and `tenancy.memberships`
-- shows no other member's rows. One narrow SECURITY DEFINER reader, the same form as
-- `tenancy.user_has_active_membership_for_organization`: it answers only for the given organizations
-- where that user has an ACTIVE membership, so it never counts an organization the caller is not in.
--
--   app.list_organization_counts_for_user(user_public_id, organization_public_ids)
--     organization_public_id
--     members_count            active, not removed memberships
--     channel_accounts_count   channel accounts not revoked
--     live_automations_count   automations live and not deleted
--
-- Called once per page through the tenancy counts port the app implements (UN1). A new app migration
-- (the seven launch files stay as they are). No table, index or policy change: the existing
-- organization-led indexes (`idx_memberships_organization_*`, `idx_channel_accounts_organization_channel`,
-- `idx_automations_organization_id_channel_account_id`) serve the counts. EXECUTE for the two runtime
-- roles only (the role-taxonomy policy: every SECURITY DEFINER function, never PUBLIC).

CREATE OR REPLACE FUNCTION app.list_organization_counts_for_user (
  user_public_id_param TEXT,
  organization_public_ids_param TEXT[]
) RETURNS TABLE (
  organization_public_id TEXT,
  members_count INTEGER,
  channel_accounts_count INTEGER,
  live_automations_count INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, tenancy, auth, public
AS $$
  WITH member_organizations AS (
    SELECT organization_row.id, organization_row.public_id
    FROM tenancy.organizations AS organization_row
    INNER JOIN tenancy.memberships AS membership_row
      ON membership_row.organization_id = organization_row.id
     AND membership_row.status = 'active'
     AND membership_row.deleted_at IS NULL
    INNER JOIN auth.users AS user_row
      ON user_row.id = membership_row.user_id
     AND user_row.public_id = user_public_id_param
     AND user_row.deleted_at IS NULL
    WHERE organization_row.public_id = ANY (organization_public_ids_param)
      AND organization_row.deleted_at IS NULL
  )
  SELECT
    member_organizations.public_id::text AS organization_public_id,
    (
      SELECT count(*)::int FROM tenancy.memberships AS counted_membership
      WHERE counted_membership.organization_id = member_organizations.id
        AND counted_membership.status = 'active'
        AND counted_membership.deleted_at IS NULL
    ) AS members_count,
    (
      SELECT count(*)::int FROM app.channel_accounts AS counted_account
      WHERE counted_account.organization_id = member_organizations.id
        AND counted_account.connection_status <> 'revoked'
    ) AS channel_accounts_count,
    (
      SELECT count(*)::int FROM app.automations AS counted_automation
      WHERE counted_automation.organization_id = member_organizations.id
        AND counted_automation.status = 'live'
        AND counted_automation.deleted_at IS NULL
    ) AS live_automations_count
  FROM member_organizations;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.list_organization_counts_for_user (TEXT, TEXT[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.list_organization_counts_for_user (TEXT, TEXT[]) TO meepzo_be_app, meepzo_be_maintenance;
