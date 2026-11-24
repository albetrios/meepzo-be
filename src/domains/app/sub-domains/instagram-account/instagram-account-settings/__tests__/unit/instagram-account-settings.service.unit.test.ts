import { describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
  ValidationError,
} from '@/shared/errors/index.js';
import type { ChannelFeature } from '@/domains/app/sub-domains/channel-account/channel-account-capabilities.constants.js';
import { channelAccountNotFoundError } from '@/domains/app/sub-domains/channel-account/channel-account-error.util.js';
import type { ChannelFeatureCheckResult } from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import type {
  InstagramAccountSettingsRepository,
  InstagramAccountSettingsRow,
} from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import type {
  InstagramAccountSettingsChanges,
  InstagramAccountSettingsChannelAccount,
  InstagramAccountSettingsChannelAccountPort,
} from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.types.js';
import { buildInstagramAccountSettingsRow } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/__tests__/factories/instagram-account-settings.factory.js';

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // The unit lane has no Postgres: the unit of work runs the callback directly.
    withAppDatabaseContext: vi.fn(
      async ({ callback }: { callback: (databaseHandle: unknown) => Promise<unknown> }) =>
        callback({}),
    ),
  };
});

/**
 * The settings service's own decisions (feat-instagram-dm-sending routes-final § 2.B, IA12–IA14)
 * with the repository, the channel account port, the lane port and the organization service faked:
 * which row a pick gets back, route 12's checks in their order, the feature checks only for what a
 * change turns on, the switch written through the channel account, the changed fields with their
 * old and new values, and the lane wake after a limit change. The rows themselves are in
 * `instagram-account-settings.service.db.unit.test.ts`.
 */

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const EDITOR_PUBLIC_ID = 'usr_a1b2c3d4e5f6g7h8i9j0k';
const CALLER_PUBLIC_ID = 'usr_z9y8x7w6v5u4t3s2r1q0p';
const EDITOR_ID = 11;
const CALLER_ID = 12;
const scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: ORGANIZATION_PUBLIC_ID });
const TEAM = { id: 7, public_id: ORGANIZATION_PUBLIC_ID, type: 'TEAM' };
const ACCOUNT: InstagramAccountSettingsChannelAccount = {
  id: 5,
  public_id: 'cha_k7x9m2pqr4w8n1v3a1b2c',
  is_automation_enabled: true,
  connected_at: new Date('2026-11-01T08:00:00.000Z'),
};
const channelAccount = { organizationId: TEAM.id, channelAccountId: ACCOUNT.id };
const SAVED_AT = new Date('2026-11-21T08:30:00.000Z');

function settingsRow(
  overrides: Partial<InstagramAccountSettingsRow> = {},
): InstagramAccountSettingsRow {
  return buildInstagramAccountSettingsRow({
    organization_id: TEAM.id,
    channel_account_id: ACCOUNT.id,
    updated_by_user_id: EDITOR_ID,
    updated_at: SAVED_AT,
    ...overrides,
  });
}

function setup({
  organizationType = 'TEAM',
  saved = settingsRow() as InstagramAccountSettingsRow | null,
  refusals = {},
}: {
  organizationType?: 'TEAM' | 'PERSONAL';
  saved?: InstagramAccountSettingsRow | null;
  /** The feature check's answer per feature; allowed when absent. */
  refusals?: Partial<Record<ChannelFeature, ChannelFeatureCheckResult>>;
} = {}) {
  const settingsRepository = {
    insertDefaults: vi.fn(async (): Promise<InstagramAccountSettingsRow | null> => settingsRow()),
    findByChannelAccount: vi.fn(async () => saved),
    findByChannelAccountForUpdate: vi.fn(async () => saved),
    update: vi.fn(
      async ({
        changes,
        updatedByUserId,
      }: {
        changes: InstagramAccountSettingsChanges;
        updatedByUserId: number | null;
      }): Promise<InstagramAccountSettingsRow | null> =>
        settingsRow({
          ...(saved ?? {}),
          ...(changes as Partial<InstagramAccountSettingsRow>),
          updated_by_user_id: updatedByUserId,
          updated_at: new Date('2026-11-21T10:00:00.000Z'),
        }),
    ),
  };
  const channelAccountPort = {
    requireLiveInstagramAccount: vi.fn(async () => ACCOUNT),
    setAutomationEnabled: vi.fn(
      async ({ isAutomationEnabled }: { isAutomationEnabled: boolean }) => ({
        ...ACCOUNT,
        is_automation_enabled: isAutomationEnabled,
      }),
    ),
    canChannelAccountUseFeature: vi.fn(
      async ({ feature }: { feature: ChannelFeature }): Promise<ChannelFeatureCheckResult> =>
        refusals[feature] ?? { isAllowed: true },
    ),
  };
  const lanePort = { wakeLanes: vi.fn(async () => undefined) };
  const organizationService = {
    requireOrganizationByPublicId: vi.fn(async () => ({ ...TEAM, type: organizationType })),
    resolveUserPublicIdByInternalId: vi.fn(async (): Promise<string | null> => EDITOR_PUBLIC_ID),
    resolveUserInternalIdByPublicId: vi.fn(
      async (userPublicId: string | undefined): Promise<number | null> =>
        userPublicId === undefined ? null : CALLER_ID,
    ),
  };
  const service = new InstagramAccountSettingsService(
    settingsRepository as unknown as InstagramAccountSettingsRepository,
    channelAccountPort as unknown as InstagramAccountSettingsChannelAccountPort,
    organizationService as unknown as OrganizationService,
    lanePort,
  );
  return { service, settingsRepository, channelAccountPort, lanePort, organizationService };
}

