import { describe, expect, it } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import {
  MAINTENANCE_CONTEXTS,
  SESSION_CONTEXTS,
} from '@/infrastructure/database/contexts/database-context.js';
import { EXPECTED_FORCE_RLS_TABLES } from '@/infrastructure/database/utils/force-rls-tables.constants.js';
import { DATABASE_MAINTENANCE_ROLE } from '@/shared/constants/project-identity.constants.js';

/**
 * Phase 8 — the table→required-scope map. For every FORCE-RLS table this pins
 * EXACTLY which `app.*` GUCs its live policies reference, i.e. which scope
 * patterns can ever grant access to it. A migration that adds, drops, or
 * retargets a policy arm must update this map deliberately — silent policy
 * weakening (a new bypass GUC on a tenant table) or dead arms (a GUC no code
 * sets) can no longer slip through.
 *
 * Sources of truth:
 * - the LIVE database (`pg_policies.qual` / `with_check`) — final post-migration
 *   state, robust to later migrations replacing earlier policies;
 * - the scope registries in `database-context.ts` — the only legal GUC universe.
 *
 * Every maintenance (bypass) GUC arm is also pinned to the maintenance role: the arm opens only
 * while `current_user` is the role `DATABASE_MAINTENANCE_URL` connects as
 * (migration 20261005170000_bind_bypass_arms_to_maintenance_role.sql).
 */
