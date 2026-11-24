import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { channelAccountPath } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  injectAuthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  buildInstagramProfile,
  connectInstagramAccount,
  createInstagramTeam,
  createPersonalOrganizationWithInstagramCodes,
  instagramAccountSettingsPath,
  mockInstagramUnsubscribe,
  readInstagramSettingsRows,
  readStagedAuditRows,
  type InstagramTeamFixture,
  type TestInstagramProfile,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';

/** The settings object route 12 answers (2.B.6). */
interface SettingsAnswer {
  is_automation_enabled: boolean;
  opening_hour_limit: number | null;
  opening_day_limit: number | null;
  fast_hour_limit: number | null;
  person_hour_limit: number | null;
  broadcast_hour_limit: number | null;
  effective_limits: {
    opening_hour_limit: number;
    opening_day_limit: number | null;
    fast_hour_limit: number;
    person_hour_limit: number;
    broadcast_hour_limit: number;
  };
  is_day_limit_enabled: boolean;
  is_automatic_notice_enabled: boolean;
  extra_stop_words: string[];
  is_comment_reply_trigger_enabled: boolean;
  is_once_per_person_per_post_enabled: boolean;
  is_mark_seen_after_reply_enabled: boolean;
  extra_delay_seconds_min: number | null;
  extra_delay_seconds_max: number | null;
  updated_by_user_id: string | null;
  updated_at: string;
}

/** A new account's settings as the pick leaves them (AC-3.1) — a new account: 150 an hour (D5). */
const NEW_ACCOUNT_SETTINGS = {
  is_automation_enabled: true,
  opening_hour_limit: null,
  opening_day_limit: null,
  fast_hour_limit: null,
  person_hour_limit: null,
  broadcast_hour_limit: null,
  effective_limits: {
    opening_hour_limit: 150,
    opening_day_limit: null,
    fast_hour_limit: 10_000,
    person_hour_limit: 60,
    broadcast_hour_limit: 600,
  },
  is_day_limit_enabled: false,
  is_automatic_notice_enabled: false,
  extra_stop_words: [],
  is_comment_reply_trigger_enabled: true,
  is_once_per_person_per_post_enabled: true,
  is_mark_seen_after_reply_enabled: false,
  extra_delay_seconds_min: null,
  extra_delay_seconds_max: null,
  updated_by_user_id: null,
};

/** The launch's five public-reply fields — gone from the settings (AC-3.9). */
const REMOVED_PUBLIC_REPLY_FIELDS = [
  'is_public_reply_safety_enabled',
  'public_reply_chance_percent',
  'public_reply_hour_limit',
  'public_reply_gap_min_seconds',
  'public_reply_gap_max_seconds',
] as const;

/**
 * Route 12 — `PATCH /app/social/instagram/accounts/{channel_account_id}/settings`
 * (feat-instagram-dm-sending routes-final § 2.B, ROUTE row R7) over HTTP: the new account's
 * settings and effective limits, every error of 2.B.9, the null-clears-to-default case, the
 * automation switch landing on the channel account, the gate and the audit entry. Meta is mocked
 * with nock for the connect only — route 12 never calls it.
 */