/** Route 12's input: the caller is a user and no version is named, unless overridden. */
function updateInput(
  overrides: Partial<Parameters<InstagramAccountSettingsService['updateSettings']>[0]> = {},
): Parameters<InstagramAccountSettingsService['updateSettings']>[0] {
  return {
    scope,
    channelAccountPublicId: ACCOUNT.public_id,
    changes: { is_automatic_notice_enabled: true },
    isAutomationEnabled: undefined,
    expectedUpdatedAt: undefined,
    updatedByUserPublicId: CALLER_PUBLIC_ID,
    ...overrides,
  };
}

describe('InstagramAccountSettingsService', () => {
  describe('createDefaultSettings / findSettings (MC7)', () => {
    it('answers the inserted row on a first pick', async () => {
      const { service, settingsRepository } = setup();

      await expect(service.createDefaultSettings({ scope, channelAccount })).resolves.toMatchObject(
        { id: 91 },
      );
      expect(settingsRepository.insertDefaults).toHaveBeenCalledWith(channelAccount);
      expect(settingsRepository.findByChannelAccount).not.toHaveBeenCalled();
    });

    it('answers the kept row on a reconnect', async () => {
      const kept = settingsRow({ person_hour_limit: 30 });
      const { service, settingsRepository } = setup({ saved: kept });
      settingsRepository.insertDefaults.mockResolvedValueOnce(null);

      await expect(service.createDefaultSettings({ scope, channelAccount })).resolves.toBe(kept);
    });

    it('throws when neither the insert nor the read finds a row', async () => {
      const { service, settingsRepository } = setup({ saved: null });
      settingsRepository.insertDefaults.mockResolvedValueOnce(null);

      await expect(service.createDefaultSettings({ scope, channelAccount })).rejects.toThrow();
    });

    it('reads the row by the channel account', async () => {
      const { service, settingsRepository } = setup();

      await expect(service.findSettings({ scope, channelAccount })).resolves.toMatchObject({
        id: 91,
      });
      expect(settingsRepository.findByChannelAccount).toHaveBeenCalledWith(channelAccount);
    });
  });

  describe('updateSettings (route 12)', () => {
    it('writes the change with the caller, answers the settings and the changed fields', async () => {
      const { service, settingsRepository, channelAccountPort } = setup();

      const result = await service.updateSettings(
        updateInput({ changes: { opening_hour_limit: 300, is_automatic_notice_enabled: false } }),
      );

      expect(settingsRepository.update).toHaveBeenCalledWith({
        ...channelAccount,
        changes: { opening_hour_limit: 300, is_automatic_notice_enabled: false },
        updatedByUserId: CALLER_ID,
      });
      expect(channelAccountPort.setAutomationEnabled).not.toHaveBeenCalled();
      expect(channelAccountPort.canChannelAccountUseFeature).not.toHaveBeenCalled();
      expect(result.channelAccountPublicId).toBe(ACCOUNT.public_id);
      // The notice was already off: only the limit changed.
      expect(result.changes).toEqual({ opening_hour_limit: { old_value: null, new_value: 300 } });
      expect(result.settings).toMatchObject({
        is_automation_enabled: true,
        opening_hour_limit: 300,
        effective_limits: { opening_hour_limit: 300 },
        updated_by_user_id: CALLER_PUBLIC_ID,
        updated_at: '2026-11-21T10:00:00.000Z',
      });
    });

    it('writes the automation switch through the channel account (P42) and lists it as a change', async () => {
      const { service, channelAccountPort } = setup();

      const result = await service.updateSettings(
        updateInput({ changes: {}, isAutomationEnabled: false }),
      );

      expect(channelAccountPort.setAutomationEnabled).toHaveBeenCalledWith({
        scope,
        ...channelAccount,
        isAutomationEnabled: false,
      });
      expect(result.settings.is_automation_enabled).toBe(false);
      expect(result.changes).toEqual({
        is_automation_enabled: { old_value: true, new_value: false },
      });
    });

    it('lists stop words as a change only when the list differs', async () => {
      const { service } = setup({ saved: settingsRow({ extra_stop_words: ['parar'] }) });

      const same = await service.updateSettings(
        updateInput({ changes: { extra_stop_words: ['parar'] } }),
      );
      expect(same.changes).toEqual({});
      const changed = await service.updateSettings(
        updateInput({ changes: { extra_stop_words: ['parar', 'basta'] } }),
      );
      expect(changed.changes).toEqual({
        extra_stop_words: { old_value: ['parar'], new_value: ['parar', 'basta'] },
      });
    });

    it('names no editor for an API key', async () => {
      const { service, settingsRepository } = setup();

      const { settings } = await service.updateSettings(
        updateInput({ updatedByUserPublicId: undefined }),
      );

      expect(settingsRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ updatedByUserId: null }),
      );
      expect(settings.updated_by_user_id).toBeNull();
    });

    it('refuses a personal organization with 422 before reading the account', async () => {
      const { service, channelAccountPort } = setup({ organizationType: 'PERSONAL' });

      await expect(service.updateSettings(updateInput())).rejects.toBeInstanceOf(
        UnprocessableEntityError,
      );
      expect(channelAccountPort.requireLiveInstagramAccount).not.toHaveBeenCalled();
    });

    it('relays 404 channel_account_not_found from the channel account and writes nothing', async () => {
      const { service, channelAccountPort, settingsRepository } = setup();
      channelAccountPort.requireLiveInstagramAccount.mockRejectedValueOnce(
        channelAccountNotFoundError(),
      );

      await expect(service.updateSettings(updateInput())).rejects.toBeInstanceOf(NotFoundError);
      expect(settingsRepository.update).not.toHaveBeenCalled();
    });

    it('refuses 409 record_changed on an older expected_updated_at', async () => {
      const { service, settingsRepository } = setup();

      await expect(
        service.updateSettings(updateInput({ expectedUpdatedAt: '2026-11-21T08:00:00.000Z' })),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(settingsRepository.update).not.toHaveBeenCalled();
    });

    it('refuses a merged delay with one end alone, with a 400', async () => {
      const { service, settingsRepository } = setup();

      await expect(
        service.updateSettings(updateInput({ changes: { extra_delay_seconds_min: 3 } })),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(settingsRepository.update).not.toHaveBeenCalled();
    });

    it('checks the extra delay only when it is turned on, and maps a plan refusal to 403 plan_lacks_feature (P83)', async () => {
      const { service, channelAccountPort, settingsRepository } = setup({
        refusals: { extra_delay: { isAllowed: false, reason: 'plan_lacks_feature' } },
      });

      const refusal = service.updateSettings(
        updateInput({ changes: { extra_delay_seconds_min: 2, extra_delay_seconds_max: 4 } }),
      );

      await expect(refusal).rejects.toBeInstanceOf(ForbiddenError);
      await expect(refusal).rejects.toMatchObject({ reason: 'plan_lacks_feature' });
      expect(channelAccountPort.canChannelAccountUseFeature).toHaveBeenCalledWith({
        scope,
        ...channelAccount,
        feature: 'extra_delay',
      });
      expect(settingsRepository.update).not.toHaveBeenCalled();
    });

    it('never checks clearing the delay, or changing it when it is already on (P10)', async () => {
      const { service, channelAccountPort } = setup({
        saved: settingsRow({ extra_delay_seconds_min: 2, extra_delay_seconds_max: 4 }),
        refusals: { extra_delay: { isAllowed: false, reason: 'plan_lacks_feature' } },
      });

      await service.updateSettings(
        updateInput({ changes: { extra_delay_seconds_min: null, extra_delay_seconds_max: null } }),
      );
      await service.updateSettings(updateInput({ changes: { extra_delay_seconds_max: 6 } }));

      expect(channelAccountPort.canChannelAccountUseFeature).not.toHaveBeenCalled();
    });

    it('maps mark as seen turned on while untested to 422 feature_not_offered (P36)', async () => {
      const { service } = setup({
        refusals: { mark_seen: { isAllowed: false, reason: 'feature_not_offered' } },
      });

      await expect(
        service.updateSettings(
          updateInput({ changes: { is_mark_seen_after_reply_enabled: true } }),
        ),
      ).rejects.toMatchObject({ statusCode: 422, reason: 'feature_not_offered' });
    });

    it('wakes the lanes after a limit change only (IA14, AC-3.8)', async () => {
      const { service, lanePort } = setup();

      await service.updateSettings(
        updateInput({ changes: { is_comment_reply_trigger_enabled: false } }),
      );
      expect(lanePort.wakeLanes).not.toHaveBeenCalled();
      await service.updateSettings(updateInput({ changes: { person_hour_limit: 20 } }));
      expect(lanePort.wakeLanes).toHaveBeenCalledWith({ scope, ...channelAccount });
    });

    it('does not wake the lanes when a limit is sent with its saved value', async () => {
      const { service, lanePort } = setup({ saved: settingsRow({ fast_hour_limit: 500 }) });

      await service.updateSettings(updateInput({ changes: { fast_hour_limit: 500 } }));

      expect(lanePort.wakeLanes).not.toHaveBeenCalled();
    });
  });
});
