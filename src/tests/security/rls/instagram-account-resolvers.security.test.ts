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
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { channel_connections } from '@/domains/app/sub-domains/channel-connection/channel-connection.schema.js';
import { channel_connection_tokens } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.schema.js';
import { InstagramAccountRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { ChannelConnectionRepository } from '@/domains/app/sub-domains/channel-connection/channel-connection.repository.js';

/**
 * IA6 / IAC6 (launch-2026-11-20-ujai, routes-final § 1): before the organization is known — connect's
 * "connected elsewhere" check, webhook routing, Meta's callbacks — two SECURITY DEFINER resolvers say
 * which organization holds an Instagram account or a business, and return ONLY organization public ids:
 *
 * - `app.resolve_organization_public_id_for_instagram_user(text)` — the organization whose
 *   NOT-revoked account has that Instagram user id;
 * - `app.resolve_organization_public_ids_for_provider_account(text, text)` — every organization with
 *   a channel account of that provider's channels and provider account id, any status (feat-instagram-
 *   dm-sending § 1 MC15 (1), P56 — Meta's callbacks, tried first);
 * - `app.resolve_organization_public_ids_for_provider_business(text, text)` — every organization with
 *   a connection of that provider and `client_business_id`, any status (MC15 (2) — tried when (1)
 *   finds none).
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
/** The business portfolio of each organization's connection (`555<organization id>`). */
function businessOf(organizationId: number): string {
  return `555${organizationId}`;
}

/** One channel connection per organization, with a placeholder token (MC9). */
async function insertConnection(organizationId: number): Promise<{ id: number }> {
  const [connection] = await database
    .insert(channel_connections)
    .values({
      public_id: generatePublicId('channelConnection'),
      organization_id: organizationId,
      client_business_id: businessOf(organizationId),
      config_id: '1234567890',
    })
    .returning({ id: channel_connections.id });
  await database.insert(channel_connection_tokens).values({
    organization_id: organizationId,
    channel_connection_id: connection!.id,
    encrypted_access_token: `v1:security-test-placeholder-${organizationId}`,
  });
  return connection!;
}

async function insertAccount(options: {
  organizationId: number;
  channelConnectionId: number;
  instagramUserId: string;
  isRevoked: boolean;
}): Promise<{ id: number }> {
  const [channelAccount] = await database
    .insert(channel_accounts)
    .values({
      public_id: generatePublicId('channelAccount'),
      organization_id: options.organizationId,
      channel_connection_id: options.channelConnectionId,
      provider_account_id: options.instagramUserId,
      display_name: `@account_${options.instagramUserId.slice(-2)}`,
      connection_status: options.isRevoked ? 'revoked' : 'connected',
      disconnected_at: options.isRevoked ? new Date() : null,
    })
    .returning({ id: channel_accounts.id });
  const [account] = await database
    .insert(instagram_accounts)
    .values({
      organization_id: options.organizationId,
      channel_account_id: channelAccount!.id,
      instagram_user_id: options.instagramUserId,
      username: `account_${options.instagramUserId.slice(-2)}`,
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

    const connectionInA = await insertConnection(organizationA.id);
    const connectionInB = await insertConnection(organizationB.id);
    // A: one connected account, and a revoked row of the Instagram account B now holds.
    await insertAccount({
      organizationId: organizationA.id,
      channelConnectionId: connectionInA.id,
      instagramUserId: INSTAGRAM_USER.onlyInA,
      isRevoked: false,
    });
    await insertAccount({
      organizationId: organizationA.id,
      channelConnectionId: connectionInA.id,
      instagramUserId: INSTAGRAM_USER.revokedInAConnectedInB,
      isRevoked: true,
    });
    // B: that Instagram account, connected.
    await insertAccount({
      organizationId: organizationB.id,
      channelConnectionId: connectionInB.id,
      instagramUserId: INSTAGRAM_USER.revokedInAConnectedInB,
      isRevoked: false,
    });
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

  it('resolves every organization holding a provider account id, any status — public ids only', async () => {
    const resolve = (providerAccountId: string, provider = 'meta') =>
      executeAsMeepzoBeAppTenant(null, async (transaction) =>
        rowsOf<Record<string, unknown>>(
          await transaction.execute(
            drizzleSql`SELECT * FROM app.resolve_organization_public_ids_for_provider_account(${provider}, ${providerAccountId}) AS organization_public_id`,
          ),
        ),
      );

    const both = await resolve(INSTAGRAM_USER.revokedInAConnectedInB);
    // One column, nothing but the organization's public id.
    expect(both.every((row) => Object.keys(row).join() === 'organization_public_id')).toBe(true);
    expect(both.map((row) => row.organization_public_id).sort()).toEqual(
      [organizationA.public_id, organizationB.public_id].sort(),
    );
    expect(await resolve(INSTAGRAM_USER.onlyInA)).toEqual([
      { organization_public_id: organizationA.public_id },
    ]);
    expect(await resolve(INSTAGRAM_USER.unknown)).toEqual([]);
    // Another provider's accounts are not this provider's.
    expect(await resolve(INSTAGRAM_USER.onlyInA, 'other')).toEqual([]);
  });

  it('resolves every organization with a connection of a business, any status — public ids only', async () => {
    const resolve = (clientBusinessId: string) =>
      executeAsMeepzoBeAppTenant(organizationA.public_id, async (transaction) =>
        rowsOf<Record<string, unknown>>(
          await transaction.execute(
            drizzleSql`SELECT * FROM app.resolve_organization_public_ids_for_provider_business('meta', ${clientBusinessId}) AS organization_public_id`,
          ),
        ),
      );

    // Run in A's scope: B's connection is still found, and only B's public id comes back.
    expect(await resolve(businessOf(organizationB.id))).toEqual([
      { organization_public_id: organizationB.public_id },
    ]);
    await database.execute(
      drizzleSql`UPDATE app.channel_connections SET status = 'revoked', disconnected_at = now() WHERE organization_id = ${organizationA.id}`,
    );
    expect(await resolve(businessOf(organizationA.id))).toEqual([
      { organization_public_id: organizationA.public_id },
    ]);
    expect(await resolve('555000000')).toEqual([]);
  });

  it('the repositories read the resolvers the same way', async () => {
    const repository = new InstagramAccountRepository();
    await expect(
      repository.resolveOrganizationPublicIdForInstagramUser(INSTAGRAM_USER.revokedInAConnectedInB),
    ).resolves.toBe(organizationB.public_id);
    await expect(
      repository.resolveOrganizationPublicIdForInstagramUser(INSTAGRAM_USER.unknown),
    ).resolves.toBeNull();
    const connectionRepository = new ChannelConnectionRepository();
    const organizations = await connectionRepository.resolveOrganizationPublicIdsForProviderAccount(
      { provider: 'meta', providerAccountId: INSTAGRAM_USER.revokedInAConnectedInB },
    );
    expect(organizations.sort()).toEqual([organizationA.public_id, organizationB.public_id].sort());
    await expect(
      connectionRepository.resolveOrganizationPublicIdsForProviderBusiness({
        provider: 'meta',
        clientBusinessId: businessOf(organizationA.id),
      }),
    ).resolves.toEqual([organizationA.public_id]);
  });

  it('the three resolvers are SECURITY DEFINER, pin search_path, return text, and are not PUBLIC-executable', async () => {
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
           -- The day-, week- and month-part makers (feat-instagram-dm-sending R16, R19, R14) are no
           -- resolvers: plain invoker functions, held by role-taxonomy.db.unit.test.ts and the RLS suites.
           AND p.proname NOT IN ('fn_create_daily_partitions', 'fn_create_weekly_partitions', 'fn_create_monthly_partitions')
           -- The organization chooser's counts (feat-instagram-dm-sending R34, UN5) are no resolver
           -- either: a member-gated SECURITY DEFINER read in its own migration, exercised by the
           -- chooser's integration suite.
           AND p.proname <> 'list_organization_counts_for_user'
         ORDER BY p.proname
      `),
    );
    expect(functions.map((entry) => entry.name)).toEqual([
      'resolve_organization_public_id_for_instagram_user',
      'resolve_organization_public_ids_for_provider_account',
      'resolve_organization_public_ids_for_provider_business',
    ]);
    for (const entry of functions) {
      expect(entry.is_security_definer, entry.name).toBe(true);
      expect(entry.return_type, entry.name).toBe('text');
      expect(entry.config ?? [], entry.name).toContain('search_path=app, tenancy, public');
      expect(entry.public_can_execute, entry.name).toBe(false);
      expect(entry.app_can_execute, entry.name).toBe(true);
    }
    expect(functions.map((entry) => entry.returns_set)).toEqual([false, true, true]);
  });

  it('MC9: the retention sweep context sees every account but no connection token', async () => {
    const counts = await withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      callback: async (databaseHandle) =>
        rowsOf<{ accounts: number; tokens: number }>(
          await databaseHandle.execute(drizzleSql`
            SELECT (SELECT count(*)::int FROM app.instagram_accounts) AS accounts,
                   (SELECT count(*)::int FROM app.channel_connection_tokens) AS tokens
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
            drizzleSql`SELECT organization_id FROM app.channel_connection_tokens`,
          ),
        ),
    );
    expect(tokensForB.map((row) => Number(row.organization_id))).toEqual([organizationB.id]);
  });
});
