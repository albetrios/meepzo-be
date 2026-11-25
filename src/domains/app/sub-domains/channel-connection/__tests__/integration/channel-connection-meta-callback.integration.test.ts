import { organizationChannelAccountPath } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { getEnv, resetEnvCacheForTests } from '@/shared/config/env.config.js';
import { DEFAULT_FRONTEND_URL } from '@/shared/constants/index.js';
import { META_CALLBACK_BODY_LIMIT_BYTES } from '@/shared/constants/limits.constants.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  insertContact,
  readContactRow,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { deriveMetaDataDeletionConfirmationCode } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta-callback-confirmation-code.util.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { CREATOR_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  injectAuthenticated,
  injectRoute,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  connectInstagramAccountsThroughRoutes,
  nextClientBusinessId,
  readChannelConnectionRows,
} from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import {
  buildInstagramProfile,
  createInstagramTeam,
  connectInstagramAccount,
  mockInstagramUnsubscribe,
  readInstagramAccountRows,
  readInstagramSettingsRows,
  readInstagramTokenCiphertexts,
  readStagedAuditRows,
  type InstagramTeamFixture,
  type TestInstagramProfile,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  FORM_CONTENT_TYPE,
  META_DATA_DELETION_PATH,
  META_DEAUTHORIZE_PATH,
  buildMetaSignedRequest,
  metaCallbackFormBody,
  metaIssuedAtAfterConnections,
  metaSignedRequestPayload,
} from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection-meta-callback.factory.js';
import { readLaneRows } from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';

const DEAUTHORIZE_ACTION = 'app.channel_connection.deauthorize';
const DATA_DELETION_ACTION = 'app.channel_connection.data_deletion';
/** Meta signs after the connections of a test, unless the test says otherwise (D53). */
const ISSUED_AT = metaIssuedAtAfterConnections() + 60 * 60;

/** One account row with its profile, read as the operator (any status). */
interface AccountProfileRow {
  id: string;
  public_id: string;
  connection_status: string;
  username: string | null;
  biography: string | null;
  website: string | null;
  profile_picture_url: string | null;
  followers_count: number;
  follows_count: number;
  media_count: number;
  disconnected_at: Date | null;
  profile_erased_at: Date | null;
  updated_at: Date;
}

async function readAccountProfiles(organizationId: number): Promise<AccountProfileRow[]> {
  return operatorQuery`
    SELECT i.id, c.public_id, c.connection_status, i.username, i.biography, i.website,
           i.profile_picture_url, i.followers_count, i.follows_count, i.media_count,
           c.disconnected_at, i.profile_erased_at, i.updated_at
    FROM app.instagram_accounts AS i
    INNER JOIN app.channel_accounts AS c
      ON c.organization_id = i.organization_id AND c.id = i.channel_account_id
    WHERE i.organization_id = ${organizationId} ORDER BY i.id`;
}

async function countStoredPosts(organizationId: number): Promise<number> {
  const rows = await operatorQuery<Array<{ count: string }>>`
    SELECT count(*)::text AS count FROM app.instagram_media WHERE organization_id = ${organizationId}`;
  return Number(rows[0]?.count);
}

/** The states of the account's four sending lanes (sub-domain 6, R18), slow first. */
async function readLaneStates(channelAccountId: string): Promise<string[]> {
  return (await readLaneRows(Number(channelAccountId))).map((lane) => lane.state);
}

const STOPPED_LANES = ['stopped', 'stopped', 'stopped', 'stopped'];
const READY_LANES = ['ready', 'ready', 'ready', 'ready'];

async function countAuditRows(action: string): Promise<number> {
  const rows = await operatorQuery<Array<{ count: string }>>`
    SELECT count(*)::text AS count FROM audit.outbox WHERE action = ${action}`;
  return Number(rows[0]?.count);
}

/**
 * Routes 16–17 — Meta's deauthorize and data-deletion callbacks with the connection
 * (feat-instagram-dm-sending routes-final § 1 MC14–MC16, ROUTE row R9) over HTTP: the signed
 * request (MC14), the account id matched first and else the business id (P56) — every matching
 * organization changed in its own scope, a business match reaching every not-revoked account of its
 * connection —, a connection's token deleted with its last account only, the profile and stored
 * posts erased, Meta's answer shape and stable code, an unmatched id and a repeat both answered 200
 * with nothing changed, contacts and another organization's account untouched, the anonymous audit
 * entries (MC12). Meta is mocked with nock for the connects; the database, Redis and the audit
 * outbox are real.
 */
