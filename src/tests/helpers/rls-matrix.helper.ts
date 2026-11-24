import { sql as drizzleSql } from 'drizzle-orm';
import { withMaintenanceDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';
import { database } from '@/infrastructure/database/connection.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestWebhook } from '@/tests/factories/webhook.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import {
  createMembership,
  createRoleWithPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { uploads } from '@/domains/upload/upload.schema.js';
import { notifications } from '@/domains/notify/sub-domains/notification/notification.schema.js';
import { subscriptions } from '@/domains/billing/sub-domains/subscription/subscription.schema.js';
import { trial_accounts } from '@/domains/billing/sub-domains/subscription/trial-account.schema.js';
import { logs } from '@/domains/audit/audit.schema.js';
import { organization_settings } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.schema.js';
import { organization_notification_policies } from '@/domains/tenancy/sub-domains/organization/organization-notification-policy/organization-notification-policy.schema.js';
import { api_keys } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.schema.js';
import { membership_additional_roles } from '@/domains/tenancy/sub-domains/membership/membership-additional-roles/membership-additional-roles.schema.js';
import { user_settings } from '@/domains/user/sub-domains/user-settings/user-settings.schema.js';
import { user_data_exports } from '@/domains/user/sub-domains/user-data-export/user-data-export.schema.js';
import { user_bug_reports } from '@/domains/user/sub-domains/user-bug-report/user-bug-report.schema.js';
import { webauthn_credentials } from '@/domains/auth/sub-domains/auth-webauthn/webauthn-credential.schema.js';
import { trusted_devices } from '@/domains/auth/sub-domains/auth-trusted-device/auth-trusted-device.schema.js';
import { mfa_recovery_codes } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa-recovery-code.schema.js';
import { mfa_methods } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa-method.schema.js';
import { auth_methods } from '@/domains/auth/sub-domains/auth-method/auth-method.schema.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { channel_connections } from '@/domains/app/sub-domains/channel-connection/channel-connection.schema.js';
import { channel_connection_tokens } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.schema.js';
import { channel_connection_usages } from '@/domains/app/sub-domains/channel-connection/channel-connection-usage.schema.js';
import { instagram_account_settings } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.schema.js';
import { instagram_media } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.schema.js';
import { instagram_webhook_events } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import { automation_runs } from '@/domains/app/sub-domains/automation/automation-run/automation-run.schema.js';
import { automation_run_events } from '@/domains/app/sub-domains/automation/automation-run/automation-run-event.schema.js';
import { automation_comment_logs } from '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.schema.js';

import {
  EXPECTED_FORCE_RLS_TABLES,
  forceRlsTableKey as tableKey,
  type ForceRlsTableRef,
} from '@/infrastructure/database/utils/force-rls-tables.constants.js';
import {
  setLocalApplicationRole,
  setLocalMaintenanceRole,
} from '@/infrastructure/database/contexts/database-context-runtime.js';

export type { ForceRlsTableRef };
export { EXPECTED_FORCE_RLS_TABLES, tableKey };

export type RlsTenantFixture = {
  organizationAPublicId: string;
  organizationBPublicId: string;
  rowIdsByTable: Map<string, { organizationA: number; organizationB: number }>;
};

/**
 * User-scoped FORCE-RLS tables (audit #7) — isolated by `app.current_user_public_id` rather than
 * `app.current_organization_public_id`. Asserted for cross-user denial in the RLS matrix.
 */
export const USER_SCOPED_FORCE_RLS_TABLES: ForceRlsTableRef[] = [
  { schemaName: 'auth', tableName: 'users' },
  { schemaName: 'auth', tableName: 'auth_methods' },
  { schemaName: 'auth', tableName: 'user_settings' },
  { schemaName: 'auth', tableName: 'user_data_exports' },
  { schemaName: 'auth', tableName: 'user_bug_reports' },
  { schemaName: 'auth', tableName: 'webauthn_credentials' },
  { schemaName: 'auth', tableName: 'trusted_devices' },
  { schemaName: 'auth', tableName: 'mfa_recovery_codes' },
  { schemaName: 'auth', tableName: 'mfa_methods' },
];

/** Two-user fixture for asserting cross-user denial on the user-scoped FORCE-RLS tables. */
export type RlsUserFixture = {
  userAPublicId: string;
  userBPublicId: string;
  /** Internal ids and email of user A, for exercising the pre-session SECURITY DEFINER resolvers. */
  userAInternalId: number;
  userAEmail: string;
  /** OAuth credential linked to user A for the `resolve_auth_method_by_provider` resolver test. */
  oauthProvider: string;
  oauthProviderUserId: string;
  rowIdsByTable: Map<string, { userA: number; userB: number }>;
};

/** Tables excluded from generic UPDATE/DELETE matrix (policy shape or parent FK setup). */
export const RLS_MATRIX_SKIP_CRUD_TABLES = new Set([
  tableKey({ schemaName: 'tenancy', tableName: 'organizations' }),
  tableKey({ schemaName: 'tenancy', tableName: 'membership_invitations' }),
  tableKey({ schemaName: 'tenancy', tableName: 'role_permissions' }),
  tableKey({ schemaName: 'tenancy', tableName: 'organization_settings' }),
  // Composite key (membership_id, role_id), no `id` — cross-organization isolation is asserted
  // through the authz security suites.
  tableKey({ schemaName: 'tenancy', tableName: 'membership_additional_roles' }),
  tableKey({ schemaName: 'notify', tableName: 'webhook_delivery_attempts' }),
  tableKey({ schemaName: 'auth', tableName: 'verification_tokens' }),
  // sec-U3: audit.logs is append-only — REVOKE UPDATE causes UPDATE to throw
  // `permission denied` (instead of silently affecting 0 rows), and DELETE
  // outside the retention context silently affects 0 rows but the matrix's
  // SELECT-then-UPDATE-then-DELETE shape doesn't fit. The audit-append-only
  // dedicated test file (audit-append-only.security.test.ts) covers both
  // semantics precisely.
  tableKey({ schemaName: 'audit', tableName: 'logs' }),
  // audit.outbox has no generic tenant SELECT policy — reads require the `app.audit_outbox_drain`
  // GUC (drain worker) and writes are organization-scoped INSERT-only / drain-gated, so the generic organization CRUD
  // matrix does not fit. Its dedicated test (audit-outbox-insert-rls.security.test.ts) covers the
  // INSERT isolation precisely; FORCE/drift coverage comes from EXPECTED_FORCE_RLS_TABLES.
  tableKey({ schemaName: 'audit', tableName: 'outbox' }),
]);

export async function grantMeepzoBeAppRoleForTests(): Promise<void> {
  await database.execute(drizzleSql`GRANT meepzo_be_app TO CURRENT_USER`).catch(() => undefined);
}

/**
 * Lists every table with `FORCE ROW LEVEL SECURITY` enabled in the live database.
 *
 * @remarks
 * - **Algorithm:** reads `pg_class.relforcerowsecurity` joined to `pg_namespace`, including both
 *   ordinary tables (`relkind = 'r'`) and partitioned parents (`relkind = 'p'`) so partitioned
 *   tables such as `audit.logs` / `notify.notifications` are represented by their parent.
 * - **Failure modes:** none beyond a DB connection error; returns `[]` when nothing is forced.
 * - **Side effects:** none — read-only catalog query.
 * - **Notes:** partition children (`relispartition = true`) are excluded because the parent already
 *   represents the policy; including them would surface every child as `extra` drift.
 */
export async function listForceRlsTablesFromDatabase(): Promise<ForceRlsTableRef[]> {
  const result = await database.execute<{ schema_name: string; table_name: string }>(drizzleSql`
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    INNER JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND c.relispartition = false
      AND c.relforcerowsecurity = true
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, c.relname
  `);
  const rows = Array.isArray(result)
    ? (result as { schema_name: string; table_name: string }[])
    : ((result as { rows?: { schema_name: string; table_name: string }[] }).rows ?? []);
  return rows.map((row) => ({ schemaName: row.schema_name, tableName: row.table_name }));
}

export async function isForceRlsEnabled(schemaName: string, tableName: string): Promise<boolean> {
  const result = await database.execute<{ relforcerowsecurity: boolean }>(drizzleSql`
    SELECT c.relforcerowsecurity
    FROM pg_class c
    INNER JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schemaName} AND c.relname = ${tableName}
  `);
  const rows = Array.isArray(result)
    ? (result as { relforcerowsecurity: boolean }[])
    : ((result as { rows?: { relforcerowsecurity: boolean }[] }).rows ?? []);
  return rows[0]?.relforcerowsecurity === true;
}

export async function executeAsMeepzoBeAppTenant<T>(
  organizationPublicId: string | null,
  callback: (transaction: typeof database) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await setLocalApplicationRole(transaction);
    const tenantValue = organizationPublicId ?? '';
    await transaction.execute(
      drizzleSql`SELECT set_config('app.current_organization_public_id', ${tenantValue}, true)`,
    );
    return callback(transaction as unknown as typeof database);
  });
}

