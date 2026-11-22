import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { instagramCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  INSTAGRAM_AUTHORIZATION_BASE_URL,
  INSTAGRAM_GRAPH_API_VERSION,
  INSTAGRAM_GRAPH_BASE_URL,
} from '@/infrastructure/social/instagram.client.js';
import { InstagramAccountRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { provisionOrganizationWithOwner } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { env, resetEnvCacheForTests } from '@/shared/config/env.config.js';
import enErrors from '@/shared/locales/en/errors.json' with { type: 'json' };
import { responseBodyContainsSecretFields } from '@/shared/utils/idempotency/idempotency-fingerprint.util.js';
import { buildIdempotencyCacheKey } from '@/shared/utils/idempotency/idempotency-key.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { decryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { buildInFlightIdempotencyEntry } from '@/tests/helpers/idempotency-entry.helper.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  injectAuthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  INSTAGRAM_ACCOUNT_PATH,
  INSTAGRAM_ACCOUNT_SETTINGS_PATH,
  INSTAGRAM_CONNECT_PATH,
  TEST_INSTAGRAM_LONG_LIVED_TOKEN,
  buildInstagramProfile,
  createInstagramTeam,
  createPersonalOrganizationWithInstagramCodes,
  endTrialWithoutPaying,
  mockInstagramConnect,
  mockInstagramUnsubscribe,
  readInstagramAccountRows,
  readInstagramSettingsRows,
  readInstagramTokenCiphertexts,
  readStagedAuditRows,
  type InstagramTeamFixture,
  type TestInstagramProfile,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  AUTOMATIONS_PATH,
  commentAutomationBody,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';

/**
 * Routes 1, 2 and 4 of the Instagram account (routes-final § 1.A, ROUTE R3) over HTTP: every
 * success and every error of 1.A.9 and 1.5, team-only (K1), the Member role (AC-1.7), another
 * organization's data, idempotency (K3), the D34 503 reasons, and a read-only plan leaving routes
 * 1, 3 and 4 open (D27). Instagram is mocked with nock; the database, Redis, auth, permissions and
 * idempotency are real.
 */
describe('Instagram account routes (connect, read, disconnect)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  const seededIdempotencyKeys: string[] = [];

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
    if (seededIdempotencyKeys.length > 0) {
      await redisConnection.del(...seededIdempotencyKeys);
      seededIdempotencyKeys.length = 0;
    }
  });

  /** A connect with a fresh idempotency key unless one is given. */
  function connect({
    token,
    code = 'AQB-test-authorization-code#_',
    payload,
    idempotencyKey = `ig-connect-${generatePublicId('instagramAccount')}`,
  }: {
    token: string;
    code?: string;
    payload?: unknown;
    idempotencyKey?: string | null;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'POST',
      url: INSTAGRAM_CONNECT_PATH,
      token,
      payload: payload ?? { code },
      headers: idempotencyKey === null ? {} : { 'x-idempotency-key': idempotencyKey },
    });
  }

  /** Connects `profile` for the team's Owner and returns the answer's account. */
  async function connectAccount(profile: TestInstagramProfile, token = team.ownerToken) {
    mockInstagramConnect({ profile });
    const response = await connect({ token });
    expect(response.statusCode).toBe(200);
    return (response.json() as { data: { instagram_account: Record<string, unknown> } }).data
      .instagram_account;
  }

  function errorOf(response: InjectHttpResult): {
    code?: string;
    reason?: string;
    detail?: string;
    errors?: Array<{ field: string }>;
  } {
    return (response.json() as { error: Record<string, never> }).error;
  }

  describe('POST /app/social/instagram/connect (route 1)', () => {
    it('connects a new account: connected, default settings, subscribed, token stored encrypted and never returned', async () => {
      const profile = buildInstagramProfile();
      const scopes = mockInstagramConnect({ profile });

      const response = await connect({ token: team.ownerToken });

      expect(response.statusCode).toBe(200);
      expect(scopes.every((scope) => scope.isDone())).toBe(true);
      expect(response.body).not.toContain(TEST_INSTAGRAM_LONG_LIVED_TOKEN);
      const { data } = response.json() as {
        data: { is_new_connection: boolean; instagram_account: Record<string, unknown> };
      };
      expect(data.is_new_connection).toBe(true);
      const account = data.instagram_account;
      expect(account.id).toMatch(/^iga_[a-z0-9]{21}$/);
      expect(account).toMatchObject({
        instagram_user_id: profile.user_id,
        username: profile.username,
        name: profile.name,
        biography: profile.biography,
        website: profile.website,
        profile_picture_url: profile.profile_picture_url,
        profile_url: `https://instagram.com/${profile.username}`,
        followers_count: profile.followers_count,
        follows_count: profile.follows_count,
        media_count: profile.media_count,
        connection_status: 'connected',
        is_webhook_subscribed: true,
        connected_by_user_id: team.owner.public_id,
        settings: {
          is_automation_enabled: true,
          is_public_reply_safety_enabled: false,
          public_reply_chance_percent: 80,
          public_reply_hour_limit: 60,
          public_reply_gap_min_seconds: 20,
          public_reply_gap_max_seconds: 60,
          updated_by_user_id: null,
        },
      });
      expect(account.scopes).toEqual(
        expect.arrayContaining([
          'instagram_business_basic',
          'instagram_business_manage_messages',
          'instagram_business_manage_comments',
        ]),
      );
      // About 60 days ahead (AC-2.4).
      const expiresInDays =
        (Date.parse(account.access_expires_at as string) - Date.now()) / (24 * 60 * 60 * 1000);
      expect(expiresInDays).toBeGreaterThan(59);
      expect(expiresInDays).toBeLessThan(61);
      // The column keeps `token_expires_at`; the API names it `access_expires_at` (D35).
      expect(account).not.toHaveProperty('token_expires_at');
      expect(Object.keys(account).some((key) => key.includes('access_token'))).toBe(false);

      // The token is stored only as ciphertext of the long-lived token (IA5).
      const ciphertexts = await readInstagramTokenCiphertexts(team.organization.id);
      expect(ciphertexts).toHaveLength(1);
      expect(ciphertexts[0]).not.toContain(TEST_INSTAGRAM_LONG_LIVED_TOKEN);
      expect(decryptFieldSecret(ciphertexts[0] as string)).toBe(TEST_INSTAGRAM_LONG_LIVED_TOKEN);
      expect(await readInstagramSettingsRows(team.organization.id)).toHaveLength(1);

      // One audit entry, recorded after the connect commits (D36), without the token or the code (IA7).
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.instagram_account.connect',
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        severity: 'WARNING',
        resource_type: 'instagram_account',
        metadata: { instagram_account_public_id: account.id, is_new_connection: true },
      });
      expect(JSON.stringify(audit[0])).not.toContain('AQB-test-authorization-code');
      expect(JSON.stringify(audit[0])).not.toContain(TEST_INSTAGRAM_LONG_LIVED_TOKEN);
    });

    it('lets an Admin connect', async () => {
      mockInstagramConnect({ profile: buildInstagramProfile() });
      expect((await connect({ token: team.adminToken })).statusCode).toBe(200);
    });

    it('still connects when the webhook subscription fails, and shows it as not subscribed (AC-2.10)', async () => {
      mockInstagramConnect({ profile: buildInstagramProfile(), subscription: 'failure' });

      const response = await connect({ token: team.ownerToken });

      expect(response.statusCode).toBe(200);
      const { data } = response.json() as {
        data: { instagram_account: { is_webhook_subscribed: boolean } };
      };
      expect(data.instagram_account.is_webhook_subscribed).toBe(false);
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.webhook_subscribed_at).toBeNull();
    });

    it('still connects when the audit entry cannot be recorded — audit is best-effort, after commit (D36)', async () => {
      mockInstagramConnect({ profile: buildInstagramProfile() });
      const record = vi
        .spyOn(app.auditDomain.auditService, 'record')
        .mockRejectedValue(new Error('audit outbox unavailable'));

      const response = await connect({ token: team.ownerToken });

      expect(response.statusCode).toBe(200);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'app.instagram_account.connect' }),
      );
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('connected');
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toHaveLength(1);
    });

    it('reconnecting the same account while connected updates it, keeps its settings and is not new', async () => {
      const profile = buildInstagramProfile();
      const first = await connectAccount(profile);
      const settingsBefore = await readInstagramSettingsRows(team.organization.id);

      // Already subscribed: the reconnect makes no subscribed_apps call.
      mockInstagramConnect({
        profile: { ...profile, followers_count: 2000 },
        subscription: 'none',
      });
      const response = await connect({ token: team.ownerToken });

      expect(response.statusCode).toBe(200);
      const { data } = response.json() as {
        data: { is_new_connection: boolean; instagram_account: Record<string, unknown> };
      };
      expect(data.is_new_connection).toBe(false);
      expect(data.instagram_account.id).toBe(first.id);
      expect(data.instagram_account.followers_count).toBe(2000);
      expect(await readInstagramSettingsRows(team.organization.id)).toEqual(settingsBefore);
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toHaveLength(1);
    });

    it.each([
      ['missing', {}],
      ['empty', { code: '' }],
      ['blank', { code: '   ' }],
      ['over 2000 characters', { code: 'a'.repeat(2001) }],
    ])('answers 400 on code when the code is %s', async (_case, payload) => {
      const response = await connect({ token: team.ownerToken, payload });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).errors?.map((item) => item.field)).toEqual(
        expect.arrayContaining([expect.stringContaining('code')]),
      );
    });

    it('answers 400 on an unknown field', async () => {
      const response = await connect({
        token: team.ownerToken,
        payload: { code: 'AQB-code', state: 'not-a-field' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('refuses a Member with 403 missing_permission and calls no Instagram (AC-1.7)', async () => {
      const scopes = mockInstagramConnect({ profile: buildInstagramProfile() });

      const response = await connect({ token: team.memberToken });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).reason).toBe('missing_permission');
      expect(scopes.some((scope) => scope.isDone())).toBe(false);
    });

    it("refuses a personal organization's Owner with 403 — they hold none of the codes (AC-1.9)", async () => {
      const owner = await createTestUser();
      const { organization } = await provisionOrganizationWithOwner({
        name: 'Personal',
        slug: null,
        type: 'PERSONAL',
        ownerUserId: owner.id,
      });
      const token = await generateTestToken({
        userId: owner.public_id,
        organizationPublicId: organization.public_id,
      });

      const response = await connect({ token });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).reason).toBe('missing_permission');
    });

    it('answers 422 on a personal organization even with the code, before any Instagram call (IA3)', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes();
      const scopes = mockInstagramConnect({ profile: buildInstagramProfile() });

      const response = await connect({ token: personal.token });

      expect(response.statusCode).toBe(422);
      expect(errorOf(response).code).toBe('unprocessable_entity');
      expect(scopes.some((scope) => scope.isDone())).toBe(false);
      expect(await readInstagramAccountRows(personal.organization.id)).toEqual([]);
    });

    it('answers 422 instagram_code_invalid when Instagram refuses the code, storing nothing', async () => {
      nock(INSTAGRAM_AUTHORIZATION_BASE_URL).post('/oauth/access_token').reply(400, {
        error_type: 'OAuthException',
        code: 400,
        error_message: 'Matching code was not found or was already used',
      });

      const response = await connect({ token: team.ownerToken });

      expect(response.statusCode).toBe(422);
      expect(errorOf(response).reason).toBe('instagram_code_invalid');
      expect(errorOf(response).detail).toBeTruthy();
      expect(await readInstagramAccountRows(team.organization.id)).toEqual([]);
    });

    it('answers 422 instagram_account_not_professional for a personal Instagram account, storing nothing', async () => {
      mockInstagramConnect({
        profile: buildInstagramProfile({ account_type: 'PERSONAL' }),
        subscription: 'none',
      });

      const response = await connect({ token: team.ownerToken });

      expect(response.statusCode).toBe(422);
      expect(errorOf(response).reason).toBe('instagram_account_not_professional');
      expect(await readInstagramAccountRows(team.organization.id)).toEqual([]);
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toEqual([]);
    });

    it('answers 422 instagram_scopes_missing when a needed permission was not granted, storing nothing', async () => {
      mockInstagramConnect({
        profile: buildInstagramProfile(),
        grantedPermissions: ['instagram_business_basic', 'instagram_business_manage_comments'],
        subscription: 'none',
      });

      const response = await connect({ token: team.ownerToken });

      expect(response.statusCode).toBe(422);
      expect(errorOf(response).reason).toBe('instagram_scopes_missing');
      expect(await readInstagramAccountRows(team.organization.id)).toEqual([]);
    });

    it('answers 409 organization_already_has_instagram_account while another account is live here (AC-2.5)', async () => {
      const first = await connectAccount(buildInstagramProfile());
      mockInstagramConnect({ profile: buildInstagramProfile(), subscription: 'none' });

      const response = await connect({ token: team.ownerToken });

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).reason).toBe('organization_already_has_instagram_account');
      const rows = await readInstagramAccountRows(team.organization.id);
      expect(rows.map((row) => row.public_id)).toEqual([first.id]);
    });

    it('answers 409 instagram_account_connected_elsewhere when the account is live in another organization (AC-2.6)', async () => {
      const profile = buildInstagramProfile();
      await connectAccount(profile);
      const otherTeam = await createInstagramTeam();
      mockInstagramConnect({ profile, subscription: 'none' });

      const response = await connect({ token: otherTeam.ownerToken });

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).reason).toBe('instagram_account_connected_elsewhere');
      expect(await readInstagramAccountRows(otherTeam.organization.id)).toEqual([]);
      const [held] = await readInstagramAccountRows(team.organization.id);
      expect(held?.connection_status).toBe('connected');
    });

    it('maps a lost race on the cross-organization live index to 409 instagram_account_connected_elsewhere', async () => {
      const profile = buildInstagramProfile();
      await connectAccount(profile);
      const otherTeam = await createInstagramTeam();
      // The resolver ran before the first organization committed: only the unique index decides.
      vi.spyOn(
        InstagramAccountRepository.prototype,
        'resolveOrganizationPublicIdForInstagramUser',
      ).mockResolvedValue(null);
      mockInstagramConnect({ profile, subscription: 'none' });

      const response = await connect({ token: otherTeam.ownerToken });

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).reason).toBe('instagram_account_connected_elsewhere');
      expect(await readInstagramAccountRows(otherTeam.organization.id)).toEqual([]);
    });

    it('maps a lost race on the per-organization live index to 409 organization_already_has_instagram_account', async () => {
      await connectAccount(buildInstagramProfile());
      // Another connect committed between this connect's live-account check and its write.
      vi.spyOn(InstagramAccountRepository.prototype, 'findLiveByOrganizationId').mockResolvedValue(
        null,
      );
      mockInstagramConnect({ profile: buildInstagramProfile(), subscription: 'none' });

      const response = await connect({ token: team.ownerToken });

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).reason).toBe('organization_already_has_instagram_account');
      expect(await readInstagramAccountRows(team.organization.id)).toHaveLength(1);
    });

    it('answers 503 instagram_unavailable with Instagram’s Retry-After when it throttles, storing nothing', async () => {
      nock(INSTAGRAM_AUTHORIZATION_BASE_URL)
        .post('/oauth/access_token')
        .reply(
          429,
          { error: { message: '(#4) Application request limit reached', code: 4 } },
          { 'Retry-After': '120' },
        );

      const response = await connect({ token: team.ownerToken });

      expect(response.statusCode).toBe(503);
      expect(errorOf(response).reason).toBe('instagram_unavailable');
      expect(response.headers['retry-after']).toBe('120');
      expect(await readInstagramAccountRows(team.organization.id)).toEqual([]);
    });

    it('answers 503 instagram_unavailable with a Retry-After when Instagram fails, storing nothing', async () => {
      // The code exchange fails, so the one-time code may still pass (a later call: 409, D56).
      nock(INSTAGRAM_AUTHORIZATION_BASE_URL)
        .post('/oauth/access_token')
        .reply(500, { error: { message: 'An unexpected error has occurred.', code: 2 } });

      const response = await connect({ token: team.ownerToken });

      expect(response.statusCode).toBe(503);
      expect(errorOf(response).reason).toBe('instagram_unavailable');
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      expect(await readInstagramAccountRows(team.organization.id)).toEqual([]);
    });

    it('answers 409 instagram_connect_restart_required without a Retry-After when Instagram fails once the code is spent, storing nothing (D56)', async () => {
      nock(INSTAGRAM_AUTHORIZATION_BASE_URL).post('/oauth/access_token').reply(200, {
        access_token: 'IGAA-short',
        permissions: 'instagram_business_basic',
      });
      nock(INSTAGRAM_GRAPH_BASE_URL)
        .get('/access_token')
        .query(true)
        .reply(200, { access_token: 'IGAA-long', expires_in: 5_184_000 })
        .get(`/${INSTAGRAM_GRAPH_API_VERSION}/me`)
        .query(true)
        .reply(500, { error: { message: 'An unexpected error has occurred.', code: 2 } });

      const response = await connect({ token: team.ownerToken });

      expect(response.statusCode).toBe(409);
      expect(errorOf(response)).toMatchObject({
        code: 'conflict',
        reason: 'instagram_connect_restart_required',
        detail: enErrors.instagramConnectRestartRequired,
      });
      expect(response.headers['retry-after']).toBeUndefined();
      expect(await readInstagramAccountRows(team.organization.id)).toEqual([]);
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toEqual([]);
    });

    it('keeps a connected account as it is when a reconnect fails once the code is spent (D56)', async () => {
      const profile = buildInstagramProfile();
      await connectAccount(profile);
      const tokensBefore = await readInstagramTokenCiphertexts(team.organization.id);
      nock(INSTAGRAM_AUTHORIZATION_BASE_URL).post('/oauth/access_token').reply(200, {
        access_token: 'IGAA-short',
        permissions: 'instagram_business_basic',
      });
      nock(INSTAGRAM_GRAPH_BASE_URL)
        .get('/access_token')
        .query(true)
        .reply(500, { error: { message: 'An unexpected error has occurred.', code: 2 } });

      const response = await connect({ token: team.ownerToken });

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).reason).toBe('instagram_connect_restart_required');
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('connected');
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toEqual(tokensBefore);
    });

    it('connects nothing when a read for the answer fails: the transaction rolls back (D56)', async () => {
      const profile = buildInstagramProfile();
      mockInstagramConnect({ profile, subscription: 'none' });
      vi.spyOn(
        app.tenancyDomain.organizationService,
        'resolveUserPublicIdsByInternalIds',
      ).mockRejectedValueOnce(new Error('the read failed'));

      const response = await connect({ token: team.ownerToken });

      expect(response.statusCode).toBe(500);
      expect(await readInstagramAccountRows(team.organization.id)).toEqual([]);
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toEqual([]);
    });

    it('answers 503 instagram_not_configured, with its reason, when the Instagram app is not set (D34)', async () => {
      const savedAppId = process.env.INSTAGRAM_APP_ID;
      delete process.env.INSTAGRAM_APP_ID;
      resetEnvCacheForTests();
      try {
        const response = await connect({ token: team.ownerToken });

        expect(response.statusCode).toBe(503);
        expect(errorOf(response).code).toBe('service_unavailable');
        expect(errorOf(response).reason).toBe('instagram_not_configured');
      } finally {
        process.env.INSTAGRAM_APP_ID = savedAppId;
        resetEnvCacheForTests();
      }
    });

    it('answers 422 without an X-Idempotency-Key, before any Instagram call (K3)', async () => {
      const scopes = mockInstagramConnect({ profile: buildInstagramProfile() });

      const response = await connect({ token: team.ownerToken, idempotencyKey: null });

      expect(response.statusCode).toBe(422);
      expect(scopes.some((scope) => scope.isDone())).toBe(false);
    });

    it('answers 422 for a malformed X-Idempotency-Key', async () => {
      const response = await connect({ token: team.ownerToken, idempotencyKey: 'short' });

      expect(response.statusCode).toBe(422);
    });

    it('answers 409 while the same key is still running (K3)', async () => {
      const idempotencyKey = `ig-connect-${generatePublicId('instagramAccount')}`;
      const code = 'AQB-in-flight-code';
      const cacheKey = buildIdempotencyCacheKey({
        idempotencyKey,
        scope: { userId: team.owner.public_id, organizationId: team.organization.public_id },
      });
      seededIdempotencyKeys.push(cacheKey);
      await redisConnection.set(
        cacheKey,
        buildInFlightIdempotencyEntry({
          method: 'POST',
          routePath: INSTAGRAM_CONNECT_PATH,
          body: { code },
        }),
        'EX',
        60,
      );

      const response = await connect({ token: team.ownerToken, code, idempotencyKey });

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe('conflict_in_flight');
    });

    it('replays the first answer on a repeated key and the same code, without calling Instagram again (K3)', async () => {
      const idempotencyKey = `ig-connect-${generatePublicId('instagramAccount')}`;
      const code = 'AQB-replayed-code#_';
      const scopes = mockInstagramConnect({ profile: buildInstagramProfile() });
      const first = await connect({ token: team.ownerToken, code, idempotencyKey });
      expect(first.statusCode).toBe(200);
      expect(scopes.every((scope) => scope.isDone())).toBe(true);
      expect(first.headers['x-idempotency-replay']).toBeUndefined();
      // Nothing in the answer names a token or a secret, so the engine stores it (D35).
      expect(responseBodyContainsSecretFields(first.body)).toBe(false);

      // A second connect would need these; the replay must leave every one unused.
      const secondScopes = mockInstagramConnect({ profile: buildInstagramProfile() });
      const replay = await connect({ token: team.ownerToken, code, idempotencyKey });

      expect(replay.statusCode).toBe(200);
      expect(replay.headers['x-idempotency-replay']).toBe('true');
      expect(replay.body).toBe(first.body);
      expect(secondScopes.some((scope) => scope.isDone())).toBe(false);
      expect(await readInstagramAccountRows(team.organization.id)).toHaveLength(1);
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toHaveLength(1);
      expect(
        await readStagedAuditRows({
          organizationPublicId: team.organization.public_id,
          action: 'app.instagram_account.connect',
        }),
      ).toHaveLength(1);
    });

    it('answers 422 when a key is reused with another code after the first answer (K3)', async () => {
      const idempotencyKey = `ig-connect-${generatePublicId('instagramAccount')}`;
      mockInstagramConnect({ profile: buildInstagramProfile() });
      const first = await connect({
        token: team.ownerToken,
        code: 'AQB-first-code',
        idempotencyKey,
      });
      expect(first.statusCode).toBe(200);

      const scopes = mockInstagramConnect({ profile: buildInstagramProfile() });
      const response = await connect({
        token: team.ownerToken,
        code: 'AQB-second-code',
        idempotencyKey,
      });

      expect(response.statusCode).toBe(422);
      expect(errorOf(response).code).toBe('idempotency_key_reuse');
      expect(scopes.some((scope) => scope.isDone())).toBe(false);
    });

    it('answers 422 when a key still running is reused with another code (K3)', async () => {
      const idempotencyKey = `ig-connect-${generatePublicId('instagramAccount')}`;
      const cacheKey = buildIdempotencyCacheKey({
        idempotencyKey,
        scope: { userId: team.owner.public_id, organizationId: team.organization.public_id },
      });
      seededIdempotencyKeys.push(cacheKey);
      await redisConnection.set(
        cacheKey,
        buildInFlightIdempotencyEntry({
          method: 'POST',
          routePath: INSTAGRAM_CONNECT_PATH,
          body: { code: 'AQB-first-code' },
        }),
        'EX',
        60,
      );

      const response = await connect({
        token: team.ownerToken,
        code: 'AQB-second-code',
        idempotencyKey,
      });

      expect(response.statusCode).toBe(422);
    });
  });

  describe('GET /app/social/instagram/account (route 2)', () => {
    it('returns the connected account with its settings — never the token', async () => {
      const profile = buildInstagramProfile();
      const connected = await connectAccount(profile);

      const response = await injectAuthenticated(app, {
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(TEST_INSTAGRAM_LONG_LIVED_TOKEN);
      const { data } = response.json() as { data: Record<string, unknown> };
      expect(data).toEqual(connected);
    });

    it('lets a Member read it (AC-1.7)', async () => {
      const connected = await connectAccount(buildInstagramProfile());

      const response = await injectAuthenticated(app, {
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.memberToken,
      });

      expect(response.statusCode).toBe(200);
      expect((response.json() as { data: { id: string } }).data.id).toBe(connected.id);
    });

    it('still returns an expired account, so the page shows the reconnect card (IA13)', async () => {
      const connected = await connectAccount(buildInstagramProfile());
      const [row] = await readInstagramAccountRows(team.organization.id);
      const broken = await app.appDomain.instagramAccountService.markConnectionBroken({
        scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: team.organization.public_id }),
        instagramAccount: {
          organizationId: team.organization.id,
          instagramAccountId: Number(row?.id),
        },
        connectionStatus: 'expired',
      });
      expect(broken?.connection_status).toBe('expired');

      const response = await injectAuthenticated(app, {
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });

      expect(response.statusCode).toBe(200);
      const { data } = response.json() as { data: { id: string; connection_status: string } };
      expect(data).toMatchObject({ id: connected.id, connection_status: 'expired' });
    });

    it('answers 404 instagram_not_connected when no account was ever connected', async () => {
      const response = await injectAuthenticated(app, {
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('instagram_not_connected');
    });

    it("never shows another organization's account (404 instagram_not_connected)", async () => {
      await connectAccount(buildInstagramProfile());
      const otherTeam = await createInstagramTeam();

      const response = await injectAuthenticated(app, {
        url: INSTAGRAM_ACCOUNT_PATH,
        token: otherTeam.ownerToken,
      });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('instagram_not_connected');
    });

    it('answers 404 team_organization_required on a personal organization, even with the code (IA3)', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes();

      const response = await injectAuthenticated(app, {
        url: INSTAGRAM_ACCOUNT_PATH,
        token: personal.token,
      });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('team_organization_required');
    });

    it('answers 403 missing_permission to a caller without instagram-account:read', async () => {
      const owner = await createTestUser();
      const { organization } = await provisionOrganizationWithOwner({
        name: 'Personal',
        slug: null,
        type: 'PERSONAL',
        ownerUserId: owner.id,
      });
      const token = await generateTestToken({
        userId: owner.public_id,
        organizationPublicId: organization.public_id,
      });

      const response = await injectAuthenticated(app, { url: INSTAGRAM_ACCOUNT_PATH, token });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).reason).toBe('missing_permission');
    });
  });

  describe('DELETE /app/social/instagram/account (route 4)', () => {
    it('disconnects: revoked, token erased, settings and profile kept, audit staged — and 204', async () => {
      const profile = buildInstagramProfile();
      const connected = await connectAccount(profile);
      const unsubscribe = mockInstagramUnsubscribe({ instagramAppUserId: profile.id });

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      expect(unsubscribe.isDone()).toBe(true);
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row).toMatchObject({
        public_id: connected.id,
        connection_status: 'revoked',
        username: profile.username,
        token_expires_at: null,
        webhook_subscribed_at: null,
      });
      expect(row?.disconnected_at).not.toBeNull();
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toEqual([]);
      expect(await readInstagramSettingsRows(team.organization.id)).toHaveLength(1);
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.instagram_account.disconnect',
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        severity: 'WARNING',
        resource_type: 'instagram_account',
        metadata: { instagram_account_public_id: connected.id },
      });

      const read = await injectAuthenticated(app, {
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });
      expect(read.statusCode).toBe(404);
      expect(errorOf(read).reason).toBe('instagram_not_connected');
    });

    it('still disconnects when the unsubscribe fails', async () => {
      const profile = buildInstagramProfile();
      await connectAccount(profile);
      mockInstagramUnsubscribe({ instagramAppUserId: profile.id, outcome: 'failure' });

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });

      expect(response.statusCode).toBe(204);
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('revoked');
    });

    it('answers 404 instagram_not_connected with nothing connected, and again after a disconnect', async () => {
      const none = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });
      expect(none.statusCode).toBe(404);
      expect(errorOf(none).reason).toBe('instagram_not_connected');

      const profile = buildInstagramProfile();
      await connectAccount(profile);
      mockInstagramUnsubscribe({ instagramAppUserId: profile.id });
      const first = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });
      expect(first.statusCode).toBe(204);

      const again = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });
      expect(again.statusCode).toBe(404);
      expect(errorOf(again).reason).toBe('instagram_not_connected');
    });

    it('refuses a Member with 403 missing_permission and leaves the account connected (AC-1.7)', async () => {
      await connectAccount(buildInstagramProfile());

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.memberToken,
      });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).reason).toBe('missing_permission');
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('connected');
    });

    it('answers 422 on a personal organization, even with the code (IA3)', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes();

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: personal.token,
      });

      expect(response.statusCode).toBe(422);
      expect(errorOf(response).code).toBe('unprocessable_entity');
    });

    it("never touches another organization's account", async () => {
      await connectAccount(buildInstagramProfile());
      const otherTeam = await createInstagramTeam();

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: otherTeam.ownerToken,
      });

      expect(response.statusCode).toBe(404);
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('connected');
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toHaveLength(1);
    });
  });

  describe('a read-only plan (D27, AC-2.25)', () => {
    const enforced = env.BILLING_READ_ONLY_ENFORCED;

    afterEach(() => {
      env.BILLING_READ_ONLY_ENFORCED = enforced;
    });

    it('leaves connect, the settings change and disconnect open — only the automation writes are refused', async () => {
      await endTrialWithoutPaying(team.organization.id);
      env.BILLING_READ_ONLY_ENFORCED = true;

      const profile = buildInstagramProfile();
      const account = await connectAccount(profile);
      expect(account.connection_status).toBe('connected');

      const changed = await injectAuthenticated(app, {
        method: 'PATCH',
        url: INSTAGRAM_ACCOUNT_SETTINGS_PATH,
        token: team.ownerToken,
        payload: { is_automation_enabled: false },
      });
      expect(changed.statusCode).toBe(200);
      expect(await readInstagramSettingsRows(team.organization.id)).toEqual([
        expect.objectContaining({ is_automation_enabled: false }),
      ]);

      // The plan is read-only all along: creating an automation on that account is refused.
      const refused = await injectAuthenticated(app, {
        method: 'POST',
        url: AUTOMATIONS_PATH,
        token: team.ownerToken,
        payload: commentAutomationBody(),
        headers: { 'x-idempotency-key': `ig-read-only-${generatePublicId('automation')}` },
      });
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused).reason).toBe('organization_read_only');

      mockInstagramUnsubscribe({ instagramAppUserId: profile.id });
      const disconnected = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });
      expect(disconnected.statusCode).toBe(204);
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('revoked');

      // A reconnect is a connect too.
      const reconnected = await connectAccount(profile);
      expect(reconnected).toMatchObject({ id: account.id, connection_status: 'connected' });
    });
  });

  describe('markConnectionBroken (IA9)', () => {
    it('moves a connected account once; a second call loses the race and changes nothing', async () => {
      await connectAccount(buildInstagramProfile());
      const [row] = await readInstagramAccountRows(team.organization.id);
      const target = {
        scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: team.organization.public_id }),
        instagramAccount: {
          organizationId: team.organization.id,
          instagramAccountId: Number(row?.id),
        },
      };

      const first = await app.appDomain.instagramAccountService.markConnectionBroken({
        ...target,
        connectionStatus: 'error',
      });
      const second = await app.appDomain.instagramAccountService.markConnectionBroken({
        ...target,
        connectionStatus: 'expired',
      });

      expect(first?.connection_status).toBe('error');
      expect(second).toBeNull();
      const [after] = await operatorQuery<Array<{ connection_status: string }>>`
        SELECT connection_status FROM app.instagram_accounts WHERE id = ${Number(row?.id)}`;
      expect(after?.connection_status).toBe('error');
    });
  });
});
