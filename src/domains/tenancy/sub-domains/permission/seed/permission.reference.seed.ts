/**
 * Tenancy permission seed — system permission codes.
 * Domain-owned; used by scripts/seed orchestration.
 *
 * Codes must match domain permission constants (e.g. tenancy.permissions.ts,
 * billing.permissions.ts) and docs/routes.txt — routes enforce these exact strings.
 */
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { permissions } from '@/domains/tenancy/sub-domains/permission/permission.schema.js';

/**
 * Canonical list of system permission codes seeded into `tenancy.permissions`.
 * Codes must match the per-domain permission constants (e.g.
 * {@link TENANCY_PERMISSIONS}, `BILLING_PERMISSIONS`) and `docs/routes.txt`,
 * since route guards compare against these exact strings.
 */
export const SYSTEM_PERMISSIONS = [
  // Tenancy
  { code: 'organization:read', name: 'View Organization', category: 'tenancy' },
  { code: 'organization:update', name: 'Update Organization', category: 'tenancy' },
  { code: 'organization:delete', name: 'Delete Organization', category: 'tenancy' },
  // The team (launch T8): the Users row of the Roles matrix.
  { code: 'membership:read', name: 'View Members', category: 'users' },
  { code: 'membership:create', name: 'Create Members', category: 'users' },
  { code: 'membership:update', name: 'Update Members', category: 'users' },
  { code: 'membership:delete', name: 'Delete Members', category: 'users' },
  { code: 'role:read', name: 'View Roles', category: 'users' },
  { code: 'role:create', name: 'Create Roles', category: 'users' },
  { code: 'role:update', name: 'Update Roles', category: 'users' },
  { code: 'role:delete', name: 'Delete Roles', category: 'users' },
  { code: 'api-key:read', name: 'View API Keys', category: 'tenancy' },
  { code: 'api-key:manage', name: 'Manage API Keys', category: 'tenancy' },
  {
    code: 'notification-policy:read',
    name: 'View Notification Policies',
    category: 'tenancy',
  },
  {
    code: 'notification-policy:manage',
    name: 'Manage Notification Policies',
    category: 'tenancy',
  },
  // Billing
  { code: 'subscription:read', name: 'View Subscription', category: 'billing' },
  { code: 'subscription:manage', name: 'Manage Subscription', category: 'billing' },
  // Notify
  { code: 'webhook:read', name: 'View Webhooks', category: 'notify' },
  { code: 'webhook:manage', name: 'Manage Webhooks', category: 'notify' },
  // Audit
  { code: 'audit-log:read', name: 'View Audit Logs', category: 'audit' },
  // Upload
  { code: 'upload:manage', name: 'Manage Uploads', category: 'upload' },
  // App (APP_PERMISSIONS, launch IA2): the Instagram, Automations and Contacts rows of the Roles matrix.
  { code: 'channel-account:read', name: 'View Channel Accounts', category: 'instagram' },
  { code: 'channel-account:manage', name: 'Manage Channel Accounts', category: 'instagram' },
  { code: 'instagram-account:read', name: 'View Instagram Account', category: 'instagram' },
  { code: 'instagram-account:manage', name: 'Manage Instagram Account', category: 'instagram' },
  {
    code: 'instagram-webhook-event:read',
    name: 'View Instagram Webhook Events',
    category: 'instagram',
  },
  { code: 'automation:read', name: 'View Automations', category: 'automations' },
  { code: 'automation:create', name: 'Create Automations', category: 'automations' },
  { code: 'automation:update', name: 'Update Automations', category: 'automations' },
  { code: 'automation:delete', name: 'Delete Automations', category: 'automations' },
  { code: 'contact:read', name: 'View Contacts', category: 'contacts' },
  // feat-instagram-dm-sending P20 (TN2): a contact's note, tags and pause.
  { code: 'contact:update', name: 'Update Contacts', category: 'contacts' },
  { code: 'contact:delete', name: 'Delete Contacts', category: 'contacts' },
] as const;

/**
 * Idempotently inserts the system permission catalog into
 * `tenancy.permissions`. `ON CONFLICT DO NOTHING` makes the seed safe to
 * re-run; callers may pass a custom code list for tests, otherwise
 * {@link SYSTEM_PERMISSIONS} is used.
 */
export async function seedPermissions(
  codes: Array<{
    code: string;
    name: string;
    category: string;
    description?: string;
  }> = [...SYSTEM_PERMISSIONS],
) {
  return getRequestDatabase().insert(permissions).values(codes).onConflictDoNothing().returning();
}
