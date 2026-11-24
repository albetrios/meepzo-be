import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
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
  buildInstagramProfile,
  createInstagramTeam,
  createPersonalOrganizationWithInstagramCodes,
  mockInstagramConnect,
  mockInstagramUnsubscribe,
  readInstagramAccountRows,
  readStagedAuditRows,
  type InstagramTeamFixture,
  type TestInstagramProfile,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';

/** The settings object route 3 answers (1.B.6). */
interface SettingsAnswer {
  is_automation_enabled: boolean;
  is_public_reply_safety_enabled: boolean;
  public_reply_chance_percent: number;
  public_reply_hour_limit: number;
  public_reply_gap_min_seconds: number;
  public_reply_gap_max_seconds: number;
  updated_by_user_id: string | null;
  updated_at: string;
}

/** The six settings as connect saves them (1.B.3). */
const DEFAULT_SETTINGS = {
  is_automation_enabled: true,
  is_public_reply_safety_enabled: false,
  public_reply_chance_percent: 80,
  public_reply_hour_limit: 60,
  public_reply_gap_min_seconds: 20,
  public_reply_gap_max_seconds: 60,
};

/** An organization's settings rows with every setting, read as the operator. */
async function readSettings(organizationId: number): Promise<
  Array<
    typeof DEFAULT_SETTINGS & {
      updated_by_user_id: string | null;
      updated_at: Date;
    }
  >
> {
  return operatorQuery`
    SELECT is_automation_enabled, is_public_reply_safety_enabled, public_reply_chance_percent,
           public_reply_hour_limit, public_reply_gap_min_seconds, public_reply_gap_max_seconds,
           updated_by_user_id, updated_at
    FROM app.instagram_account_settings WHERE organization_id = ${organizationId} ORDER BY id`;
}

/**
 * Route 3 — `PATCH /app/social/instagram/account/settings` (routes-final § 1.B, ROUTE R4) over
 * HTTP: the change and its answer, every 400 of 1.B.9, `404 instagram_not_connected`,
 * `409 record_changed`, team-only (`422`), the gate (Owner and Admin 200, Editor 403), an
 * `expired` account, another organization never touched, and the audit entry. Instagram is mocked
 * with nock for the connect only — route 3 never calls it.
 */
