import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { instagramCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { getEnv } from '@/shared/config/env.config.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { OrganizationRepository } from '@/domains/tenancy/sub-domains/organization/organization.repository.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  insertContact,
  readContactRow,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  insertAutomation,
  readAutomationRow,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationRun,
  readRunRow,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  INSTAGRAM_ACCOUNT_PATH,
  INSTAGRAM_CONNECT_PATH,
  buildInstagramProfile,
  createInstagramTeam,
  mockInstagramConnect,
  mockInstagramUnsubscribe,
  readInstagramAccountRows,
  readInstagramTokenCiphertexts,
  readStagedAuditRows,
  type InstagramTeamFixture,
  type TestInstagramProfile,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  FORM_CONTENT_TYPE,
  INSTAGRAM_DATA_DELETION_PATH,
  buildMetaSignedRequest,
  metaCallbackFormBody,
  metaIssuedAtAfterConnections,
  metaSignedRequestPayload,
} from '@/domains/app/sub-domains/instagram-account/instagram-account-meta-callback/__tests__/factories/instagram-account-meta-callback.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { injectAuthenticated, injectRoute } from '@/tests/helpers/test-http-inject.helper.js';

const ORGANIZATION_PATH = testApiPath('/tenancy/organization');
const DATA_DELETION_ACTION = 'app.instagram_account.data_deletion';

/** One account row with what a delete erases, read as the operator (any status). */
interface AccountErasureRow {
  public_id: string;
  connection_status: string;
  username: string | null;
  name: string | null;
  biography: string | null;
  website: string | null;
  profile_picture_url: string | null;
  followers_count: number;
  follows_count: number;
  media_count: number;
  scopes: string[];
  token_expires_at: Date | null;
  webhook_subscribed_at: Date | null;
  disconnected_at: Date | null;
  profile_erased_at: Date | null;
  updated_at: Date;
}

async function readAccounts(organizationId: number): Promise<AccountErasureRow[]> {
  return operatorQuery`
    SELECT public_id, connection_status, username, name, biography, website, profile_picture_url,
           followers_count, follows_count, media_count, scopes, token_expires_at,
           webhook_subscribed_at, disconnected_at, profile_erased_at, updated_at
    FROM app.instagram_accounts WHERE organization_id = ${organizationId} ORDER BY id`;
}

async function countStoredPosts(organizationId: number): Promise<number> {
  const rows = await operatorQuery<Array<{ count: string }>>`
    SELECT count(*)::text AS count FROM app.instagram_media WHERE organization_id = ${organizationId}`;
  return Number(rows[0]?.count);
}

async function readDeletedAt(organizationId: number): Promise<Date | null> {
  const rows = await operatorQuery<Array<{ deleted_at: Date | null }>>`
    SELECT deleted_at FROM tenancy.organizations WHERE id = ${organizationId}`;
  return rows[0]?.deleted_at ?? null;
}

/**
 * Deleting a team erases its Instagram (D54) over HTTP: the account revoked, unsubscribed and free to
 * connect in another team at once, its token, profile and stored posts erased, the automations and
 * runs untouched, the unsubscribe best-effort, the delete safe to run again, and Meta's later data
 * deletion with nothing left to do. Also holds under `pnpm test:rls-role`: the erase runs in the
 * organization's own scope while it is live — after the soft delete row-level security hides every
 * row, and an erase would silently change none. Instagram is mocked with nock.
 */