const RLS_TABLE_SCOPE_MAP: Record<string, readonly string[]> = {
  // Tables whose policies carry no app.* GUC (application-access or claim-based
  // system tables kept under FORCE RLS for the owner-role discipline).
  'audit.dead_letter_jobs': [],
  'auth.mail_outbox': [],
  'auth.verification_tokens': [],
  'billing.plans': [],
  'billing.stripe_subscription_tombstones': [],
  'billing.stripe_webhook_events': [],
  'tenancy.permissions': [],

  // The run engine's four tables: organization-scoped, plus the retention sweep arm in USING (the
  // 7-day wait scan, the open-key repair, the part upkeep — feat-instagram-dm-sending § 4.B.3).
  'app.automation_comment_logs': [
    'app.current_organization_public_id',
    'app.global_retention_cleanup',
  ],
  'app.automation_run_events': [
    'app.current_organization_public_id',
    'app.global_retention_cleanup',
  ],
  'app.automation_run_open_keys': [
    'app.current_organization_public_id',
    'app.global_retention_cleanup',
  ],
  'app.automation_runs': ['app.current_organization_public_id', 'app.global_retention_cleanup'],
  // Automations: organization-scoped, plus the retention sweep arm in USING (routes-final § 3.3).
  'app.automations': ['app.current_organization_public_id', 'app.global_retention_cleanup'],
  'app.automation_counts': ['app.current_organization_public_id'],
  'app.automation_reply_states': ['app.current_organization_public_id'],
  // Contacts: organization-scoped, plus the retention sweep arm in USING (routes-final § 2.3).
  'app.contacts': ['app.current_organization_public_id', 'app.global_retention_cleanup'],
  'app.contact_activities': ['app.current_organization_public_id'],
  'app.contact_tag_counts': ['app.current_organization_public_id'],
  // Tag events (3.B): the organization arm, plus the pick-up scan and the 8-day clean-up (CT17).
  'app.contact_tag_events': ['app.current_organization_public_id', 'app.global_retention_cleanup'],
  // The channel connection: organization-scoped, plus the token check's sweep (MC10). Its token and
  // usage: the organization arm only — no sweep arm reads a token (MC9).
  'app.channel_accounts': ['app.current_organization_public_id', 'app.global_retention_cleanup'],
  'app.channel_connection_tokens': ['app.current_organization_public_id'],
  'app.channel_connection_usages': ['app.current_organization_public_id'],
  'app.channel_connections': ['app.current_organization_public_id', 'app.global_retention_cleanup'],
  // The Instagram account and its settings: organization-scoped, plus the daily sweep's read
  // (IA8).
  'app.instagram_account_settings': [
    'app.current_organization_public_id',
    'app.global_retention_cleanup',
  ],
  'app.instagram_accounts': ['app.current_organization_public_id', 'app.global_retention_cleanup'],
  // The stored posts (launch R5): organization-scoped, plus the retention sweep arm (1.3).
  'app.instagram_media': ['app.current_organization_public_id', 'app.global_retention_cleanup'],
  // The Instagram webhook event keys (R16, WH20): organization-scoped (the store function), plus
  // the upkeep's oldest-part check (the sweep arm in USING only).
  'app.instagram_webhook_event_keys': [
    'app.current_organization_public_id',
    'app.global_retention_cleanup',
  ],
  // The Instagram webhook events: organization-scoped (route 18, the receiver's verified scope,
  // processing), plus the stuck-event pick-up's and the 30-day clean-up's sweep (WH3, WH19).
  'app.instagram_webhook_events': [
    'app.current_organization_public_id',
    'app.global_retention_cleanup',
  ],
  // The sending engine's tenant tables (feat-instagram-dm-sending § 6.A.3, R18): organization-scoped,
  // plus the repair duties' and clean-ups' cross-organization reads (the sweep arm in USING only).
  'app.instagram_send_day_counts': [
    'app.current_organization_public_id',
    'app.global_retention_cleanup',
  ],
  'app.instagram_send_lanes': [
    'app.current_organization_public_id',
    'app.global_retention_cleanup',
  ],
  'app.instagram_send_minute_counts': [
    'app.current_organization_public_id',
    'app.global_retention_cleanup',
  ],
  'app.instagram_send_stops': [
    'app.current_organization_public_id',
    'app.global_retention_cleanup',
  ],
  'app.message_month_counts': [
    'app.current_organization_public_id',
    'app.global_retention_cleanup',
  ],
  // The one tenantless sending row (P16): the maintenance arm only, in USING and WITH CHECK.
  'app.sending_states': ['app.sending_state_access'],
  'audit.logs': [
    'app.current_organization_public_id',
    'app.current_user_public_id',
    'app.global_admin',
    'app.global_retention_cleanup',
    'app.system_audit_insert',
  ],
  'audit.outbox': [
    'app.audit_outbox_drain',
    'app.current_organization_public_id',
    'app.system_audit_insert',
  ],
  'auth.auth_methods': ['app.current_user_public_id', 'app.global_admin'],
  'auth.mfa_methods': ['app.current_user_public_id'],
  'auth.mfa_recovery_codes': ['app.current_user_public_id'],
  'auth.sessions': [
    'app.current_session_public_id',
    'app.current_session_token_hash',
    'app.current_user_public_id',
    'app.session_retention_cleanup',
  ],
  'auth.trusted_devices': ['app.current_user_public_id', 'app.session_retention_cleanup'],
  'auth.user_bug_reports': ['app.current_user_public_id'],
  'auth.user_data_exports': ['app.current_user_public_id', 'app.global_retention_cleanup'],
  'auth.user_notification_preferences': ['app.current_user_public_id'],
  'auth.user_settings': ['app.current_user_public_id'],
  'auth.users': ['app.current_user_public_id', 'app.global_admin', 'app.global_retention_cleanup'],
  'auth.webauthn_credentials': ['app.current_user_public_id'],
  'billing.subscriptions': ['app.current_organization_public_id', 'app.global_retention_cleanup'],
  'billing.trial_accounts': ['app.current_organization_public_id'],
  'notify.notifications': [
    'app.current_organization_public_id',
    'app.current_user_public_id',
    'app.global_retention_cleanup',
  ],
  'notify.webhook_delivery_attempts': [
    'app.current_organization_public_id',
    'app.global_retention_cleanup',
  ],
  'notify.webhooks': ['app.current_organization_public_id', 'app.global_retention_cleanup'],
  'tenancy.api_keys': ['app.current_organization_public_id', 'app.global_retention_cleanup'],
  // A member's roles besides the main one (launch D5) — organization-scoped, no soft delete.
  'tenancy.membership_additional_roles': ['app.current_organization_public_id'],
  'tenancy.membership_invitations': [
    'app.current_organization_public_id',
    'app.global_retention_cleanup',
  ],
  'tenancy.memberships': [
    'app.current_organization_public_id',
    'app.current_user_public_id',
    'app.global_retention_cleanup',
  ],
  'tenancy.organization_notification_policies': [
    'app.current_organization_public_id',
    'app.global_retention_cleanup',
  ],
  'tenancy.organization_settings': [
    'app.current_organization_public_id',
    'app.global_retention_cleanup',
  ],
  'tenancy.organizations': [
    'app.current_organization_public_id',
    'app.current_user_public_id',
    'app.global_retention_cleanup',
  ],
  'tenancy.role_permissions': [
    'app.current_organization_public_id',
    'app.global_retention_cleanup',
  ],
  'tenancy.roles': ['app.current_organization_public_id', 'app.global_retention_cleanup'],
  'upload.uploads': [
    'app.current_organization_public_id',
    'app.current_user_public_id',
    'app.global_retention_cleanup',
  ],
};