describe('Instagram account settings route (route 12)', () => {
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

  /** Connects a fresh account for `fixture`'s Owner and returns its `cha_…` id and settings. */
  async function connectAccount(fixture: InstagramTeamFixture = team): Promise<{
    id: string;
    profile: TestInstagramProfile;
    settings: SettingsAnswer;
  }> {
    const profile = buildInstagramProfile();
    const { account } = await connectInstagramAccount({ app, token: fixture.ownerToken, profile });
    return { id: account.id, profile, settings: account.instagram.settings as SettingsAnswer };
  }

  /** Gives the team a plan with these features (Free or Creator, P83). */
  async function usePlan(features: typeof FREE_PLAN_FEATURES): Promise<void> {
    const plan = await createTestPlan({ features, priceMonthly: '29.00', priceYearly: '276.00' });
    await createTestSubscription({
      organizationId: team.organization.id,
      planId: plan.id,
      status: 'ACTIVE',
    });
  }

  function patchSettings({
    accountId,
    token = team.ownerToken,
    payload,
  }: {
    accountId: string;
    token?: string;
    payload: unknown;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'PATCH',
      url: instagramAccountSettingsPath(accountId),
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

  function dataOf(response: InjectHttpResult): SettingsAnswer {
    return (response.json() as { data: SettingsAnswer }).data;
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

  async function readAccount(
    accountId: string,
    token = team.ownerToken,
  ): Promise<InjectHttpResult> {
    return injectAuthenticated(app, { url: channelAccountPath(accountId), token });
  }

  describe('a new account and the read (AC-3.1, AC-3.10)', () => {
    it('reads the defaults, the effective limits of a new account and no public-reply field', async () => {
      const { settings } = await connectAccount();

      expect(settings).toEqual({ ...NEW_ACCOUNT_SETTINGS, updated_at: expect.any(String) });
      for (const field of REMOVED_PUBLIC_REPLY_FIELDS) expect(settings).not.toHaveProperty(field);
    });

    it('lets an Editor and a Viewer read the settings, and refuses them a change (missing_permission)', async () => {
      const { id } = await connectAccount();

      for (const token of [team.editorToken, team.viewerToken]) {
        const read = await readAccount(id, token);
        expect(read.statusCode).toBe(200);
        expect(
          (read.json() as { data: { instagram: { settings: SettingsAnswer } } }).data.instagram
            .settings.is_comment_reply_trigger_enabled,
        ).toBe(true);
        const refused = await patchSettings({
          accountId: id,
          token,
          payload: { is_automatic_notice_enabled: true },
        });
        expect(refused.statusCode).toBe(403);
        expect(errorOf(refused).reason).toBe('missing_permission');
      }
      expect(await settingsAudit()).toEqual([]);
    });
  });

  describe('success', () => {
    it('changes the fields sent, keeps the others, records who — and the account read shows it', async () => {
      const { id, settings: before } = await connectAccount();

      const response = await patchSettings({
        accountId: id,
        payload: {
          opening_hour_limit: 300,
          fast_hour_limit: 20_000,
          person_hour_limit: 100,
          broadcast_hour_limit: 2000,
          is_automatic_notice_enabled: true,
          extra_stop_words: ['  Band Karo ', 'PARAR'],
          is_comment_reply_trigger_enabled: false,
          is_once_per_person_per_post_enabled: false,
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      const data = dataOf(response);
      expect(data).toEqual({
        ...NEW_ACCOUNT_SETTINGS,
        opening_hour_limit: 300,
        fast_hour_limit: 20_000,
        person_hour_limit: 100,
        broadcast_hour_limit: 2000,
        effective_limits: {
          opening_hour_limit: 300,
          opening_day_limit: null,
          fast_hour_limit: 20_000,
          person_hour_limit: 100,
          broadcast_hour_limit: 2000,
        },
        is_automatic_notice_enabled: true,
        extra_stop_words: ['band karo', 'parar'],
        is_comment_reply_trigger_enabled: false,
        is_once_per_person_per_post_enabled: false,
        updated_by_user_id: team.owner.public_id,
        updated_at: expect.any(String),
      });
      expect(Date.parse(data.updated_at)).toBeGreaterThanOrEqual(Date.parse(before.updated_at));

      const read = await readAccount(id, team.editorToken);
      expect(
        (read.json() as { data: { instagram: { settings: SettingsAnswer } } }).data.instagram
          .settings,
      ).toEqual(data);
    });

    it('null clears a limit back to the settings file — and an old account uses 600 an hour (AC-3.2)', async () => {
      const { id } = await connectAccount();
      expect(
        dataOf(await patchSettings({ accountId: id, payload: { opening_hour_limit: 700 } }))
          .effective_limits.opening_hour_limit,
      ).toBe(700);

      const cleared = await patchSettings({ accountId: id, payload: { opening_hour_limit: null } });
      expect(cleared.statusCode).toBe(200);
      expect(dataOf(cleared)).toMatchObject({
        opening_hour_limit: null,
        effective_limits: { opening_hour_limit: 150 },
      });

      await operatorQuery`
        UPDATE app.channel_accounts SET connected_at = now() - interval '8 days'
        WHERE public_id = ${id}`;
      const old = await patchSettings({ accountId: id, payload: { fast_hour_limit: null } });
      expect(dataOf(old).effective_limits.opening_hour_limit).toBe(600);
    });

    it('turns the automation switch on the channel account, in the same save (P42)', async () => {
      const { id } = await connectAccount();

      const response = await patchSettings({
        accountId: id,
        payload: { is_automation_enabled: false, person_hour_limit: 5 },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(dataOf(response)).toMatchObject({
        is_automation_enabled: false,
        person_hour_limit: 5,
      });
      const [row] = await readInstagramSettingsRows(team.organization.id);
      expect(row?.is_automation_enabled).toBe(false);
      const read = await readAccount(id);
      expect((read.json() as { data: { is_automation_enabled: boolean } }).data).toMatchObject({
        is_automation_enabled: false,
      });
    });

    it('accepts a day limit from the hour limit to 24 times it, stored while the day limit is off', async () => {
      const { id } = await connectAccount();

      const response = await patchSettings({
        accountId: id,
        payload: { opening_hour_limit: 100, opening_day_limit: 2400 },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(dataOf(response)).toMatchObject({
        opening_day_limit: 2400,
        is_day_limit_enabled: false,
        effective_limits: { opening_day_limit: null },
      });
    });

    it('works on an account in error, so automation can be turned off before a reconnect', async () => {
      const { id } = await connectAccount();
      await operatorQuery`
        UPDATE app.channel_accounts SET connection_status = 'error' WHERE public_id = ${id}`;

      const response = await patchSettings({
        accountId: id,
        payload: { is_automation_enabled: false },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(dataOf(response).is_automation_enabled).toBe(false);
    });

    it('writes one INFO audit entry with the changed fields, their old and new values (AC-3.11)', async () => {
      const { id, settings } = await connectAccount();

      const response = await patchSettings({
        accountId: id,
        payload: {
          opening_hour_limit: 250,
          is_comment_reply_trigger_enabled: true,
          is_automation_enabled: false,
          expected_updated_at: settings.updated_at,
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      const audit = await settingsAudit();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        severity: 'INFO',
        resource_type: 'instagram_account',
        metadata: {
          channel_account_public_id: id,
          old_value: { opening_hour_limit: null, is_automation_enabled: true },
          new_value: { opening_hour_limit: 250, is_automation_enabled: false },
        },
      });
      // A field sent with its saved value and `expected_updated_at` are not changes.
      expect([...((audit[0]?.metadata.changed_fields as string[]) ?? [])].sort()).toEqual([
        'is_automation_enabled',
        'opening_hour_limit',
      ]);
    });
  });

  describe('400 — the body', () => {
    it.each([
      ['opening_hour_limit', 701],
      ['opening_hour_limit', 0],
      ['person_hour_limit', 4],
      ['person_hour_limit', 101],
      ['fast_hour_limit', 20_001],
      ['broadcast_hour_limit', 2001],
      ['extra_delay_seconds_min', 21],
      ['extra_delay_seconds_max', 0],
    ])(
      'refuses %s out of range (%d), naming the field and changing nothing (AC-3.2–AC-3.4)',
      async (field, value) => {
        const { id } = await connectAccount();

        const response = await patchSettings({ accountId: id, payload: { [field]: value } });

        expect(response.statusCode).toBe(400);
        expect(refusedFields(response)).toContain(field);
        expect(await settingsAudit()).toEqual([]);
      },
    );

    it.each(REMOVED_PUBLIC_REPLY_FIELDS)(
      'refuses the removed public-reply field %s (AC-3.9)',
      async (field) => {
        const { id } = await connectAccount();

        const response = await patchSettings({ accountId: id, payload: { [field]: 1 } });

        expect(response.statusCode).toBe(400);
        expect(refusedFields(response)).toContain(field);
      },
    );

    it.each([
      ['an empty word', ['  ']],
      ['a word over 50 characters', ['a'.repeat(51)]],
      ['a repeat once lower-cased', ['Stop', 'stop ']],
      ['more than 50 words', Array.from({ length: 51 }, (_, index) => `word${index}`)],
    ])('refuses extra_stop_words with %s', async (_case, words) => {
      const { id } = await connectAccount();

      const response = await patchSettings({ accountId: id, payload: { extra_stop_words: words } });

      expect(response.statusCode).toBe(400);
      expect(refusedFields(response).some((field) => field.startsWith('extra_stop_words'))).toBe(
        true,
      );
    });

    it('refuses a number that is not whole, an empty body and expected_updated_at alone', async () => {
      const { id, settings } = await connectAccount();

      const notWhole = await patchSettings({ accountId: id, payload: { fast_hour_limit: 10.5 } });
      expect(notWhole.statusCode).toBe(400);
      expect(refusedFields(notWhole)).toContain('fast_hour_limit');
      expect((await patchSettings({ accountId: id, payload: {} })).statusCode).toBe(400);
      expect(
        (
          await patchSettings({
            accountId: id,
            payload: { expected_updated_at: settings.updated_at },
          })
        ).statusCode,
      ).toBe(400);
    });

    it('refuses a day limit below the hour limit or above 24 times it', async () => {
      const { id } = await connectAccount();

      const below = await patchSettings({ accountId: id, payload: { opening_day_limit: 599 } });
      expect(below.statusCode).toBe(400);
      expect(refusedFields(below)).toEqual(['opening_day_limit']);
      const above = await patchSettings({
        accountId: id,
        payload: { opening_hour_limit: 10, opening_day_limit: 241 },
      });
      expect(above.statusCode).toBe(400);
      expect(refusedFields(above)).toEqual(['opening_day_limit']);
    });
  });

  describe('the extra delay (PRO, P83) and mark as seen (P36) — the one feature check', () => {
    it('on Free: setting the extra delay is refused with 403 plan_lacks_feature; clearing it is allowed (AC-3.4)', async () => {
      await usePlan(FREE_PLAN_FEATURES);
      const { id } = await connectAccount();

      const refused = await patchSettings({
        accountId: id,
        payload: { extra_delay_seconds_min: 2, extra_delay_seconds_max: 5 },
      });
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused).reason).toBe('plan_lacks_feature');
      const cleared = await patchSettings({
        accountId: id,
        payload: { extra_delay_seconds_min: null, extra_delay_seconds_max: null },
      });
      expect(cleared.statusCode, cleared.body).toBe(200);
    });

    it('on Creator: the delay saves; min above max, or one end alone, is a 400 (AC-3.4)', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      const { id } = await connectAccount();

      const saved = await patchSettings({
        accountId: id,
        payload: { extra_delay_seconds_min: 2, extra_delay_seconds_max: 20 },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(dataOf(saved)).toMatchObject({
        extra_delay_seconds_min: 2,
        extra_delay_seconds_max: 20,
      });

      const aboveMax = await patchSettings({
        accountId: id,
        payload: { extra_delay_seconds_min: 21 },
      });
      expect(aboveMax.statusCode).toBe(400);
      const minAboveMax = await patchSettings({
        accountId: id,
        payload: { extra_delay_seconds_min: 10, extra_delay_seconds_max: 5 },
      });
      expect(minAboveMax.statusCode).toBe(400);
      expect(refusedFields(minAboveMax)).toEqual(['extra_delay_seconds_max']);
      const oneEnd = await patchSettings({
        accountId: id,
        payload: { extra_delay_seconds_max: null },
      });
      expect(oneEnd.statusCode).toBe(400);
      expect(refusedFields(oneEnd)).toEqual(['extra_delay_seconds_max']);
    });

    it('turning mark as seen on while untested is refused with 422 feature_not_offered; off is fine (AC-3.5)', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      const { id } = await connectAccount();

      const refused = await patchSettings({
        accountId: id,
        payload: { is_mark_seen_after_reply_enabled: true },
      });
      expect(refused.statusCode).toBe(422);
      expect(errorOf(refused).reason).toBe('feature_not_offered');
      const off = await patchSettings({
        accountId: id,
        payload: { is_mark_seen_after_reply_enabled: false },
      });
      expect(off.statusCode, off.body).toBe(200);
    });

    it('answers 409 permission_not_granted when the connection lacks the feature’s permission', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      const { id } = await connectAccount();
      await operatorQuery`
        UPDATE app.channel_connections
        SET scopes = array_remove(scopes, 'instagram_manage_messages')
        WHERE organization_id = ${team.organization.id}`;

      const refused = await patchSettings({
        accountId: id,
        payload: { is_mark_seen_after_reply_enabled: true },
      });

      expect(refused.statusCode).toBe(409);
      expect(errorOf(refused).reason).toBe('permission_not_granted');
    });
  });

  describe('404 / 409 / 422', () => {
    it('answers 404 channel_account_not_found for an unknown, a revoked or another organization’s account', async () => {
      const { id, profile } = await connectAccount();
      const otherTeam = await createInstagramTeam();

      const foreign = await patchSettings({
        accountId: id,
        token: otherTeam.ownerToken,
        payload: { is_automatic_notice_enabled: true },
      });
      expect(foreign.statusCode).toBe(404);
      expect(errorOf(foreign).reason).toBe('channel_account_not_found');
      const unknown = await patchSettings({
        accountId: `cha_${'0'.repeat(21)}`,
        payload: { is_automatic_notice_enabled: true },
      });
      expect(unknown.statusCode).toBe(404);

      mockInstagramUnsubscribe({ instagramUserId: profile.id });
      const disconnected = await injectAuthenticated(app, {
        method: 'DELETE',
        url: channelAccountPath(id),
        token: team.ownerToken,
      });
      expect(disconnected.statusCode).toBe(204);
      const revoked = await patchSettings({
        accountId: id,
        payload: { is_automatic_notice_enabled: true },
      });
      expect(revoked.statusCode).toBe(404);
      expect(errorOf(revoked).reason).toBe('channel_account_not_found');
      expect(await settingsAudit()).toEqual([]);
      expect(await settingsAudit(otherTeam.organization.public_id)).toEqual([]);
    });

    it('answers 409 record_changed when expected_updated_at is older than the saved settings', async () => {
      const { id, settings } = await connectAccount();
      const first = await patchSettings({
        accountId: id,
        token: team.adminToken,
        payload: { person_hour_limit: 40 },
      });
      expect(first.statusCode).toBe(200);

      const stale = await patchSettings({
        accountId: id,
        payload: { person_hour_limit: 90, expected_updated_at: settings.updated_at },
      });

      expect(stale.statusCode).toBe(409);
      expect(errorOf(stale).reason).toBe('record_changed');
      const read = await readAccount(id);
      expect(
        (read.json() as { data: { instagram: { settings: SettingsAnswer } } }).data.instagram
          .settings.person_hour_limit,
      ).toBe(40);
      expect(await settingsAudit()).toHaveLength(1);
    });

    it('answers 422 on a personal organization, even with the code', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes();

      const response = await patchSettings({
        accountId: `cha_${'0'.repeat(21)}`,
        token: personal.token,
        payload: { is_automation_enabled: false },
      });

      expect(response.statusCode).toBe(422);
      expect(errorOf(response).code).toBe('unprocessable_entity');
    });
  });
});