async function queryCountInTransaction(
  transaction: typeof database,
  schemaName: string,
  tableName: string,
): Promise<number> {
  const qualified = `"${schemaName}"."${tableName}"`;
  const result = await transaction.execute<{ count: number }>(
    drizzleSql.raw(`SELECT count(*)::int AS count FROM ${qualified}`),
  );
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: { count: number }[] }).rows ?? []);
  return Number(rows[0]?.count ?? 0);
}

export async function countRowsAsTenant(
  schemaName: string,
  tableName: string,
  organizationPublicId: string | null,
): Promise<number> {
  return executeAsMeepzoBeAppTenant(organizationPublicId, async (transaction) =>
    queryCountInTransaction(transaction, schemaName, tableName),
  );
}

/**
 * Runs `callback` as the least-privilege `meepzo_be_app` role with `app.current_user_public_id` set, so
 * user-scoped FORCE-RLS policies (audit #7) are exercised exactly as they are in production under a
 * non-superuser connection.
 */
export async function executeAsMeepzoBeAppUser<T>(
  userPublicId: string | null,
  callback: (transaction: typeof database) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await setLocalApplicationRole(transaction);
    await transaction.execute(
      drizzleSql`SELECT set_config('app.current_user_public_id', ${userPublicId ?? ''}, true)`,
    );
    return callback(transaction as unknown as typeof database);
  });
}