/**
 * One bypass arm as `pg_policies` prints it once bound to the maintenance role — the shape the
 * binding migration writes and `maintenanceBypassArm` declares in the Drizzle schemas.
 */
function boundBypassArm(guc: string): string {
  return (
    `(( SELECT current_setting('${guc}'::text, true) AS current_setting) = 'true'::text) AND ` +
    `(( SELECT CURRENT_USER AS "current_user") = '${DATABASE_MAINTENANCE_ROLE}'::name)`
  );
}

/** Identity GUCs set by the principal pattern (`buildIdentityGucStatement`). */
const PRINCIPAL_GUCS = ['app.current_organization_public_id', 'app.current_user_public_id'];

/**
 * GUCs a policy arm references but NO code path sets — every entry here is a
 * dead arm scheduled for removal by a migration. Shrink-only; currently empty
 * (the app.current_session_refresh_token_hash arm was dropped by the
 * rls_policy_initplan_hygiene migration).
 */
const KNOWN_DEAD_POLICY_GUCS = new Set<string>([]);

/**
 * Policies whose WITH CHECK deliberately carries a bypass arm (`<schema>.<table> <policy>: <guc>`),
 * each with the write it exists for. Every one is bound to the maintenance role like any other
 * bypass arm (pinned above). A new entry needs the review audit H1 gave the tenant tables: name
 * the system write, and why it cannot run under a tenant or user context instead.
 */
const REVIEWED_WRITE_BYPASS_ARMS = new Map<string, string>([
  [
    'tenancy.organizations organizations_tenant_isolation: app.global_retention_cleanup',
    'the organization tombstone UPDATE (migration 20260827040000, fix 2)',
  ],
  [
    'upload.uploads uploads_tenant_isolation: app.global_retention_cleanup',
    'the pending-upload sweep UPDATEs status (migration 20260827030000)',
  ],
  [
    'auth.user_data_exports user_data_exports_owner_access: app.global_retention_cleanup',
    'the retention worker purges expired export rows across users',
  ],
  [
    'auth.sessions sessions_user_access: app.session_retention_cleanup',
    'the session retention worker revokes and purges sessions across users',
  ],
  ['auth.users users_self_or_admin_access: app.global_admin', 'platform admin user management'],
  [
    'auth.auth_methods auth_methods_self_or_admin_access: app.global_admin',
    'platform admin user management',
  ],
  [
    'app.sending_states sending_states_maintenance_access: app.sending_state_access',
    'the one tenantless sending row (P16): the environment id, settings versions and app usage',
  ],
  [
    'audit.outbox audit_outbox_drain_update: app.audit_outbox_drain',
    'the outbox drain marks rows delivered',
  ],
  [
    'audit.outbox audit_outbox_tenant_isolation_insert: app.system_audit_insert',
    'INSERT-only: tenantless system audit events',
  ],
  [
    'audit.logs audit_logs_tenant_isolation_insert: app.system_audit_insert',
    'INSERT-only: tenantless system audit events',
  ],
]);

