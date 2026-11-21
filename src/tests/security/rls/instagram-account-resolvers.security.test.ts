import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { database } from '@/infrastructure/database/connection.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  executeAsMeepzoBeAppTenant,
  grantMeepzoBeAppRoleForTests,
} from '@/tests/helpers/rls-matrix.helper.js';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { instagram_account_tokens } from '@/domains/app/sub-domains/instagram-account/instagram-account-token.schema.js';
import { InstagramAccountRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';

/**
 * IA6 / IAC6 (launch-2026-11-20-ujai, routes-final § 1): before the organization is known — connect's
 * "connected elsewhere" check, webhook routing, Meta's callbacks — two SECURITY DEFINER resolvers say
 * which organization holds an Instagram account, and return ONLY organization public ids:
 *
 * - `app.resolve_organization_public_id_for_instagram_user(text)` — the organization whose
 *   NOT-revoked account has that Instagram user id;
 * - `app.resolve_organization_public_ids_for_instagram_app_user(text)` — every organization with a
 *   row of that app-scoped id, any status.
 *
 * Run as `meepzo_be_app` (the production role, subject to FORCE RLS): a plain read of another
 * organization's account sees nothing, the resolvers still answer, and they answer only a public
 * id. The superuser the harness normally connects as would hide a broken policy or resolver.
 *
 * IA5 too: the token table has no retention sweep arm, so the maintenance sweep context that sees
 * every account sees no token.
 */

/** Rows of a `database.execute()` result. */
function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

/** Digits-only Instagram ids, as Instagram sends them. */
const INSTAGRAM_USER = {
  onlyInA: '17841400000000011',
  revokedInAConnectedInB: '17841400000000033',
  unknown: '17841400000000099',
} as const;
const INSTAGRAM_APP_USER = {
  onlyInA: '90000000000000011',
  revokedInAConnectedInB: '90000000000000033',
  unknown: '90000000000000099',
} as const;

async function insertAccount(options: {
  organizationId: number;
  instagramUserId: string;
  instagramAppUserId: string;
  isRevoked: boolean;
}): Promise<{ id: number }> {
  const [account] = await database
    .insert(instagram_accounts)
    .values({
      public_id: generatePublicId('instagramAccount'),
      organization_id: options.organizationId,
      instagram_user_id: options.instagramUserId,
      instagram_app_user_id: options.instagramAppUserId,
      username: `account_${options.instagramUserId.slice(-2)}`,
      connection_status: options.isRevoked ? 'revoked' : 'connected',
      disconnected_at: options.isRevoked ? new Date() : null,
    })
    .returning({ id: instagram_accounts.id });
  return account!;
}

describe('Security: Instagram account resolvers and token isolation (IA5, IA6) as meepzo_be_app', () => {
  let organizationA: { id: number; public_id: string };
  let organizationB: { id: number; public_id: string };

  beforeAll(async () => {
    await grantMeepzoBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    organizationA = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    organizationB = await createTestOrganization({ ownerUserId: (await createTestUser()).id });

    // A: one connected account, and a revoked row of the Instagram account B now holds.
    const accountInA = await insertAccount({
      organizationId: organizationA.id,
      instagramUserId: INSTAGRAM_USER.onlyInA,
      instagramAppUserId: INSTAGRAM_APP_USER.onlyInA,
      isRevoked: false,
    });
    await insertAccount({
      organizationId: organizationA.id,
      instagramUserId: INSTAGRAM_USER.revokedInAConnectedInB,
      instagramAppUserId: INSTAGRAM_APP_USER.revokedInAConnectedInB,
      isRevoked: true,
    });
    // B: that Instagram account, connected.
    const accountInB = await insertAccount({
      organizationId: organizationB.id,
      instagramUserId: INSTAGRAM_USER.revokedInAConnectedInB,
      instagramAppUserId: INSTAGRAM_APP_USER.revokedInAConnectedInB,
      isRevoked: false,
    });
    await database.insert(instagram_account_tokens).values([
      {
        organization_id: organizationA.id,
        instagram_account_id: accountInA.id,
        encrypted_access_token: 'v1:security-test-placeholder-a',
      },
      {
        organization_id: organizationB.id,
        instagram_account_id: accountInB.id,
        encrypted_access_token: 'v1:security-test-placeholder-b',
      },
    ]);
  });

  it('control: a plain read under organization A sees none of B’s rows, and nothing without a context', async () => {
    const visibleToA = await executeAsMeepzoBeAppTenant(
      organizationA.public_id,
      async (transaction) =>
        rowsOf<{ organization_id: number }>(
          await transaction.execute(
            drizzleSql`SELECT organization_id FROM app.instagram_accounts WHERE instagram_user_id = ${INSTAGRAM_USER.revokedInAConnectedInB}`,
          ),
        ),
    );
    expect(visibleToA.map((row) => Number(row.organization_id))).toEqual([organizationA.id]);

    const visibleWithoutContext = await executeAsMeepzoBeAppTenant(null, async (transaction) =>
      rowsOf<{ count: number }>(
        await transaction.execute(
          drizzleSql`SELECT count(*)::int AS count FROM app.instagram_accounts`,
        ),
      ),
    );
    expect(Number(visibleWithoutContext[0]?.count)).toBe(0);
  });

  it('resolves the organization of the NOT-revoked account across RLS, and only its public id', async () => {
    const answers = await executeAsMeepzoBeAppTenant(organizationA.public_id, async (transaction) =>
      rowsOf<{ held_by_a: string | null; held_by_b: string | null; unknown: string | null }>(
        await transaction.execute(drizzleSql`
          SELECT app.resolve_organization_public_id_for_instagram_user(${INSTAGRAM_USER.onlyInA}) AS held_by_a,
                 app.resolve_organization_public_id_for_instagram_user(${INSTAGRAM_USER.revokedInAConnectedInB}) AS held_by_b,
                 app.resolve_organization_public_id_for_instagram_user(${INSTAGRAM_USER.unknown}) AS unknown
        `),
      ),
    );
    // A's revoked row of the same Instagram account is not an answer: B holds it live.
    expect(answers[0]).toEqual({
      held_by_a: organizationA.public_id,
      held_by_b: organizationB.public_id,
      unknown: null,
    });
  });

  it('resolves every organization holding an app-scoped id, any status — public ids only', async () => {
    const resolve = (instagramAppUserId: string) =>
      executeAsMeepzoBeAppTenant(null, async (transaction) =>
        rowsOf<Record<string, unknown>>(
          await transaction.execute(
            drizzleSql`SELECT * FROM app.resolve_organization_public_ids_for_instagram_app_user(${instagramAppUserId}) AS organization_public_id`,
          ),
        ),
      );

    const both = await resolve(INSTAGRAM_APP_USER.revokedInAConnectedInB);
    // One column, nothing but the organization's public id.
    expect(both.every((row) => Object.keys(row).join() === 'organization_public_id')).toBe(true);
    expect(both.map((row) => row.organization_public_id).sort()).toEqual(
      [organizationA.public_id, organizationB.public_id].sort(),
    );
    expect(await resolve(INSTAGRAM_APP_USER.onlyInA)).toEqual([
      { organization_public_id: organizationA.public_id },
    ]);
    expect(await resolve(INSTAGRAM_APP_USER.unknown)).toEqual([]);
  });

  it('the repository reads both resolvers the same way', async () => {
    const repository = new InstagramAccountRepository();
    await expect(
      repository.resolveOrganizationPublicIdForInstagramUser(INSTAGRAM_USER.revokedInAConnectedInB),
    ).resolves.toBe(organizationB.public_id);
    await expect(
      repository.resolveOrganizationPublicIdForInstagramUser(INSTAGRAM_USER.unknown),
    ).resolves.toBeNull();
    const organizations = await repository.resolveOrganizationPublicIdsForInstagramAppUser(
      INSTAGRAM_APP_USER.revokedInAConnectedInB,
    );
    expect(organizations.sort()).toEqual([organizationA.public_id, organizationB.public_id].sort());
  });

  it('both resolvers are SECURITY DEFINER, pin search_path, return text, and are not PUBLIC-executable', async () => {
    const functions = rowsOf<{
      name: string;
      is_security_definer: boolean;
      return_type: string;
      returns_set: boolean;
      config: string[] | null;
      public_can_execute: boolean;
      app_can_execute: boolean;
    }>(
      await database.execute(drizzleSql`
        SELECT p.proname AS name,
               p.prosecdef AS is_security_definer,
               p.prorettype::regtype::text AS return_type,
               p.proretset AS returns_set,
               p.proconfig AS config,
               EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
                        WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_can_execute,
               has_function_privilege('meepzo_be_app', p.oid, 'EXECUTE') AS app_can_execute
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'app'
         ORDER BY p.proname
      `),
    );
    expect(functions.map((entry) => entry.name)).toEqual([
      'resolve_organization_public_id_for_instagram_user',
      'resolve_organization_public_ids_for_instagram_app_user',
    ]);
    for (const entry of functions) {
      expect(entry.is_security_definer, entry.name).toBe(true);
      expect(entry.return_type, entry.name).toBe('text');
      expect(entry.config ?? [], entry.name).toContain('search_path=app, tenancy, public');
      expect(entry.public_can_execute, entry.name).toBe(false);
      expect(entry.app_can_execute, entry.name).toBe(true);
    }
    expect(functions.map((entry) => entry.returns_set)).toEqual([false, true]);
  });

  it('IA5: the retention sweep context sees every account but no token', async () => {
    const counts = await withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      callback: async (databaseHandle) =>
        rowsOf<{ accounts: number; tokens: number }>(
          await databaseHandle.execute(drizzleSql`
            SELECT (SELECT count(*)::int FROM app.instagram_accounts) AS accounts,
                   (SELECT count(*)::int FROM app.instagram_account_tokens) AS tokens
          `),
        ),
      options: { useMaintenanceDatabaseRole: true },
    });
    expect(counts[0]).toEqual({ accounts: 3, tokens: 0 });

    // The owning organization still reads its own token, and only its own.
    const tokensForB = await executeAsMeepzoBeAppTenant(
      organizationB.public_id,
      async (transaction) =>
        rowsOf<{ organization_id: number }>(
          await transaction.execute(
            drizzleSql`SELECT organization_id FROM app.instagram_account_tokens`,
          ),
        ),
    );
    expect(tokensForB.map((row) => Number(row.organization_id))).toEqual([organizationB.id]);
  });
});
