/**
 * Organization-scoped permission codes of the `app` domain — every code the Instagram automation
 * launch uses (Instagram account, its webhook events, automations, contacts), checked by
 * `requireOrganizationPermission` preHandlers on the `/app/…` routes.
 *
 * @remarks
 * - The codes are seeded into `tenancy.permissions` (`SYSTEM_PERMISSIONS`, the Roles-matrix rows
 *   `instagram`, `automations` and `contacts`) and granted by provisioning and the default-role
 *   reconcile (`organization-provisioning.ts`): a TEAM organization's Owner and Admin hold all nine,
 *   the locked Member role holds `instagram-account:read`, `automation:read` / `:create` /
 *   `:update` and `contact:read`. A PERSONAL organization's Owner holds none — the surface is
 *   team-only.
 * - `instagram-webhook-event:read` is its own code: notify's `webhook:read` (outgoing webhooks)
 *   opens nothing here.
 */
export const APP_PERMISSIONS = {
  INSTAGRAM_ACCOUNT_READ: 'instagram-account:read',
  INSTAGRAM_ACCOUNT_MANAGE: 'instagram-account:manage',
  INSTAGRAM_WEBHOOK_EVENT_READ: 'instagram-webhook-event:read',
  AUTOMATION_READ: 'automation:read',
  AUTOMATION_CREATE: 'automation:create',
  AUTOMATION_UPDATE: 'automation:update',
  AUTOMATION_DELETE: 'automation:delete',
  CONTACT_READ: 'contact:read',
  CONTACT_DELETE: 'contact:delete',
} as const;