describe('RLS table → required-scope map (Phase 8)', () => {
  it('live pg_policies GUC references match the map exactly, table by table', async () => {
    const rows = await database.execute<{ table_key: string; gucs: string | null }>(
      drizzleSql`
        SELECT x.schemaname || '.' || x.tablename AS table_key,
               string_agg(DISTINCT x.guc, ',' ORDER BY x.guc) AS gucs
        FROM (
          SELECT p.schemaname, p.tablename, m[1] AS guc
          FROM pg_policies p,
          LATERAL regexp_matches(
            COALESCE(p.qual, '') || ' ' || COALESCE(p.with_check, ''),
            'app\\.[a-z_]+',
            'g'
          ) m
        ) x
        GROUP BY x.schemaname, x.tablename
      `,
    );
    const resultRows = Array.isArray(rows)
      ? rows
      : ((rows as { rows?: { table_key: string; gucs: string | null }[] }).rows ?? []);
    const live = new Map(resultRows.map((row) => [row.table_key, row.gucs ?? '']));

    const actual: Record<string, readonly string[]> = {};
    for (const table of EXPECTED_FORCE_RLS_TABLES) {
      const key = `${table.schemaName}.${table.tableName}`;
      const gucs = live.get(key);
      actual[key] = gucs === undefined || gucs === '' ? [] : gucs.split(',');
    }

    expect(actual).toEqual(RLS_TABLE_SCOPE_MAP);
  });

  it('every bypass GUC arm also requires the maintenance role', async () => {
    const bypassGucs = Object.values(MAINTENANCE_CONTEXTS).flatMap((definition) =>
      definition.guc === null ? [] : [definition.guc],
    );
    const rows = await database.execute<{ policy: string; expression: string }>(
      drizzleSql`
        SELECT schemaname || '.' || tablename || ' ' || policyname AS policy,
               COALESCE(qual, '') || ' ' || COALESCE(with_check, '') AS expression
        FROM pg_policies
      `,
    );
    const resultRows = Array.isArray(rows)
      ? rows
      : ((rows as { rows?: { policy: string; expression: string }[] }).rows ?? []);

    let boundArmCount = 0;
    const unboundArms: string[] = [];
    for (const row of resultRows) {
      let remaining = row.expression;
      for (const guc of bypassGucs) {
        const parts = remaining.split(boundBypassArm(guc));
        boundArmCount += parts.length - 1;
        remaining = parts.join('');
      }
      for (const guc of bypassGucs) {
        if (remaining.includes(`'${guc}'`)) unboundArms.push(`${row.policy}: ${guc}`);
      }
    }

    expect(boundArmCount).toBeGreaterThan(0);
    expect(
      unboundArms,
      'A bypass arm that any role can open — bind it to the maintenance role the way ' +
        'migration 20261005170000 does (maintenanceBypassArm in the Drizzle schema).',
    ).toEqual([]);
  });

  it('no bypass GUC arm sits in a WITH CHECK, across every live policy', async () => {
    // USING decides which rows a process may find (and so read, update or delete); WITH CHECK
    // decides which rows it may write. A bypass arm in WITH CHECK lets a maintenance process
    // write a row under any tenant — the hole audit H1 closed table by table. The sample in
    // tenant-isolation-with-check-retention.security.test.ts proves the behaviour on five
    // tables; this pins the shape on every live policy, so a new write arm is a reviewed
    // decision rather than a copy-paste of a USING clause.
    const bypassGucs = Object.values(MAINTENANCE_CONTEXTS).flatMap((definition) =>
      definition.guc === null ? [] : [definition.guc],
    );
    const rows = await database.execute<{ policy: string; with_check: string }>(
      drizzleSql`
        SELECT schemaname || '.' || tablename || ' ' || policyname AS policy,
               COALESCE(with_check, '') AS with_check
        FROM pg_policies
      `,
    );
    const resultRows = Array.isArray(rows)
      ? rows
      : ((rows as { rows?: { policy: string; with_check: string }[] }).rows ?? []);

    const writeArms = resultRows.flatMap((row) =>
      bypassGucs
        .filter((guc) => row.with_check.includes(`'${guc}'`))
        .map((guc) => `${row.policy}: ${guc}`),
    );

    expect(
      writeArms.filter((arm) => !REVIEWED_WRITE_BYPASS_ARMS.has(arm)),
      'A bypass arm in WITH CHECK lets a maintenance process write under any tenant. Keep the ' +
        'bypass in USING only, or add the arm to REVIEWED_WRITE_BYPASS_ARMS with the write it is for.',
    ).toEqual([]);
    expect(
      [...REVIEWED_WRITE_BYPASS_ARMS.keys()].filter((arm) => !writeArms.includes(arm)),
      'A REVIEWED_WRITE_BYPASS_ARMS entry no live policy carries — drop it.',
    ).toEqual([]);
  });

  it('the map covers exactly the FORCE-RLS table set', () => {
    const expected = EXPECTED_FORCE_RLS_TABLES.map(
      (table) => `${table.schemaName}.${table.tableName}`,
    ).sort();
    expect(Object.keys(RLS_TABLE_SCOPE_MAP).sort()).toEqual(expected);
  });

  it('every mapped GUC is registry-known (or a documented dead arm)', () => {
    const legal = new Set<string>(PRINCIPAL_GUCS);
    for (const definition of Object.values(SESSION_CONTEXTS)) {
      legal.add(definition.guc);
    }
    for (const definition of Object.values(MAINTENANCE_CONTEXTS)) {
      if (definition.guc !== null) {
        legal.add(definition.guc);
      }
    }

    const unknown = Object.values(RLS_TABLE_SCOPE_MAP)
      .flat()
      .filter((guc) => !(legal.has(guc) || KNOWN_DEAD_POLICY_GUCS.has(guc)));
    expect(
      unknown,
      `Policy GUC(s) with no registry entry and no dead-arm note: ${unknown.join(', ')}. ` +
        'A policy arm must be armed by a scope-registry kind — or explicitly listed as dead.',
    ).toEqual([]);
  });
});