/** Counts rows in a user-scoped table under the supplied `app.current_user_public_id` context. */
export async function countRowsAsUser(
  schemaName: string,
  tableName: string,
  userPublicId: string | null,
): Promise<number> {
  return executeAsMeepzoBeAppUser(userPublicId, async (transaction) =>
    queryCountInTransaction(transaction, schemaName, tableName),
  );
}

/**
 * Runs `callback` with `app.global_admin = 'true'` as `meepzo_be_maintenance` — exactly what
 * production's {@link withMaintenanceDatabaseContext} global-admin scope does on the maintenance
 * pool, the only role the escape hatch admits. Used to prove the cross-user admin branch of the
 * `auth.users` / `auth.auth_methods` policies (audit #7) under an RLS-subject connection.
 */
export async function executeAsGlobalAdmin<T>(
  callback: (transaction: typeof database) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await setLocalMaintenanceRole(transaction);
    await transaction.execute(drizzleSql`SELECT set_config('app.global_admin', 'true', true)`);
    return callback(transaction as unknown as typeof database);
  });
}

/** Counts rows in a table under the `app.global_admin = 'true'` admin escape hatch. */
export async function countRowsAsGlobalAdmin(
  schemaName: string,
  tableName: string,
): Promise<number> {
  return executeAsGlobalAdmin(async (transaction) =>
    queryCountInTransaction(transaction, schemaName, tableName),
  );
}

/**
 * The column a no-op cross-tenant UPDATE writes: `id`, except on a table where the application role
 * may update only some columns (`notify.notifications`: its read state).
 */
const NO_OP_UPDATE_COLUMN: Readonly<Record<string, string>> = {
  'notify.notifications': 'read_at',
};

export async function updateRowAsTenant(
  schemaName: string,
  tableName: string,
  rowId: number,
  organizationPublicId: string,
): Promise<number> {
  const qualified = `"${schemaName}"."${tableName}"`;
  const column = NO_OP_UPDATE_COLUMN[`${schemaName}.${tableName}`] ?? 'id';
  return executeAsMeepzoBeAppTenant(organizationPublicId, async (transaction) => {
    const result = await transaction.execute(
      drizzleSql.raw(
        `UPDATE ${qualified} SET "${column}" = "${column}" WHERE id = ${rowId} RETURNING id`,
      ),
    );
    // RETURNING makes an accidental cross-tenant mutation directly observable.
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    return rows.length;
  });
}

export async function deleteRowAsTenant(
  schemaName: string,
  tableName: string,
  rowId: number,
  organizationPublicId: string,
): Promise<number> {
  const qualified = `"${schemaName}"."${tableName}"`;
  return executeAsMeepzoBeAppTenant(organizationPublicId, async (transaction) => {
    const result = await transaction.execute(
      drizzleSql.raw(`DELETE FROM ${qualified} WHERE id = ${rowId} RETURNING id`),
    );
    // RETURNING makes an accidental cross-tenant mutation directly observable.
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    return rows.length;
  });
}

