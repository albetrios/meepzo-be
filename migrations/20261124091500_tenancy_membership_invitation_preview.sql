-- Migration: tenancy_membership_invitation_preview
-- Created: 2026-11-24T09:15:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- feat-instagram-dm-sending-2026-11-23-oxak, ROUTE R29 (routes-final.md § 9.C.1 TN11, § 9.C.11 TNC7):
-- the invitation page's preview (`POST /tenancy/membership-invitations/{membership_invitation_id}/preview`,
-- PUBLIC). The caller holds no organization context, so the read goes through one SECURITY DEFINER
-- resolver that answers only when the SHA-256 of the emailed token matches the row:
--
--   tenancy.resolve_membership_invitation_preview(public_id, token_hash)
--     state                 valid · accepted · expired · revoked — accepted wins; a revoked
--                           invitation, or one whose invited membership has ended (declined,
--                           removed, the invite left past its expiry), reads revoked; a pending
--                           one past expires_at reads expired
--     organization_name, organization_logo_color, role_name (the membership's main role),
--     inviter_first_name (auth.users, NULL when the inviter is gone), expires_at,
--     invitee_email          for the signed-in email match only — the route never returns it
--
-- A wrong token, an unknown id or a deleted organization returns no row (the route's 404). The
-- accept path's `resolve_membership_invitation_lookup_by_public_id` keeps its signature.
-- No table, column, index or policy changes: the unique `idx_membership_invitations_token` and
-- `idx_membership_invitations_public_id` serve the lookup.

CREATE OR REPLACE FUNCTION tenancy.resolve_membership_invitation_preview (
  invitation_public_id_param TEXT,
  token_hash_param TEXT
) RETURNS TABLE (
  state TEXT,
  organization_name TEXT,
  organization_logo_color TEXT,
  role_name TEXT,
  inviter_first_name TEXT,
  expires_at TIMESTAMPTZ,
  invitee_email TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, public
AS $$
  SELECT
    CASE
      WHEN invitation_row.accepted_at IS NOT NULL THEN 'accepted'
      WHEN invitation_row.revoked_at IS NOT NULL OR membership_row.deleted_at IS NOT NULL THEN 'revoked'
      WHEN invitation_row.expires_at <= now() THEN 'expired'
      ELSE 'valid'
    END AS state,
    organization_row.name::text AS organization_name,
    organization_row.logo_color::text AS organization_logo_color,
    role_row.name::text AS role_name,
    inviter_row.first_name::text AS inviter_first_name,
    invitation_row.expires_at AS expires_at,
    invitation_row.email::text AS invitee_email
  FROM tenancy.membership_invitations AS invitation_row
  INNER JOIN tenancy.memberships AS membership_row ON membership_row.id = invitation_row.membership_id
  INNER JOIN tenancy.organizations AS organization_row ON organization_row.id = membership_row.organization_id
  INNER JOIN tenancy.roles AS role_row ON role_row.id = membership_row.role_id
  LEFT JOIN auth.users AS inviter_row
    ON inviter_row.id = invitation_row.invited_by_user_id
   AND inviter_row.deleted_at IS NULL
  WHERE invitation_row.public_id = invitation_public_id_param
    AND invitation_row.token_hash = token_hash_param
    AND organization_row.deleted_at IS NULL
  LIMIT 1;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION tenancy.resolve_membership_invitation_preview (TEXT, TEXT) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenancy.resolve_membership_invitation_preview (TEXT, TEXT) TO meepzo_be_app, meepzo_be_maintenance;
