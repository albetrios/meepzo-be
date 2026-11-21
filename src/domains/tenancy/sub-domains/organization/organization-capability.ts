import { NotFoundError, UnprocessableEntityError } from '@/shared/errors/index.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';

/** `tenancy.organizations.status` of an organization in use — anything else is suspended or archived. */
export const ACTIVE_ORGANIZATION_STATUS = 'ACTIVE';

/**
 * The codes the owner of a suspended or archived organization keeps — enough to read it and to
 * reactivate it (`PATCH /tenancy/organization` with `status`), nothing else (B2-3).
 *
 * @remarks
 * Every other member of such an organization resolves no permission at all and cannot switch into
 * it; its API keys are refused. The owner can still switch in, so the organization is never locked out
 * for good.
 */
export const INACTIVE_ORGANIZATION_OWNER_PERMISSION_CODES: readonly string[] = [
  TENANCY_PERMISSIONS.ORGANIZATION_READ,
  TENANCY_PERMISSIONS.ORGANIZATION_UPDATE,
];

/**
 * A team-only capability a caller may attempt to exercise on an organization.
 * Selects the matching i18n rejection key in {@link assertTeamOrganization} when
 * the target is a PERSONAL organization.
 *
 * - `MEMBERS` — add or invite a second member (collaboration).
 * - `ROLES` — create or manage custom member roles.
 * - `MUTATION` — owner-level structural change (delete or transfer ownership).
 * - `BILLING` — manage the organization subscription (create / change plan / cancel / resume).
 * - `INSTAGRAM` — Instagram automation: every signed-in write of the `app` domain's sub-domains 1–4
 *   (Instagram account, contacts, automations, Instagram webhook) — connect, change the settings and
 *   disconnect the Instagram account, delete a contact, create / update / delete an automation. Their
 *   team-only reads use {@link assertTeamOrganizationForRead} instead (a read is never a 422).
 */
export type OrganizationCapability = 'MEMBERS' | 'ROLES' | 'MUTATION' | 'BILLING' | 'INSTAGRAM';

/** Organization `type` for a single-owner account workspace (no collaboration). */
const PERSONAL_ORGANIZATION_TYPE = 'PERSONAL';

/** Maps an attempted {@link OrganizationCapability} to its PERSONAL-organization rejection key. */
const CAPABILITY_REJECTION_KEY: Record<OrganizationCapability, string> = {
  MEMBERS: 'errors:personalOrganizationNoMembers',
  ROLES: 'errors:personalOrganizationNoRoles',
  MUTATION: 'errors:personalOrganizationImmutable',
  BILLING: 'errors:personalOrganizationNoBilling',
  INSTAGRAM: 'errors:personalOrganizationNoInstagram',
};

/**
 * Whether `organization` is a single-owner PERSONAL workspace (no collaboration) — the
 * test {@link assertTeamOrganization} applies, and {@link assertTeamOrganizationForRead} for a read
 * that refuses a personal workspace with a status of its own (a GET is never a 422 — the
 * response-code policy keeps 422 for writes).
 */
export function isPersonalOrganization(organization: { type: string }): boolean {
  return organization.type === PERSONAL_ORGANIZATION_TYPE;
}

/**
 * Guards a team-only read: rejects with 404 and reason `team_organization_required` when
 * `organization` is a PERSONAL organization, otherwise returns without effect.
 *
 * @param organization - The caller's active organization (only `type` is read).
 * @throws NotFoundError When the organization is PERSONAL — `404 not_found` with
 *   `reason: 'team_organization_required'` (detail: "Team organization not found").
 *
 * @remarks
 * - **Algorithm:** if {@link isPersonalOrganization}, throw `NotFoundError('Team organization')`
 *   tagged `.withReason('team_organization_required')`; otherwise no-op.
 * - **Failure modes:** PERSONAL organization ⇒ 404 `not_found`, reason `team_organization_required`.
 *   A read never answers 422 (the response-code policy keeps 422 for writes), so the read side of a
 *   team-only surface answers 404, while its writes go through {@link assertTeamOrganization} → 422.
 * - **Side effects:** none (pure guard; throws or returns).
 * - **Notes:** used by the team-only reads of the `app` domain's sub-domains 1–4 (Instagram
 *   account, contacts, automations, Instagram webhook events), whose writes use
 *   {@link assertTeamOrganization} with the `INSTAGRAM` capability. It is the second line: a personal
 *   organization's Owner never holds the `app` codes, so the permission gate answers
 *   `403 missing_permission` first. Clients branch on `error.reason`, never on the detail.
 */
export function assertTeamOrganizationForRead({
  organization,
}: {
  organization: { type: string };
}): void {
  if (isPersonalOrganization(organization)) {
    throw new NotFoundError('Team organization').withReason('team_organization_required');
  }
}

/**
 * Guards a team-only capability: rejects with 422 when `organization` is a
 * PERSONAL organization, otherwise returns without effect.
 *
 * @param organization - The target organization (only `type` is read).
 * @param capability - The capability being attempted; selects the i18n key.
 * @throws UnprocessableEntityError When the organization is PERSONAL — the organization
 *   `type` is immutable, so retrying the identical request can never succeed
 *   (422 `unprocessable_entity`, not 409).
 *
 * @remarks
 * - **Algorithm:** if `type === 'PERSONAL'`, throw `UnprocessableEntityError`
 *   keyed by {@link CAPABILITY_REJECTION_KEY}; otherwise no-op.
 * - **Failure modes:** PERSONAL organization ⇒ 422 `unprocessable_entity`.
 * - **Side effects:** none (pure guard; throws or returns).
 * - **Notes:** single point of enforcement for the personal-vs-team rule, shared by
 *   membership-invitation, membership (add member / transfer ownership), member-role,
 *   organization delete, subscription billing (create / change-plan / cancel /
 *   resume), and the `app` domain's writes in sub-domains 1–4 (`INSTAGRAM`; their reads use
 *   {@link assertTeamOrganizationForRead} → 404). Team-only affordances are NOT
 *   advertised on the API response; a client derives them from the organization `type`
 *   and gates the action itself on the caller's permissions (e.g. `subscription:manage`).
 */
export function assertTeamOrganization({
  organization,
  capability,
}: {
  organization: { type: string };
  capability: OrganizationCapability;
}): void {
  if (isPersonalOrganization(organization)) {
    throw new UnprocessableEntityError(CAPABILITY_REJECTION_KEY[capability]);
  }
}