export async function seedRlsMatrixFixtures(): Promise<RlsTenantFixture> {
  const ownerA = await createTestUser();
  const ownerB = await createTestUser();
  const organizationA = await createTestOrganization({ ownerUserId: ownerA.id });
  const organizationB = await createTestOrganization({ ownerUserId: ownerB.id });
  const plan = await createTestPlan();
  const periodStart = new Date();
  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const roleA = await createRoleWithPermissions({
    organizationId: organizationA.id,
    permissionCodes: [],
    createdByUserId: ownerA.id,
  });
  const roleB = await createRoleWithPermissions({
    organizationId: organizationB.id,
    permissionCodes: [],
    createdByUserId: ownerB.id,
  });
  const membershipA = await createMembership({
    userId: ownerA.id,
    organizationId: organizationA.id,
    roleId: roleA.id,
  });
  const membershipB = await createMembership({
    userId: ownerB.id,
    organizationId: organizationB.id,
    roleId: roleB.id,
  });

  const rowIdsByTable = new Map<string, { organizationA: number; organizationB: number }>();

  rowIdsByTable.set(tableKey({ schemaName: 'tenancy', tableName: 'organizations' }), {
    organizationA: organizationA.id,
    organizationB: organizationB.id,
  });
  rowIdsByTable.set(tableKey({ schemaName: 'tenancy', tableName: 'memberships' }), {
    organizationA: membershipA.id,
    organizationB: membershipB.id,
  });
  rowIdsByTable.set(tableKey({ schemaName: 'tenancy', tableName: 'roles' }), {
    organizationA: roleA.id,
    organizationB: roleB.id,
  });

  await database.insert(organization_settings).values({ organization_id: organizationA.id });
  await database.insert(organization_settings).values({ organization_id: organizationB.id });

  const [policyA] = await database
    .insert(organization_notification_policies)
    .values({
      public_id: generatePublicId('organization'),
      organization_id: organizationA.id,
      notification_type: 'billing.usage_threshold',
      channel: 'EMAIL',
    })
    .returning();
  const [policyB] = await database
    .insert(organization_notification_policies)
    .values({
      public_id: generatePublicId('organization'),
      organization_id: organizationB.id,
      notification_type: 'billing.usage_threshold',
      channel: 'EMAIL',
    })
    .returning();
  rowIdsByTable.set(
    tableKey({ schemaName: 'tenancy', tableName: 'organization_notification_policies' }),
    {
      organizationA: policyA!.id,
      organizationB: policyB!.id,
    },
  );

  const [apiKeyA] = await database
    .insert(api_keys)
    .values({
      public_id: generatePublicId('organization'),
      organization_id: organizationA.id,
      name: 'key-a',
      key_hash: 'hash-a',
      key_prefix: 'prefix-a',
      created_by_user_id: ownerA.id,
    })
    .returning();
  const [apiKeyB] = await database
    .insert(api_keys)
    .values({
      public_id: generatePublicId('organization'),
      organization_id: organizationB.id,
      name: 'key-b',
      key_hash: 'hash-b',
      key_prefix: 'prefix-b',
      created_by_user_id: ownerB.id,
    })
    .returning();
  rowIdsByTable.set(tableKey({ schemaName: 'tenancy', tableName: 'api_keys' }), {
    organizationA: apiKeyA!.id,
    organizationB: apiKeyB!.id,
  });

  await database.insert(membership_additional_roles).values([
    {
      membership_id: membershipA.id,
      role_id: roleA.id,
      organization_id: organizationA.id,
      position: 1,
    },
    {
      membership_id: membershipB.id,
      role_id: roleB.id,
      organization_id: organizationB.id,
      position: 1,
    },
  ]);

  const webhookA = await createTestWebhook({ organizationId: organizationA.id });
  const webhookB = await createTestWebhook({ organizationId: organizationB.id });
  rowIdsByTable.set(tableKey({ schemaName: 'notify', tableName: 'webhooks' }), {
    organizationA: webhookA.id,
    organizationB: webhookB.id,
  });

  const [notificationA] = await database
    .insert(notifications)
    .values({
      public_id: generatePublicId('organization'),
      organization_id: organizationA.id,
      user_id: ownerA.id,
      type: 'TEST',
      title: 'A',
      message: 'body',
    })
    .returning();
  const [notificationB] = await database
    .insert(notifications)
    .values({
      public_id: generatePublicId('organization'),
      organization_id: organizationB.id,
      user_id: ownerB.id,
      type: 'TEST',
      title: 'B',
      message: 'body',
    })
    .returning();
  rowIdsByTable.set(tableKey({ schemaName: 'notify', tableName: 'notifications' }), {
    organizationA: notificationA!.id,
    organizationB: notificationB!.id,
  });

  const [subscriptionA] = await database
    .insert(subscriptions)
    .values({
      public_id: generatePublicId('organization'),
      organization_id: organizationA.id,
      plan_id: plan.id,
      billing_cycle: 'MONTHLY',
      status: 'ACTIVE',
      current_period_start: periodStart,
      current_period_end: periodEnd,
    })
    .returning();
  const [subscriptionB] = await database
    .insert(subscriptions)
    .values({
      public_id: generatePublicId('organization'),
      organization_id: organizationB.id,
      plan_id: plan.id,
      billing_cycle: 'MONTHLY',
      status: 'ACTIVE',
      current_period_start: periodStart,
      current_period_end: periodEnd,
    })
    .returning();
  rowIdsByTable.set(tableKey({ schemaName: 'billing', tableName: 'subscriptions' }), {
    organizationA: subscriptionA!.id,
    organizationB: subscriptionB!.id,
  });

  // feat-instagram-dm-sending R24 (BL7): one trial account row per organization.
  const [trialAccountA] = await database
    .insert(trial_accounts)
    .values({
      public_id: generatePublicId('trialAccount'),
      organization_id: organizationA.id,
      instagram_user_id: '17841400000000771',
      plan_id: plan.id,
      subscription_id: subscriptionA!.id,
    })
    .returning();
  const [trialAccountB] = await database
    .insert(trial_accounts)
    .values({
      public_id: generatePublicId('trialAccount'),
      organization_id: organizationB.id,
      instagram_user_id: '17841400000000772',
      plan_id: plan.id,
      subscription_id: subscriptionB!.id,
    })
    .returning();
  rowIdsByTable.set(tableKey({ schemaName: 'billing', tableName: 'trial_accounts' }), {
    organizationA: trialAccountA!.id,
    organizationB: trialAccountB!.id,
  });

  const [auditA] = await database
    .insert(logs)
    .values({
      public_id: generatePublicId('auditLog'),
      organization_id: organizationA.id,
      actor_user_id: ownerA.id,
      action: 'test.action',
      resource_type: 'organization',
    })
    .returning();
  const [auditB] = await database
    .insert(logs)
    .values({
      public_id: generatePublicId('auditLog'),
      organization_id: organizationB.id,
      actor_user_id: ownerB.id,
      action: 'test.action',
      resource_type: 'organization',
    })
    .returning();
  rowIdsByTable.set(tableKey({ schemaName: 'audit', tableName: 'logs' }), {
    organizationA: auditA!.id,
    organizationB: auditB!.id,
  });

  const [uploadA] = await database
    .insert(uploads)
    .values({
      public_id: generatePublicId('organization'),
      user_id: ownerA.id,
      organization_id: organizationA.id,
      file_name: 'a.png',
      file_key: 'org-a/a.png',
      mime_type: 'image/png',
      file_size: 100,
      storage_provider: 's3',
      bucket: 'test',
      status: 'PENDING',
    })
    .returning();
  const [uploadB] = await database
    .insert(uploads)
    .values({
      public_id: generatePublicId('organization'),
      user_id: ownerB.id,
      organization_id: organizationB.id,
      file_name: 'b.png',
      file_key: 'org-b/b.png',
      mime_type: 'image/png',
      file_size: 100,
      storage_provider: 's3',
      bucket: 'test',
      status: 'PENDING',
    })
    .returning();
  rowIdsByTable.set(tableKey({ schemaName: 'upload', tableName: 'uploads' }), {
    organizationA: uploadA!.id,
    organizationB: uploadB!.id,
  });

  // The channel connection (feat-instagram-dm-sending R3): one connection per organization with its
  // token (ciphertext placeholder — never decrypted here) and one usage reading; then the Instagram
  // account sub-domain (launch R3, R5, R12): one connected account per organization through that
  // connection, its default settings, a stored post and a received webhook event.
  const channelConnectionIds = { organizationA: 0, organizationB: 0 };
  const channelConnectionTokenIds = { organizationA: 0, organizationB: 0 };
  const channelConnectionUsageIds = { organizationA: 0, organizationB: 0 };
  const channelAccountIds = { organizationA: 0, organizationB: 0 };
  const instagramAccountIds = { organizationA: 0, organizationB: 0 };
  const instagramSettingsIds = { organizationA: 0, organizationB: 0 };
  const instagramMediaIds = { organizationA: 0, organizationB: 0 };
  const instagramWebhookEventIds = { organizationA: 0, organizationB: 0 };
  for (const [side, organization] of [
    ['organizationA', organizationA],
    ['organizationB', organizationB],
  ] as const) {
    const instagramUserId = side === 'organizationA' ? '17841400000000001' : '17841400000000002';
    const [connection] = await database
      .insert(channel_connections)
      .values({
        public_id: generatePublicId('channelConnection'),
        organization_id: organization.id,
        client_business_id: side === 'organizationA' ? '5550000000001' : '5550000000002',
        config_id: '1234567890',
      })
      .returning();
    const [token] = await database
      .insert(channel_connection_tokens)
      .values({
        organization_id: organization.id,
        channel_connection_id: connection!.id,
        encrypted_access_token: `v1:rls-matrix-placeholder-${side}`,
      })
      .returning();
    const [usage] = await database
      .insert(channel_connection_usages)
      .values({
        organization_id: organization.id,
        channel_connection_id: connection!.id,
        asset_id: instagramUserId,
        usage_type: 'instagram',
        usage_percent: 10,
        read_at: new Date(),
      })
      .returning();
    // The channel account (R5) the Instagram account extends, 1:1.
    const [channelAccount] = await database
      .insert(channel_accounts)
      .values({
        public_id: generatePublicId('channelAccount'),
        organization_id: organization.id,
        channel_connection_id: connection!.id,
        provider_account_id: instagramUserId,
        display_name: `@rls_${side.toLowerCase()}`,
      })
      .returning();
    const [account] = await database
      .insert(instagram_accounts)
      .values({
        organization_id: organization.id,
        channel_account_id: channelAccount!.id,
        instagram_user_id: instagramUserId,
        username: `rls_${side.toLowerCase()}`,
      })
      .returning();
    const [settings] = await database
      .insert(instagram_account_settings)
      .values({ organization_id: organization.id, channel_account_id: channelAccount!.id })
      .returning();
    // One stored post (launch R5), owned by the account through the composite key.
    const [media] = await database
      .insert(instagram_media)
      .values({
        organization_id: organization.id,
        channel_account_id: channelAccount!.id,
        instagram_media_id: side === 'organizationA' ? '18030000000000001' : '18030000000000002',
        published_at: new Date(),
      })
      .returning();
    // One received comment event of the account (launch R12).
    const [webhookEvent] = await database
      .insert(instagram_webhook_events)
      .values({
        public_id: generatePublicId('instagramWebhookEvent'),
        organization_id: organization.id,
        instagram_account_id: account!.id,
        instagram_user_id: instagramUserId,
        contact_instagram_user_id: '17841400000000099',
        event_kind: 'comment',
        event_key: `comment:rls-matrix-${side}`,
        payload: { field: 'comments', value: { id: `rls-matrix-${side}`, text: 'Price?' } },
      })
      .returning();
    channelConnectionIds[side] = connection!.id;
    channelConnectionTokenIds[side] = token!.id;
    channelConnectionUsageIds[side] = usage!.id;
    channelAccountIds[side] = channelAccount!.id;
    instagramAccountIds[side] = account!.id;
    instagramSettingsIds[side] = settings!.id;
    instagramMediaIds[side] = media!.id;
    instagramWebhookEventIds[side] = webhookEvent!.id;
  }
  rowIdsByTable.set(
    tableKey({ schemaName: 'app', tableName: 'channel_accounts' }),
    channelAccountIds,
  );
  rowIdsByTable.set(
    tableKey({ schemaName: 'app', tableName: 'instagram_accounts' }),
    instagramAccountIds,
  );
  rowIdsByTable.set(
    tableKey({ schemaName: 'app', tableName: 'channel_connections' }),
    channelConnectionIds,
  );
  rowIdsByTable.set(
    tableKey({ schemaName: 'app', tableName: 'channel_connection_tokens' }),
    channelConnectionTokenIds,
  );
  rowIdsByTable.set(
    tableKey({ schemaName: 'app', tableName: 'channel_connection_usages' }),
    channelConnectionUsageIds,
  );
  rowIdsByTable.set(
    tableKey({ schemaName: 'app', tableName: 'instagram_account_settings' }),
    instagramSettingsIds,
  );
  rowIdsByTable.set(
    tableKey({ schemaName: 'app', tableName: 'instagram_media' }),
    instagramMediaIds,
  );
  rowIdsByTable.set(
    tableKey({ schemaName: 'app', tableName: 'instagram_webhook_events' }),
    instagramWebhookEventIds,
  );

  // The contact sub-domain (launch R8): one live contact of each organization's account.
  const contactIds = { organizationA: 0, organizationB: 0 };
  for (const [side, organization] of [
    ['organizationA', organizationA],
    ['organizationB', organizationB],
  ] as const) {
    const [contact] = await database
      .insert(contacts)
      .values({
        public_id: generatePublicId('contact'),
        organization_id: organization.id,
        instagram_account_id: instagramAccountIds[side],
        instagram_user_id: side === 'organizationA' ? '17841400000000101' : '17841400000000102',
        username: `rls_contact_${side.toLowerCase()}`,
        first_seen_at: new Date(),
        last_message_received_at: new Date(),
      })
      .returning();
    contactIds[side] = contact!.id;
  }
  rowIdsByTable.set(tableKey({ schemaName: 'app', tableName: 'contacts' }), contactIds);

  // The automation sub-domain (launch R9): one inactive comment automation of each organization's
  // account — the smallest complete flow (the opening message with its button, the final message).
  const automationIds = { organizationA: 0, organizationB: 0 };
  for (const [side, organization] of [
    ['organizationA', organizationA],
    ['organizationB', organizationB],
  ] as const) {
    const [automation] = await database
      .insert(automations)
      .values({
        public_id: generatePublicId('automation'),
        organization_id: organization.id,
        instagram_account_id: instagramAccountIds[side],
        name: `RLS matrix automation ${side}`,
        trigger_type: 'comment',
        opening_message: { text: 'Hi there', button_title: 'Send it' },
        final_message: { text: 'Here you go', links: [] },
      })
      .returning();
    automationIds[side] = automation!.id;
  }
  rowIdsByTable.set(tableKey({ schemaName: 'app', tableName: 'automations' }), automationIds);

  // The run engine (launch R10): one waiting run of each organization's automation for its
  // contact, its status event, and the comment log of the comment that started it.
  const runIds = { organizationA: 0, organizationB: 0 };
  const runEventIds = { organizationA: 0, organizationB: 0 };
  const commentLogIds = { organizationA: 0, organizationB: 0 };
  for (const [side, organization] of [
    ['organizationA', organizationA],
    ['organizationB', organizationB],
  ] as const) {
    const commentId = side === 'organizationA' ? '17950000000000001' : '17950000000000002';
    const mediaId = side === 'organizationA' ? '18030000000000001' : '18030000000000002';
    const [run] = await database
      .insert(automation_runs)
      .values({
        public_id: generatePublicId('automationRun'),
        organization_id: organization.id,
        automation_id: automationIds[side],
        contact_id: contactIds[side],
        trigger_type: 'comment',
        trigger_instagram_media_id: mediaId,
        trigger_instagram_comment_id: commentId,
        trigger_text: 'Price?',
        status: 'waiting',
        current_step: 'comment_reply',
        waiting_for: 'opening_message_button',
        waiting_since_at: new Date(),
        last_instagram_event_key: `comment:${commentId}`,
      })
      .returning();
    const [runEvent] = await database
      .insert(automation_run_events)
      .values({
        organization_id: organization.id,
        automation_run_id: run!.id,
        event_type: 'status_changed',
        status: 'waiting',
      })
      .returning();
    const [commentLog] = await database
      .insert(automation_comment_logs)
      .values({
        public_id: generatePublicId('automationCommentLog'),
        organization_id: organization.id,
        automation_id: automationIds[side],
        automation_name: `RLS matrix automation ${side}`,
        automation_run_id: run!.id,
        contact_id: contactIds[side],
        instagram_media_id: mediaId,
        instagram_comment_id: commentId,
        overall_status: 'waiting',
        waiting_for: 'opening_message_button',
      })
      .returning();
    runIds[side] = run!.id;
    runEventIds[side] = runEvent!.id;
    commentLogIds[side] = commentLog!.id;
  }
  rowIdsByTable.set(tableKey({ schemaName: 'app', tableName: 'automation_runs' }), runIds);
  rowIdsByTable.set(
    tableKey({ schemaName: 'app', tableName: 'automation_run_events' }),
    runEventIds,
  );
  rowIdsByTable.set(
    tableKey({ schemaName: 'app', tableName: 'automation_comment_logs' }),
    commentLogIds,
  );

  return {
    organizationAPublicId: organizationA.public_id,
    organizationBPublicId: organizationB.public_id,
    rowIdsByTable,
  };
}