describe('Instagram account — the organization is deleted', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    team = await createInstagramTeam();
  });

  afterEach(async () => {
    nock.cleanAll();
    vi.restoreAllMocks();
    await instagramCircuit.reset();
  });

  function connect({
    profile,
    fixture = team,
  }: {
    profile: TestInstagramProfile;
    fixture?: InstagramTeamFixture;
  }) {
    mockInstagramConnect({ profile });
    return injectAuthenticated(app, {
      method: 'POST',
      url: INSTAGRAM_CONNECT_PATH,
      token: fixture.ownerToken,
      payload: { code: 'AQB-test-authorization-code#_' },
      headers: { 'x-idempotency-key': `ig-connect-${generatePublicId('instagramAccount')}` },
    });
  }

  /** Connects `profile` for the team and stores `postCount` posts; returns the account's ids. */
  async function connectWithPosts({
    profile,
    postCount = 2,
  }: {
    profile: TestInstagramProfile;
    postCount?: number;
  }): Promise<{ id: number; publicId: string }> {
    expect((await connect({ profile })).statusCode).toBe(200);
    const account = (await readInstagramAccountRows(team.organization.id)).at(-1);
    if (account === undefined) throw new Error('no account to store a post under');
    for (let index = 0; index < postCount; index += 1) {
      await app.appDomain.instagramMediaService.upsertFromInstagram({
        scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: team.organization.public_id }),
        instagramAccount: {
          organizationId: team.organization.id,
          instagramAccountId: Number(account.id),
        },
        mediaItem: {
          id: `1803000000000${account.id}${index}`,
          caption: 'New drop this Friday — comment SHOP for the link',
          media_type: 'IMAGE',
          media_product_type: 'FEED',
          permalink: 'https://www.instagram.com/p/AcmePost/',
          timestamp: '2026-11-20T10:00:00+0000',
          comments_count: 2,
          like_count: 40,
        },
      });
    }
    return { id: Number(account.id), publicId: account.public_id };
  }

  /** The Owner deletes the team, with the recent step-up the route needs. */
  async function deleteTeam(fixture: InstagramTeamFixture = team) {
    return injectAuthenticated(app, {
      method: 'DELETE',
      url: ORGANIZATION_PATH,
      token: await generateTestToken({
        userId: fixture.owner.public_id,
        organizationPublicId: fixture.organization.public_id,
        stepUp: true,
      }),
    });
  }

  function expectErased(row: AccountErasureRow | undefined): void {
    expect(row).toMatchObject({
      connection_status: 'revoked',
      username: null,
      name: null,
      biography: null,
      website: null,
      profile_picture_url: null,
      followers_count: 0,
      follows_count: 0,
      media_count: 0,
      scopes: [],
      token_expires_at: null,
      webhook_subscribed_at: null,
    });
    expect(row?.disconnected_at).not.toBeNull();
    expect(row?.profile_erased_at).not.toBeNull();
  }

  it('unsubscribes and erases the account, its token and posts, and names them on the delete’s audit entry', async () => {
    const profile = buildInstagramProfile();
    const account = await connectWithPosts({ profile });
    const unsubscribe = mockInstagramUnsubscribe({ instagramAppUserId: profile.id });

    const response = await deleteTeam();

    expect(response.statusCode).toBe(204);
    expect(unsubscribe.isDone()).toBe(true);
    expect(await readDeletedAt(team.organization.id)).not.toBeNull();
    const [row] = await readAccounts(team.organization.id);
    expectErased(row);
    expect(await readInstagramTokenCiphertexts(team.organization.id)).toEqual([]);
    expect(await countStoredPosts(team.organization.id)).toBe(0);
    const audit = await readStagedAuditRows({
      organizationPublicId: team.organization.public_id,
      action: 'tenancy.organization.delete',
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      severity: 'WARNING',
      metadata: {
        erased_instagram_account_public_ids: [account.publicId],
        erased_instagram_post_count: 2,
      },
    });
  });

  it('frees the Instagram account: another team connects it at once, as its own new account', async () => {
    const profile = buildInstagramProfile();
    await connectWithPosts({ profile });
    mockInstagramUnsubscribe({ instagramAppUserId: profile.id });
    await deleteTeam();
    const otherTeam = await createInstagramTeam();

    const response = await connect({ profile, fixture: otherTeam });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: { is_new_connection: boolean } }).data).toMatchObject({
      is_new_connection: true,
    });
    const [row] = await readInstagramAccountRows(otherTeam.organization.id);
    expect(row?.connection_status).toBe('connected');
  });

  it('erases an account disconnected before the delete too', async () => {
    const formerProfile = buildInstagramProfile();
    await connectWithPosts({ profile: formerProfile });
    mockInstagramUnsubscribe({ instagramAppUserId: formerProfile.id });
    expect(
      (
        await injectAuthenticated(app, {
          method: 'DELETE',
          url: INSTAGRAM_ACCOUNT_PATH,
          token: team.ownerToken,
        })
      ).statusCode,
    ).toBe(204);
    const profile = buildInstagramProfile();
    await connectWithPosts({ profile, postCount: 1 });
    mockInstagramUnsubscribe({ instagramAppUserId: profile.id });

    expect((await deleteTeam()).statusCode).toBe(204);

    const rows = await readAccounts(team.organization.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) expectErased(row);
    expect(await countStoredPosts(team.organization.id)).toBe(0);
  });

  it('keeps the automations, runs and contacts — they go with the organization’s purge', async () => {
    const profile = buildInstagramProfile();
    const account = await connectWithPosts({ profile });
    const automation = await insertAutomation({
      organizationId: team.organization.id,
      instagramAccountId: account.id,
      status: 'live',
    });
    const contact = await insertContact({
      organizationId: team.organization.id,
      instagramAccountId: account.id,
      username: 'jordan.lee',
    });
    const run = await insertAutomationRun({
      organizationId: team.organization.id,
      automationId: automation.id,
      contactId: contact.id,
    });
    mockInstagramUnsubscribe({ instagramAppUserId: profile.id });

    expect((await deleteTeam()).statusCode).toBe(204);

    expect(await readAutomationRow(automation.public_id)).toMatchObject({
      status: 'live',
      deleted_at: null,
    });
    expect((await readRunRow(run.id))?.status).toBe('waiting');
    expect(await readContactRow(contact.id)).toMatchObject({
      username: 'jordan.lee',
      deleted_at: null,
    });
  });

  it('deletes and erases all the same when the unsubscribe fails', async () => {
    const profile = buildInstagramProfile();
    await connectWithPosts({ profile });
    const unsubscribe = mockInstagramUnsubscribe({
      instagramAppUserId: profile.id,
      outcome: 'failure',
    });

    const response = await deleteTeam();

    expect(response.statusCode).toBe(204);
    expect(unsubscribe.isDone()).toBe(true);
    const [row] = await readAccounts(team.organization.id);
    expectErased(row);
    expect(await readInstagramTokenCiphertexts(team.organization.id)).toEqual([]);
  });

  it('is safe to run again: a delete that stopped after the erase finishes, changing nothing twice', async () => {
    const profile = buildInstagramProfile();
    await connectWithPosts({ profile });
    mockInstagramUnsubscribe({ instagramAppUserId: profile.id });
    vi.spyOn(OrganizationRepository.prototype, 'softDelete').mockRejectedValueOnce(
      new Error('the soft delete failed'),
    );
    expect((await deleteTeam()).statusCode).toBe(500);
    const [erased] = await readAccounts(team.organization.id);
    expectErased(erased);
    expect(await readDeletedAt(team.organization.id)).toBeNull();

    // The offboarding reconcile worker's call (no Instagram call is mocked: there is no token left).
    await app.tenancyDomain.organizationService.resumeOffboarding(
      PRINCIPAL_SCOPE.JOB({ organizationPublicId: team.organization.public_id }),
    );

    expect(await readDeletedAt(team.organization.id)).not.toBeNull();
    const [after] = await readAccounts(team.organization.id);
    expect(after?.profile_erased_at?.getTime()).toBe(erased?.profile_erased_at?.getTime());
    expect(after?.updated_at.getTime()).toBe(erased?.updated_at.getTime());
  });

  it('a team without an Instagram account is deleted as before, its audit entry naming none', async () => {
    const response = await deleteTeam();

    expect(response.statusCode).toBe(204);
    const [audit] = await readStagedAuditRows({
      organizationPublicId: team.organization.public_id,
      action: 'tenancy.organization.delete',
    });
    expect(audit?.metadata).toEqual({});
  });

  it('Meta’s data deletion afterwards answers as ever and changes nothing', async () => {
    const profile = buildInstagramProfile();
    await connectWithPosts({ profile });
    mockInstagramUnsubscribe({ instagramAppUserId: profile.id });
    await deleteTeam();
    const [before] = await readAccounts(team.organization.id);

    const response = await injectRoute(app, {
      method: 'POST',
      url: INSTAGRAM_DATA_DELETION_PATH,
      headers: { 'content-type': FORM_CONTENT_TYPE },
      payload: metaCallbackFormBody(
        buildMetaSignedRequest({
          payload: metaSignedRequestPayload({
            userId: profile.id,
            issuedAt: metaIssuedAtAfterConnections(),
          }),
          appSecret: getEnv().INSTAGRAM_APP_SECRET as string,
        }),
      ),
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { confirmation_code: string }).confirmation_code).toMatch(
      /^[a-z0-9]{21}$/,
    );
    const [after] = await readAccounts(team.organization.id);
    expect(after).toEqual(before);
    expect(
      await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: DATA_DELETION_ACTION,
      }),
    ).toEqual([]);
  });
});