describe('Instagram account settings route (change)', () => {
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
    await metaGraphCircuit.reset();
  });

  /** Connects a fresh account for `fixture`'s Owner and returns its public id and profile. */
  async function connectAccount(
    fixture: InstagramTeamFixture = team,
  ): Promise<{ id: string; profile: TestInstagramProfile; settings: SettingsAnswer }> {
    const profile = buildInstagramProfile();
    mockInstagramConnect({ profile });
    const response = await injectAuthenticated(app, {
      method: 'POST',
      url: INSTAGRAM_CONNECT_PATH,
      token: fixture.ownerToken,
      payload: { code: 'AQB-test-authorization-code#_' },
      headers: { 'x-idempotency-key': `ig-settings-${generatePublicId('instagramAccount')}` },
    });
    expect(response.statusCode).toBe(200);
    const account = (
      response.json() as { data: { instagram_account: { id: string; settings: SettingsAnswer } } }
    ).data.instagram_account;
    return { id: account.id, profile, settings: account.settings };
  }

  function patchSettings({
    token = team.ownerToken,
    payload,
  }: {
    token?: string;
    payload: unknown;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'PATCH',
      url: INSTAGRAM_ACCOUNT_SETTINGS_PATH,
      token,
      payload,
    });
  }

  function errorOf(response: InjectHttpResult): {
    code?: string;
    reason?: string;
    errors?: Array<{ field: string; message: string }>;
  } {
    return (response.json() as { error: Record<string, never> }).error;
  }

  /** The `errors[].field` values of a 400, each without the `body.` location prefix. */
  function refusedFields(response: InjectHttpResult): string[] {
    return (errorOf(response).errors ?? []).map((item) => item.field.replace(/^body\./, ''));
  }

  async function settingsAudit(organizationPublicId = team.organization.public_id) {
    return readStagedAuditRows({
      organizationPublicId,
      action: 'app.instagram_account_settings.update',
    });
  }

  describe('success', () => {
    it('changes the settings sent, keeps the others, records who — and the account read shows it', async () => {
      const { id: accountId, settings: before } = await connectAccount();

      const response = await patchSettings({
        payload: {
          is_automation_enabled: false,
          is_public_reply_safety_enabled: true,
          public_reply_chance_percent: 0,
          public_reply_gap_max_seconds: 3600,
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      const { data } = response.json() as { data: SettingsAnswer };
      expect(data).toEqual({
        ...DEFAULT_SETTINGS,
        is_automation_enabled: false,
        is_public_reply_safety_enabled: true,
        public_reply_chance_percent: 0,
        public_reply_gap_max_seconds: 3600,
        updated_by_user_id: team.owner.public_id,
        updated_at: expect.any(String),
      });
      expect(Date.parse(data.updated_at)).toBeGreaterThanOrEqual(Date.parse(before.updated_at));

      const [row] = await readSettings(team.organization.id);
      expect(row).toMatchObject({
        is_automation_enabled: false,
        is_public_reply_safety_enabled: true,
        public_reply_chance_percent: 0,
        public_reply_hour_limit: 60,
        public_reply_gap_min_seconds: 20,
        public_reply_gap_max_seconds: 3600,
      });
      expect(Number(row?.updated_by_user_id)).toBe(team.owner.id);

      const read = await injectAuthenticated(app, {
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.editorToken,
      });
      expect(read.statusCode).toBe(200);
      const account = (read.json() as { data: { id: string; settings: SettingsAnswer } }).data;
      expect(account.id).toBe(accountId);
      expect(account.settings).toEqual(data);
    });

    it('writes one INFO audit entry naming the account and the changed fields — never the values', async () => {
      const { id: accountId, settings } = await connectAccount();

      const response = await patchSettings({
        payload: {
          public_reply_hour_limit: 1000,
          public_reply_gap_min_seconds: 5,
          expected_updated_at: settings.updated_at,
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      const audit = await settingsAudit();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        severity: 'INFO',
        resource_type: 'instagram_account',
        metadata: { instagram_account_public_id: accountId },
      });
      // `expected_updated_at` is not a change.
      expect([...((audit[0]?.metadata.changed_fields as string[]) ?? [])].sort()).toEqual([
        'public_reply_gap_min_seconds',
        'public_reply_hour_limit',
      ]);
      expect(JSON.stringify(audit[0]?.metadata)).not.toContain('1000');
    });

    it('lets an Admin change them', async () => {
      await connectAccount();

      const response = await patchSettings({
        token: team.adminToken,
        payload: { public_reply_hour_limit: 1 },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect((response.json() as { data: SettingsAnswer }).data.public_reply_hour_limit).toBe(1);
    });

    it('accepts a matching expected_updated_at, and a minimum equal to the maximum', async () => {
      const { settings } = await connectAccount();

      const response = await patchSettings({
        payload: { public_reply_gap_min_seconds: 60, expected_updated_at: settings.updated_at },
      });

      expect(response.statusCode, response.body).toBe(200);
      const { data } = response.json() as { data: SettingsAnswer };
      expect(data.public_reply_gap_min_seconds).toBe(60);
      expect(data.public_reply_gap_max_seconds).toBe(60);
    });

    it('works on an expired account, so automation can be turned off before a reconnect', async () => {
      await connectAccount();
      const [account] = await readInstagramAccountRows(team.organization.id);
      await app.appDomain.instagramAccountService.markConnectionBroken({
        scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: team.organization.public_id }),
        instagramAccount: {
          organizationId: team.organization.id,
          instagramAccountId: Number(account?.id),
        },
        connectionStatus: 'expired',
      });

      const response = await patchSettings({ payload: { is_automation_enabled: false } });

      expect(response.statusCode, response.body).toBe(200);
      expect((response.json() as { data: SettingsAnswer }).data.is_automation_enabled).toBe(false);
    });
  });

  describe('400 — the body', () => {
    it.each([
      ['public_reply_chance_percent', 101],
      ['public_reply_chance_percent', -1],
      ['public_reply_hour_limit', 0],
      ['public_reply_hour_limit', 1001],
      ['public_reply_gap_min_seconds', 4],
      ['public_reply_gap_max_seconds', 3601],
    ])(
      'refuses %s out of range (%d), naming the field and changing nothing',
      async (field, value) => {
        await connectAccount();

        const response = await patchSettings({ payload: { [field]: value } });

        expect(response.statusCode).toBe(400);
        expect(refusedFields(response)).toContain(field);
        const [row] = await readSettings(team.organization.id);
        expect(row).toMatchObject(DEFAULT_SETTINGS);
        expect(await settingsAudit()).toEqual([]);
      },
    );

    it('refuses a number that is not whole', async () => {
      await connectAccount();

      const response = await patchSettings({ payload: { public_reply_chance_percent: 50.5 } });

      expect(response.statusCode).toBe(400);
      expect(refusedFields(response)).toContain('public_reply_chance_percent');
    });

    it('refuses a switch that is not a boolean', async () => {
      await connectAccount();

      const response = await patchSettings({ payload: { is_automation_enabled: 'false' } });

      expect(response.statusCode).toBe(400);
      expect(refusedFields(response)).toContain('is_automation_enabled');
    });

    it('refuses an empty body', async () => {
      await connectAccount();

      const response = await patchSettings({ payload: {} });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('invalid_field');
    });

    it('refuses expected_updated_at alone', async () => {
      const { settings } = await connectAccount();

      const response = await patchSettings({
        payload: { expected_updated_at: settings.updated_at },
      });

      expect(response.statusCode).toBe(400);
    });

    it('refuses an unknown field, naming it', async () => {
      await connectAccount();

      const response = await patchSettings({
        payload: { is_automation_enabled: false, reply_text: 'Thanks for your comment' },
      });

      expect(response.statusCode).toBe(400);
      expect(refusedFields(response)).toContain('reply_text');
      const [row] = await readSettings(team.organization.id);
      expect(row?.is_automation_enabled).toBe(true);
    });

    it('refuses a minimum above the saved maximum, on public_reply_gap_max_seconds (the merged result)', async () => {
      await connectAccount();

      const response = await patchSettings({ payload: { public_reply_gap_min_seconds: 61 } });

      expect(response.statusCode).toBe(400);
      expect(refusedFields(response)).toEqual(['public_reply_gap_max_seconds']);
      const [row] = await readSettings(team.organization.id);
      expect(row).toMatchObject(DEFAULT_SETTINGS);
      expect(await settingsAudit()).toEqual([]);
    });

    it('refuses a minimum above the maximum sent together, on public_reply_gap_max_seconds', async () => {
      await connectAccount();

      const response = await patchSettings({
        payload: { public_reply_gap_min_seconds: 100, public_reply_gap_max_seconds: 50 },
      });

      expect(response.statusCode).toBe(400);
      expect(refusedFields(response)).toEqual(['public_reply_gap_max_seconds']);
    });
  });

  describe('404 / 409 / 422 / 403', () => {
    it('answers 404 instagram_not_connected when no account was ever connected', async () => {
      const response = await patchSettings({ payload: { is_automation_enabled: false } });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('instagram_not_connected');
      expect(await settingsAudit()).toEqual([]);
    });

    it('answers 404 instagram_not_connected once the account is disconnected (revoked)', async () => {
      const { profile } = await connectAccount();
      mockInstagramUnsubscribe({ instagramAppUserId: profile.id });
      const disconnected = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });
      expect(disconnected.statusCode).toBe(204);

      const response = await patchSettings({ payload: { is_automation_enabled: false } });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('instagram_not_connected');
      const [row] = await readSettings(team.organization.id);
      expect(row?.is_automation_enabled).toBe(true);
    });

    it('answers 409 record_changed when expected_updated_at is older than the saved settings', async () => {
      const { settings } = await connectAccount();
      const first = await patchSettings({
        token: team.adminToken,
        payload: { public_reply_chance_percent: 40 },
      });
      expect(first.statusCode).toBe(200);

      const stale = await patchSettings({
        payload: { public_reply_chance_percent: 90, expected_updated_at: settings.updated_at },
      });

      expect(stale.statusCode).toBe(409);
      expect(errorOf(stale).reason).toBe('record_changed');
      const [row] = await readSettings(team.organization.id);
      expect(row?.public_reply_chance_percent).toBe(40);
      expect(await settingsAudit()).toHaveLength(1);
    });

    it('answers 422 on a personal organization, even with the code (IA3)', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes();

      const response = await patchSettings({
        token: personal.token,
        payload: { is_automation_enabled: false },
      });

      expect(response.statusCode).toBe(422);
      expect(errorOf(response).code).toBe('unprocessable_entity');
    });

    it('refuses an Editor with 403 missing_permission and changes nothing (1.B.4)', async () => {
      await connectAccount();

      const response = await patchSettings({
        token: team.editorToken,
        payload: { is_automation_enabled: false },
      });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).reason).toBe('missing_permission');
      const [row] = await readSettings(team.organization.id);
      expect(row?.is_automation_enabled).toBe(true);
    });

    it("never touches another organization's settings", async () => {
      await connectAccount();
      const otherTeam = await createInstagramTeam();

      const withoutAccount = await patchSettings({
        token: otherTeam.ownerToken,
        payload: { is_automation_enabled: false },
      });
      expect(withoutAccount.statusCode).toBe(404);
      expect(errorOf(withoutAccount).reason).toBe('instagram_not_connected');

      await connectAccount(otherTeam);
      const own = await patchSettings({
        token: otherTeam.ownerToken,
        payload: { public_reply_hour_limit: 5 },
      });
      expect(own.statusCode).toBe(200);

      const [row] = await readSettings(team.organization.id);
      expect(row).toMatchObject(DEFAULT_SETTINGS);
      expect(row?.updated_by_user_id).toBeNull();
      expect(await settingsAudit()).toEqual([]);
      expect(await settingsAudit(otherTeam.organization.public_id)).toHaveLength(1);
    });
  });
});
