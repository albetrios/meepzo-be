import { ForbiddenError } from '@/shared/errors/index.js';
import { TENANCY_CUSTOM_ROLES_ENABLED } from './member-role.constants.js';

/** The `error.reason` of every refusal while custom roles are off (feat-instagram-dm-sending TN3). */
export const CUSTOM_ROLES_OFF_REASON = 'custom_roles_off';

function customRolesOffError(): ForbiddenError {
  return new ForbiddenError('errors:customRolesOff').withReason(CUSTOM_ROLES_OFF_REASON);
}

/**
 * Refuses a role write — create, edit, delete, restore, replace its codes — while
 * {@link TENANCY_CUSTOM_ROLES_ENABLED} is false (feat-instagram-dm-sending TN3, routes 111–115).
 *
 * @remarks
 * Called first in each of the five service writes, so it answers after the route's permission gate
 * (a caller without the code still gets `403 missing_permission`) and before the service's own body checks and role
 * lookup. Throws `ForbiddenError` (`errors:customRolesOff`, reason `custom_roles_off`).
 */
export function assertCustomRolesEnabled(): void {
  if (!TENANCY_CUSTOM_ROLES_ENABLED) throw customRolesOffError();
}

/**
 * Refuses a membership's `role_ids` that name more than one role, or a role that is not a system
 * role, while {@link TENANCY_CUSTOM_ROLES_ENABLED} is false (feat-instagram-dm-sending TN3, P82).
 *
 * @remarks
 * Runs on `POST` and `PATCH …/memberships` once `role_ids` resolved to live roles of the
 * organization (an unknown id stays a 400 on `role_ids`). Throws `ForbiddenError`
 * (`errors:customRolesOff`, reason `custom_roles_off`). Says nothing about the role a member holds
 * today: one who holds a custom role keeps it until an Admin changes it.
 */
export function assertMembershipRolesAllowed({
  roles,
}: {
  roles: ReadonlyArray<{ is_system: boolean }>;
}): void {
  if (TENANCY_CUSTOM_ROLES_ENABLED) return;
  if (roles.length > 1 || roles.some((role) => !role.is_system)) throw customRolesOffError();
}
