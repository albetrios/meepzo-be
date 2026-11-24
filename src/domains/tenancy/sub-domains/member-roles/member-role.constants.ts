import { CHIP_TONE } from '@/shared/constants/record-fields.constants.js';

/** Chip tone a new role starts with. */
export const ROLE_DEFAULT_TONE = CHIP_TONE.SKY;

/**
 * Name of the Admin system role every TEAM organization is provisioned with (launch D8, D40): every
 * code Owner holds but deleting the organization. The role a former owner moves to when ownership
 * is handed over and the request names no other.
 */
export const ADMIN_ROLE_NAME = 'Admin';

/**
 * Name of the Editor system role every TEAM organization holds (feat-instagram-dm-sending TN1, D55):
 * locked like Admin, it makes and runs automations and keeps contacts tidy. It is the launch's
 * Member role renamed — the same row, its public id, people and codes kept
 * ({@link FORMER_EDITOR_ROLE_NAME}). An organization whose own custom role already carried this
 * name keeps that role as "Editor (custom)" (launch IQ5).
 */
export const EDITOR_ROLE_NAME = 'Editor';

/**
 * The name the Editor role had before feat-instagram-dm-sending (the launch's locked Member role,
 * launch D2, D3): the migration `tenancy_roles_editor_viewer` and the default-role reconcile rename
 * a system role of this name to {@link EDITOR_ROLE_NAME}.
 */
export const FORMER_EDITOR_ROLE_NAME = 'Member';

/**
 * Name of the Viewer system role every TEAM organization holds (feat-instagram-dm-sending TN1,
 * D55): locked, it reads the organization, its accounts, automations and contacts and changes
 * nothing.
 */
export const VIEWER_ROLE_NAME = 'Viewer';

/**
 * Whether an organization may make its own roles (feat-instagram-dm-sending TN3, plan:L7884) —
 * a product switch, not an environment-varying flag (P4), so a code constant.
 *
 * @remarks
 * While false: creating, editing, deleting and restoring a role and replacing its codes answer
 * `403 custom_roles_off` (after the permission gate), and a membership's `role_ids` must name
 * exactly one system role. Reads stay. A member who already holds a custom role keeps it until an
 * Admin changes it. The custom-role code stays: another product may switch it on.
 */
export const TENANCY_CUSTOM_ROLES_ENABLED: boolean = false;