describe('Meta callbacks (deauthorize, data deletion)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  let appSecret: string;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    appSecret = getEnv().META_APP_SECRET as string;
    expect(appSecret).toBeTruthy();
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
    await metaGraphCircuit.reset();
  });

  /** Gives the team the Creator plan (3 accounts), for a connection of two accounts. */
  async function useCreatorPlan(): Promise<void> {
    const plan = await createTestPlan({
      features: CREATOR_PLAN_FEATURES,
      priceMonthly: '29.00',
      priceYearly: '276.00',
    });
    await createTestSubscription({
      organizationId: team.organization.id,
      planId: plan.id,
      status: 'ACTIVE',
    });
  }

  /** Connects `profile` for `fixture` through route 1 and returns the account's public id. */
  async function connectAccount({
    profile,
    fixture = team,
  }: {
    profile: TestInstagramProfile;
    fixture?: InstagramTeamFixture;
  }): Promise<string> {
    const { instagramAccountPublicId } = await connectInstagramAccount({
      app,
      token: fixture.ownerToken,
      profile,
    });
    return instagramAccountPublicId;
  }

  /** Disconnects `fixture`'s account through route 4. */
  async function disconnectAccount({
    profile,
    fixture,
  }: {
    profile: TestInstagramProfile;
    fixture: InstagramTeamFixture;
  }): Promise<void> {
    mockInstagramUnsubscribe({ instagramUserId: profile.id });
    const response = await injectAuthenticated(app, {
      method: 'DELETE',
      url: await organizationChannelAccountPath(fixture.organization.id),
      token: fixture.ownerToken,
    });
    expect(response.statusCode).toBe(204);
  }

  /** Stores one post under the organization's account through the media service (IA17). */
  async function storePost({
    fixture,
    instagramMediaId,
  }: {
    fixture: InstagramTeamFixture;
    instagramMediaId: string;
  }): Promise<void> {
    const [account] = await readInstagramAccountRows(fixture.organization.id);
    if (account === undefined) throw new Error('no account to store a post under');
    await app.appDomain.instagramMediaService.upsertFromInstagram({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: fixture.organization.public_id }),
      channelAccount: {
        organizationId: fixture.organization.id,
        channelAccountId: Number(account.channel_account_id),
      },
      mediaItem: {
        id: instagramMediaId,
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

  /** Meta's form body for `userId`, signed with the app secret unless another is given. */
  function signedBody({
    userId,
    secret = appSecret,
    issuedAt = ISSUED_AT,
  }: {
    userId: string;
    secret?: string;
    issuedAt?: number;
  }): string {
    return metaCallbackFormBody(
      buildMetaSignedRequest({
        payload: metaSignedRequestPayload({ userId, issuedAt }),
        appSecret: secret,
      }),
    );
  }

  /** Meta's `issued_at` an hour ago — between a connection of two hours ago and a reconnect now. */
  function anHourAgo(): number {
    return Math.floor(Date.now() / 1000) - 60 * 60;
  }

  /** Makes the team's account one connected two hours ago. */
  async function backdateConnection(): Promise<void> {
    await operatorQuery`
      UPDATE app.channel_accounts SET connected_at = now() - interval '2 hours'
      WHERE organization_id = ${team.organization.id}`;
  }

  function postCallback({
    url,
    body,
    contentType = FORM_CONTENT_TYPE,
  }: {
    url: string;
    body: unknown;
    contentType?: string;
  }): Promise<InjectHttpResult> {
    return injectRoute(app, {
      method: 'POST',
      url,
      headers: { 'content-type': contentType },
      payload: body,
    });
  }

  function errorOf(response: InjectHttpResult): { code?: string; reason?: string } {
    return (response.json() as { error: Record<string, never> }).error;
  }

  describe('POST /app/social/channel-connections/{provider}/deauthorize (route 16)', () => {
    it('revokes the account and erases its token, keeps profile and settings, answers { data: null }, audits anonymously', async () => {
      const profile = buildInstagramProfile();
      const accountPublicId = await connectAccount({ profile });
      const [connected] = await readInstagramAccountRows(team.organization.id);
      const channelAccountId = connected?.channel_account_id ?? '';
      expect(await readLaneStates(channelAccountId)).toEqual(READY_LANES);

      const response = await postCallback({
        url: META_DEAUTHORIZE_PATH,
        body: signedBody({ userId: profile.id }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: null, meta: { request_id: expect.any(String) } });
      // The revoked account's sending lanes stop, as route 8's do (CA8, R18).
      expect(await readLaneStates(channelAccountId)).toEqual(STOPPED_LANES);
      const [row] = await readAccountProfiles(team.organization.id);
      expect(row).toMatchObject({
        public_id: accountPublicId,
        connection_status: 'revoked',
        username: profile.username,
        profile_erased_at: null,
      });
      expect(row?.disconnected_at).not.toBeNull();
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toEqual([]);
      expect(await readInstagramSettingsRows(team.organization.id)).toHaveLength(1);
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: DEAUTHORIZE_ACTION,
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        severity: 'WARNING',
        resource_type: 'channel_connection',
        metadata: {
          source: 'meta',
          actor_kind: 'anonymous',
          match: 'provider_account',
          channel_account_public_ids: [accountPublicId],
        },
      });
    });

    it('keeps the connection’s token while another account uses it, and deletes it with the last one (CA8)', async () => {
      const first = buildInstagramProfile();
      const second = buildInstagramProfile();
      await useCreatorPlan();
      const { channelConnectionPublicId } = await connectInstagramAccountsThroughRoutes({
        app,
        token: team.ownerToken,
        accounts: [
          { id: first.user_id, username: first.username },
          { id: second.user_id, username: second.username },
        ],
      });

      await postCallback({ url: META_DEAUTHORIZE_PATH, body: signedBody({ userId: first.id }) });

      expect(
        (await readInstagramAccountRows(team.organization.id)).map((row) => row.connection_status),
      ).toEqual(['revoked', 'connected']);
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toHaveLength(1);

      await postCallback({ url: META_DEAUTHORIZE_PATH, body: signedBody({ userId: second.id }) });

      expect(await readInstagramTokenCiphertexts(team.organization.id)).toEqual([]);
      const [connection] = await readChannelConnectionRows(team.organization.id);
      expect(connection).toMatchObject({ public_id: channelConnectionPublicId, status: 'revoked' });
    });

    it('matches the business id when no account carries the signed id: every not-revoked account of that business’s connection, its token deleted (P56)', async () => {
      const otherTeam = await createInstagramTeam();
      const clientBusinessId = nextClientBusinessId();
      const first = buildInstagramProfile();
      const second = buildInstagramProfile();
      await useCreatorPlan();
      const { channelConnectionPublicId } = await connectInstagramAccountsThroughRoutes({
        app,
        token: team.ownerToken,
        accounts: [
          { id: first.user_id, username: first.username },
          { id: second.user_id, username: second.username },
        ],
        clientBusinessId,
      });
      // Another organization's live account of another business is untouched.
      await connectAccount({ profile: buildInstagramProfile(), fixture: otherTeam });

      const response = await postCallback({
        url: META_DEAUTHORIZE_PATH,
        body: signedBody({ userId: clientBusinessId }),
      });

      expect(response.statusCode).toBe(200);
      const rows = await readInstagramAccountRows(team.organization.id);
      expect(rows.map((row) => row.connection_status)).toEqual(['revoked', 'revoked']);
      // Every revoked account's sending lanes stop, as route 8's do (CA8, R18).
      for (const row of rows) {
        expect(await readLaneStates(row.channel_account_id)).toEqual(STOPPED_LANES);
      }
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toEqual([]);
      expect((await readChannelConnectionRows(team.organization.id))[0]?.status).toBe('revoked');
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: DEAUTHORIZE_ACTION,
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.metadata).toMatchObject({
        match: 'provider_business',
        channel_account_public_ids: rows.map((row) => row.public_id),
        revoked_channel_connection_public_ids: [channelConnectionPublicId],
      });
      const [otherRow] = await readInstagramAccountRows(otherTeam.organization.id);
      expect(otherRow?.connection_status).toBe('connected');
      expect(await readLaneStates(otherRow?.channel_account_id ?? '')).toEqual(READY_LANES);
      expect(await readInstagramTokenCiphertexts(otherTeam.organization.id)).toHaveLength(1);
    });

    it('400 provider for any provider but meta', async () => {
      const profile = buildInstagramProfile();
      await connectAccount({ profile });

      const response = await postCallback({
        url: META_DEAUTHORIZE_PATH.replace('/meta/', '/google/'),
        body: signedBody({ userId: profile.id }),
      });

      expect(response.statusCode).toBe(400);
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('connected');
    });

    it('leaves another organization’s account (another Instagram account) untouched', async () => {
      const otherTeam = await createInstagramTeam();
      const profile = buildInstagramProfile();
      await connectAccount({ profile });
      await connectAccount({ profile: buildInstagramProfile(), fixture: otherTeam });

      await postCallback({
        url: META_DEAUTHORIZE_PATH,
        body: signedBody({ userId: profile.id }),
      });

      const [otherRow] = await readInstagramAccountRows(otherTeam.organization.id);
      expect(otherRow?.connection_status).toBe('connected');
      expect(await readInstagramTokenCiphertexts(otherTeam.organization.id)).toHaveLength(1);
      expect(
        await readStagedAuditRows({
          organizationPublicId: otherTeam.organization.public_id,
          action: DEAUTHORIZE_ACTION,
        }),
      ).toEqual([]);
    });

    it('is harmless to repeat: 200 again, nothing changes, no second audit entry', async () => {
      const profile = buildInstagramProfile();
      await connectAccount({ profile });
      const body = signedBody({ userId: profile.id });
      await postCallback({ url: META_DEAUTHORIZE_PATH, body });
      const [before] = await readAccountProfiles(team.organization.id);

      const repeat = await postCallback({ url: META_DEAUTHORIZE_PATH, body });

      expect(repeat.statusCode).toBe(200);
      const [after] = await readAccountProfiles(team.organization.id);
      expect(after?.updated_at.getTime()).toBe(before?.updated_at.getTime());
      expect(after?.disconnected_at?.getTime()).toBe(before?.disconnected_at?.getTime());
      expect(await countAuditRows(DEAUTHORIZE_ACTION)).toBe(1);
    });

    it('leaves a connection made after Meta signed the request alone: a retried request answers 200 and changes nothing (D53)', async () => {
      const profile = buildInstagramProfile();
      const accountPublicId = await connectAccount({ profile });
      await backdateConnection();
      const body = signedBody({ userId: profile.id, issuedAt: anHourAgo() });
      const first = await postCallback({ url: META_DEAUTHORIZE_PATH, body });
      expect(first.statusCode).toBe(200);
      expect((await readAccountProfiles(team.organization.id))[0]?.connection_status).toBe(
        'revoked',
      );
      expect(await connectAccount({ profile })).toBe(accountPublicId);

      const retried = await postCallback({ url: META_DEAUTHORIZE_PATH, body });

      expect(retried.statusCode).toBe(200);
      const [row] = await readAccountProfiles(team.organization.id);
      expect(row).toMatchObject({ connection_status: 'connected', disconnected_at: null });
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toHaveLength(1);
      expect(await countAuditRows(DEAUTHORIZE_ACTION)).toBe(1);
      // A request Meta signs after the reconnect still disconnects it.
      await postCallback({
        url: META_DEAUTHORIZE_PATH,
        body: signedBody({ userId: profile.id }),
      });
      expect((await readAccountProfiles(team.organization.id))[0]?.connection_status).toBe(
        'revoked',
      );
      expect(await countAuditRows(DEAUTHORIZE_ACTION)).toBe(2);
    });

    it('disconnects on a request without issued_at, as ever', async () => {
      const profile = buildInstagramProfile();
      await connectAccount({ profile });

      const response = await postCallback({
        url: META_DEAUTHORIZE_PATH,
        body: metaCallbackFormBody(
          buildMetaSignedRequest({
            payload: { algorithm: 'HMAC-SHA256', user_id: profile.id },
            appSecret,
          }),
        ),
      });

      expect(response.statusCode).toBe(200);
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('revoked');
    });

    it('answers 200 for an id that matches neither account nor business, changing and auditing nothing (MC16)', async () => {
      const profile = buildInstagramProfile();
      await connectAccount({ profile });

      const response = await postCallback({
        url: META_DEAUTHORIZE_PATH,
        body: signedBody({ userId: '99999999999999999' }),
      });

      expect(response.statusCode).toBe(200);
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('connected');
      expect(await countAuditRows(DEAUTHORIZE_ACTION)).toBe(0);
    });

    it('refuses a request signed with another secret: 400 instagram_signed_request_invalid, nothing changes', async () => {
      const profile = buildInstagramProfile();
      await connectAccount({ profile });

      const response = await postCallback({
        url: META_DEAUTHORIZE_PATH,
        body: signedBody({ userId: profile.id, secret: 'not-the-instagram-app-secret' }),
      });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).reason).toBe('instagram_signed_request_invalid');
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('connected');
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toHaveLength(1);
      expect(await countAuditRows(DEAUTHORIZE_ACTION)).toBe(0);
    });

    it('refuses a missing signed_request with 400 instagram_signed_request_invalid', async () => {
      const response = await postCallback({ url: META_DEAUTHORIZE_PATH, body: 'other=1' });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).reason).toBe('instagram_signed_request_invalid');
    });

    it('refuses a JSON body with 415', async () => {
      const profile = buildInstagramProfile();
      await connectAccount({ profile });

      const response = await postCallback({
        url: META_DEAUTHORIZE_PATH,
        body: JSON.stringify({ signed_request: 'abc.def' }),
        contentType: 'application/json',
      });

      expect(response.statusCode).toBe(415);
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('connected');
    });

    it.each([
      ['deauthorize', META_DEAUTHORIZE_PATH],
      ['data deletion', META_DATA_DELETION_PATH],
    ])(
      'refuses a body over 16 KB with 413, and one of repeated fields at the limit with 400 (%s)',
      async (_route, url) => {
        const profile = buildInstagramProfile();
        await connectAccount({ profile });
        const signed = signedBody({ userId: profile.id });

        const oversized = await postCallback({
          url,
          body: signed + '&a'.repeat(META_CALLBACK_BODY_LIMIT_BYTES / 2),
        });
        expect(oversized.statusCode).toBe(413);

        const repeatedFields = await postCallback({
          url,
          body: 'a&'.repeat(META_CALLBACK_BODY_LIMIT_BYTES / 2),
        });
        expect(repeatedFields.statusCode).toBe(400);
        expect(errorOf(repeatedFields).reason).toBe('instagram_signed_request_invalid');

        const doubled = await postCallback({ url, body: `${signed}&${signed}` });
        expect(doubled.statusCode).toBe(400);
        expect(errorOf(doubled).reason).toBe('instagram_signed_request_invalid');

        const [row] = await readInstagramAccountRows(team.organization.id);
        expect(row?.connection_status).toBe('connected');
      },
    );

    it('answers 503 instagram_not_configured when the Instagram app secret is unset', async () => {
      const savedAppSecret = process.env.META_APP_SECRET;
      delete process.env.META_APP_SECRET;
      resetEnvCacheForTests();
      try {
        const response = await postCallback({
          url: META_DEAUTHORIZE_PATH,
          body: signedBody({ userId: '17841400000000001' }),
        });

        expect(response.statusCode).toBe(503);
        expect(errorOf(response).reason).toBe('instagram_not_configured');
      } finally {
        process.env.META_APP_SECRET = savedAppSecret;
        resetEnvCacheForTests();
      }
    });
  });

  describe('POST /app/social/channel-connections/{provider}/data-deletion (route 17)', () => {
    it('disconnects, erases the token, profile and stored posts, keeps contacts and settings, answers Meta’s shape', async () => {
      const profile = buildInstagramProfile();
      const accountPublicId = await connectAccount({ profile });
      await storePost({ fixture: team, instagramMediaId: '18030000000000001' });
      await storePost({ fixture: team, instagramMediaId: '18030000000000002' });
      const [account] = await readInstagramAccountRows(team.organization.id);
      const contact = await insertContact({
        organizationId: team.organization.id,
        instagramAccountId: Number(account?.id),
        username: 'acme.customer',
        full_name: 'Acme Customer',
      });

      const response = await postCallback({
        url: META_DATA_DELETION_PATH,
        body: signedBody({ userId: profile.id }),
      });

      expect(response.statusCode).toBe(200);
      const code = deriveMetaDataDeletionConfirmationCode({
        signedRequest: { userId: profile.id, issuedAt: ISSUED_AT },
        appSecret,
      });
      const frontendUrl = (getEnv().FRONTEND_URL ?? DEFAULT_FRONTEND_URL).replace(/\/+$/, '');
      // Meta's own shape, outside the { data, meta } envelope (IA20).
      expect(response.json()).toEqual({
        url: `${frontendUrl}/instagram/data-deletion?code=${code}`,
        confirmation_code: code,
      });
      expect(code).toMatch(/^[a-z0-9]{21}$/);

      const [row] = await readAccountProfiles(team.organization.id);
      expect(row).toMatchObject({
        public_id: accountPublicId,
        connection_status: 'revoked',
        username: null,
        biography: null,
        website: null,
        profile_picture_url: null,
        followers_count: 0,
        follows_count: 0,
        media_count: 0,
      });
      expect(row?.profile_erased_at).not.toBeNull();
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toEqual([]);
      expect(await countStoredPosts(team.organization.id)).toBe(0);
      expect(await readInstagramSettingsRows(team.organization.id)).toHaveLength(1);
      expect(await readContactRow(contact.id)).toMatchObject({
        username: 'acme.customer',
        full_name: 'Acme Customer',
        deleted_at: null,
      });

      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: DATA_DELETION_ACTION,
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        severity: 'WARNING',
        resource_type: 'channel_connection',
        metadata: {
          source: 'meta',
          actor_kind: 'anonymous',
          match: 'provider_account',
          channel_account_public_ids: [accountPublicId],
          confirmation_code: code,
          erased_post_count: 2,
        },
      });
    });

    it('also erases a revoked row of the same person in another organization, and leaves another account untouched', async () => {
      const formerTeam = await createInstagramTeam();
      const bystanderTeam = await createInstagramTeam();
      const profile = buildInstagramProfile();
      // The person's account was connected to formerTeam first, then disconnected there…
      await connectAccount({ profile, fixture: formerTeam });
      await storePost({ fixture: formerTeam, instagramMediaId: '18030000000000003' });
      await disconnectAccount({ profile, fixture: formerTeam });
      // …and is live in team now; a bystander holds another Instagram account.
      await connectAccount({ profile });
      await connectAccount({ profile: buildInstagramProfile(), fixture: bystanderTeam });
      await storePost({ fixture: bystanderTeam, instagramMediaId: '18030000000000004' });

      const response = await postCallback({
        url: META_DATA_DELETION_PATH,
        body: signedBody({ userId: profile.id }),
      });

      expect(response.statusCode).toBe(200);
      for (const fixture of [team, formerTeam]) {
        const [row] = await readAccountProfiles(fixture.organization.id);
        expect(row).toMatchObject({ connection_status: 'revoked', username: null });
        expect(row?.profile_erased_at).not.toBeNull();
        expect(await countStoredPosts(fixture.organization.id)).toBe(0);
        expect(
          await readStagedAuditRows({
            organizationPublicId: fixture.organization.public_id,
            action: DATA_DELETION_ACTION,
          }),
        ).toHaveLength(1);
      }
      const [bystander] = await readAccountProfiles(bystanderTeam.organization.id);
      expect(bystander?.connection_status).toBe('connected');
      expect(bystander?.username).not.toBeNull();
      expect(await countStoredPosts(bystanderTeam.organization.id)).toBe(1);
      expect(await readInstagramTokenCiphertexts(bystanderTeam.organization.id)).toHaveLength(1);
    });

    it('erases the profile of an account Meta deauthorized first', async () => {
      const profile = buildInstagramProfile();
      await connectAccount({ profile });
      await postCallback({
        url: META_DEAUTHORIZE_PATH,
        body: signedBody({ userId: profile.id }),
      });

      const response = await postCallback({
        url: META_DATA_DELETION_PATH,
        body: signedBody({ userId: profile.id }),
      });

      expect(response.statusCode).toBe(200);
      const [row] = await readAccountProfiles(team.organization.id);
      expect(row?.username).toBeNull();
      expect(row?.profile_erased_at).not.toBeNull();
    });

    it('is harmless to repeat: the same code, nothing changes, no second audit entry', async () => {
      const profile = buildInstagramProfile();
      await connectAccount({ profile });
      const body = signedBody({ userId: profile.id });
      const first = await postCallback({ url: META_DATA_DELETION_PATH, body });
      const [before] = await readAccountProfiles(team.organization.id);

      const repeat = await postCallback({ url: META_DATA_DELETION_PATH, body });

      expect(repeat.statusCode).toBe(200);
      expect(repeat.json()).toEqual(first.json());
      const [after] = await readAccountProfiles(team.organization.id);
      expect(after?.profile_erased_at?.getTime()).toBe(before?.profile_erased_at?.getTime());
      expect(after?.updated_at.getTime()).toBe(before?.updated_at.getTime());
      expect(await countAuditRows(DATA_DELETION_ACTION)).toBe(1);
    });

    it('leaves a connection made after Meta signed the request alone: a retried request gets the same code and erases nothing (D53)', async () => {
      const profile = buildInstagramProfile();
      await connectAccount({ profile });
      await backdateConnection();
      const body = signedBody({ userId: profile.id, issuedAt: anHourAgo() });
      const first = await postCallback({ url: META_DATA_DELETION_PATH, body });
      expect((await readAccountProfiles(team.organization.id))[0]?.username).toBeNull();
      await connectAccount({ profile });
      await storePost({ fixture: team, instagramMediaId: '18030000000000006' });

      const retried = await postCallback({ url: META_DATA_DELETION_PATH, body });

      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toEqual(first.json());
      const [row] = await readAccountProfiles(team.organization.id);
      expect(row).toMatchObject({
        connection_status: 'connected',
        username: profile.username,
        profile_erased_at: null,
      });
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toHaveLength(1);
      expect(await countStoredPosts(team.organization.id)).toBe(1);
      expect(await countAuditRows(DATA_DELETION_ACTION)).toBe(1);
    });

    it('answers 200 with a code for an id that matches neither account nor business, changing and auditing nothing (MC16)', async () => {
      const response = await postCallback({
        url: META_DATA_DELETION_PATH,
        body: signedBody({ userId: '99999999999999999' }),
      });

      expect(response.statusCode).toBe(200);
      expect((response.json() as { confirmation_code: string }).confirmation_code).toMatch(
        /^[a-z0-9]{21}$/,
      );
      expect(await countAuditRows(DATA_DELETION_ACTION)).toBe(0);
    });

    it('a business-id match erases the profile and posts of every not-revoked account of that connection (P56)', async () => {
      const clientBusinessId = nextClientBusinessId();
      const profile = buildInstagramProfile();
      await connectInstagramAccountsThroughRoutes({
        app,
        token: team.ownerToken,
        accounts: [{ id: profile.user_id, username: profile.username }],
        clientBusinessId,
      });
      await storePost({ fixture: team, instagramMediaId: '18030000000000007' });

      const response = await postCallback({
        url: META_DATA_DELETION_PATH,
        body: signedBody({ userId: clientBusinessId }),
      });

      expect(response.statusCode).toBe(200);
      const [row] = await readAccountProfiles(team.organization.id);
      expect(row).toMatchObject({ connection_status: 'revoked', username: null });
      const [revoked] = await readInstagramAccountRows(team.organization.id);
      expect(await readLaneStates(revoked?.channel_account_id ?? '')).toEqual(STOPPED_LANES);
      expect(await countStoredPosts(team.organization.id)).toBe(0);
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: DATA_DELETION_ACTION,
      });
      expect(audit[0]?.metadata).toMatchObject({
        match: 'provider_business',
        erased_post_count: 1,
      });
    });

    it('refuses a bad signed request with 400 instagram_signed_request_invalid and erases nothing', async () => {
      const profile = buildInstagramProfile();
      await connectAccount({ profile });
      await storePost({ fixture: team, instagramMediaId: '18030000000000005' });

      const response = await postCallback({
        url: META_DATA_DELETION_PATH,
        body: signedBody({ userId: profile.id, secret: 'not-the-instagram-app-secret' }),
      });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).reason).toBe('instagram_signed_request_invalid');
      const [row] = await readAccountProfiles(team.organization.id);
      expect(row).toMatchObject({ connection_status: 'connected', username: profile.username });
      expect(await countStoredPosts(team.organization.id)).toBe(1);
      expect(await countAuditRows(DATA_DELETION_ACTION)).toBe(0);
    });
  });
});