/**
 * Seeds two users each owning one row in every user-scoped FORCE-RLS table (audit #7) so the matrix
 * can assert that user A — under `app.current_user_public_id = A` — sees its own row but zero of user B's.
 *
 * @remarks
 * - **Algorithm:** insert via the superuser `database` handle (RLS-exempt) so seeding is independent
 *   of the policies under test; record both row ids per table keyed by `<schema>.<table>`.
 * - **Failure modes:** none beyond DB errors; relies on {@link createTestUser} for valid users.
 * - **Side effects:** writes one row per user-scoped table for each of the two users.
 */
export async function seedUserScopedRlsFixtures(): Promise<RlsUserFixture> {
  const userA = await createTestUser();
  const userB = await createTestUser();
  const rowIdsByTable = new Map<string, { userA: number; userB: number }>();

  // auth.users: the two seeded user rows are themselves the isolation subjects (audit #7). Keyed by
  // public_id in the owner policy, but recorded by internal id so the generic matrix can probe by id.
  rowIdsByTable.set(tableKey({ schemaName: 'auth', tableName: 'users' }), {
    userA: userA.id,
    userB: userB.id,
  });

  const oauthProvider = 'google';
  const oauthProviderUserId = `rls-google-${userA.id}`;
  const [authMethodA] = await database
    .insert(auth_methods)
    .values({
      public_id: generatePublicId('organization'),
      user_id: userA.id,
      method_type: 'OAUTH',
      provider: oauthProvider,
      provider_user_id: oauthProviderUserId,
      is_primary: true,
    })
    .returning();
  const [authMethodB] = await database
    .insert(auth_methods)
    .values({
      public_id: generatePublicId('organization'),
      user_id: userB.id,
      method_type: 'EMAIL_CODE',
      is_primary: true,
    })
    .returning();
  rowIdsByTable.set(tableKey({ schemaName: 'auth', tableName: 'auth_methods' }), {
    userA: authMethodA!.id,
    userB: authMethodB!.id,
  });

  await database.insert(user_settings).values({ user_id: userA.id });
  await database.insert(user_settings).values({ user_id: userB.id });
  // user_settings PK is user_id, so isolation is keyed by the user row id itself.
  rowIdsByTable.set(tableKey({ schemaName: 'auth', tableName: 'user_settings' }), {
    userA: userA.id,
    userB: userB.id,
  });

  const [exportA] = await database
    .insert(user_data_exports)
    .values({ public_id: generatePublicId('organization'), user_id: userA.id, status: 'pending' })
    .returning();
  const [exportB] = await database
    .insert(user_data_exports)
    .values({ public_id: generatePublicId('organization'), user_id: userB.id, status: 'pending' })
    .returning();
  rowIdsByTable.set(tableKey({ schemaName: 'auth', tableName: 'user_data_exports' }), {
    userA: exportA!.id,
    userB: exportB!.id,
  });

  const bugReportRow = (user: { id: number }) => ({
    public_id: generatePublicId('userBugReport'),
    user_id: user.id,
    reporter_email: `${generatePublicId('user')}@example.com`,
    description: 'The page froze',
    input_method: 'typed',
  });
  const [bugReportA] = await database
    .insert(user_bug_reports)
    .values(bugReportRow(userA))
    .returning();
  const [bugReportB] = await database
    .insert(user_bug_reports)
    .values(bugReportRow(userB))
    .returning();
  rowIdsByTable.set(tableKey({ schemaName: 'auth', tableName: 'user_bug_reports' }), {
    userA: bugReportA!.id,
    userB: bugReportB!.id,
  });

  const [credentialA] = await database
    .insert(webauthn_credentials)
    .values({
      public_id: generatePublicId('webauthnCredential'),
      user_id: userA.id,
      credential_id: generatePublicId('organization'),
      public_key: 'key-a',
    })
    .returning();
  const [credentialB] = await database
    .insert(webauthn_credentials)
    .values({
      public_id: generatePublicId('webauthnCredential'),
      user_id: userB.id,
      credential_id: generatePublicId('organization'),
      public_key: 'key-b',
    })
    .returning();
  rowIdsByTable.set(tableKey({ schemaName: 'auth', tableName: 'webauthn_credentials' }), {
    userA: credentialA!.id,
    userB: credentialB!.id,
  });

  const trustedDeviceRow = (user: { id: number }) => ({
    public_id: generatePublicId('trustedDevice'),
    user_id: user.id,
    token_hash: generatePublicId('trustedDevice').padEnd(64, '0'),
    expires_at: new Date(Date.now() + 86_400_000),
  });
  const [trustedDeviceA] = await database
    .insert(trusted_devices)
    .values(trustedDeviceRow(userA))
    .returning();
  const [trustedDeviceB] = await database
    .insert(trusted_devices)
    .values(trustedDeviceRow(userB))
    .returning();
  rowIdsByTable.set(tableKey({ schemaName: 'auth', tableName: 'trusted_devices' }), {
    userA: trustedDeviceA!.id,
    userB: trustedDeviceB!.id,
  });

  const [recoveryA] = await database
    .insert(mfa_recovery_codes)
    .values({ user_id: userA.id, code_hash: 'hash-a' })
    .returning();
  const [recoveryB] = await database
    .insert(mfa_recovery_codes)
    .values({ user_id: userB.id, code_hash: 'hash-b' })
    .returning();
  rowIdsByTable.set(tableKey({ schemaName: 'auth', tableName: 'mfa_recovery_codes' }), {
    userA: recoveryA!.id,
    userB: recoveryB!.id,
  });

  const [methodA] = await database
    .insert(mfa_methods)
    .values({ public_id: generatePublicId('organization'), user_id: userA.id, method_type: 'TOTP' })
    .returning();
  const [methodB] = await database
    .insert(mfa_methods)
    .values({ public_id: generatePublicId('organization'), user_id: userB.id, method_type: 'TOTP' })
    .returning();
  rowIdsByTable.set(tableKey({ schemaName: 'auth', tableName: 'mfa_methods' }), {
    userA: methodA!.id,
    userB: methodB!.id,
  });

  return {
    userAPublicId: userA.public_id,
    userBPublicId: userB.public_id,
    userAInternalId: userA.id,
    userAEmail: userA.email,
    oauthProvider,
    oauthProviderUserId,
    rowIdsByTable,
  };
}
