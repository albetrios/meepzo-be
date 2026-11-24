/**
 * Organization-scoped permission codes of the `app` domain — every code the Instagram automation
 * launch uses (Instagram account, its webhook events, automations, contacts), checked by
 * `requireOrganizationPermission` preHandlers on the `/app/…` routes.
 *
 * @remarks
 * - The codes are seeded into `tenancy.permissions` (`SYSTEM_PERMISSIONS`, the Roles-matrix rows
 *   `instagram`, `automations` and `contacts`) and granted by provisioning and the default-role
 *   reconcile (`organization-provisioning.ts`): a TEAM organization's Owner and Admin hold every one;
 *   which of them the locked Editor and Viewer roles hold is `APP_PERMISSION_DEFAULT_TEAM_GRANTS`
 *   there (feat-instagram-dm-sending TN1) — a code added here does not compile until it says.
 *   A PERSONAL organization's Owner holds none — the surface is team-only.
 * - `contact:update` (feat-instagram-dm-sending P20, TN2): a contact's note, tags and pause.
 * - `channel-account:read` / `:manage` (feat-instagram-dm-sending P59, TN12): the shared channel
 *   connection and channel account routes — held by the roles that hold their `instagram-account:*`
 *   twins (Owner and Admin manage; Editor and Viewer read); Instagram's settings and media keep
 *   `instagram-account:*`.
 * - `instagram-webhook-event:read` is its own code: notify's `webhook:read` (outgoing webhooks)
 *   opens nothing here.
 */
export const APP_PERMISSIONS = {
  CHANNEL_ACCOUNT_READ: 'channel-account:read',
  CHANNEL_ACCOUNT_MANAGE: 'channel-account:manage',
  INSTAGRAM_ACCOUNT_READ: 'instagram-account:read',
  INSTAGRAM_ACCOUNT_MANAGE: 'instagram-account:manage',
  INSTAGRAM_WEBHOOK_EVENT_READ: 'instagram-webhook-event:read',
  AUTOMATION_READ: 'automation:read',
  AUTOMATION_CREATE: 'automation:create',
  AUTOMATION_UPDATE: 'automation:update',
  AUTOMATION_DELETE: 'automation:delete',
  CONTACT_READ: 'contact:read',
  CONTACT_UPDATE: 'contact:update',
  CONTACT_DELETE: 'contact:delete',
} as const;

/** One app permission code — a value of {@link APP_PERMISSIONS}. */
export type AppPermissionCode = (typeof APP_PERMISSIONS)[keyof typeof APP_PERMISSIONS];
