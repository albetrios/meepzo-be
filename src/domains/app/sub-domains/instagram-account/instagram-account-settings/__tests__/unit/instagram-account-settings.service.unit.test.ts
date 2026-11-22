import { describe, expect, it, vi } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  ConflictError,
  NotFoundError,
  UnprocessableEntityError,
  ValidationError,
} from '@/shared/errors/index.js';
import type { InstagramAccountRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import type {
  InstagramAccountSettingsRepository,
  InstagramAccountSettingsRow,
} from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import type { InstagramAccountSettingsChanges } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.types.js';

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
 * The settings service's own decisions (routes-final § 1.B, IA15) with both repositories and the
 * organization service faked: which row a connect gets back, route 3's checks in their order, and
 * what it writes and answers. The rows themselves are in
 * `instagram-account-settings.service.db.unit.test.ts`.
 */

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const EDITOR_PUBLIC_ID = 'usr_a1b2c3d4e5f6g7h8i9j0k';
const CALLER_PUBLIC_ID = 'usr_z9y8x7w6v5u4t3s2r1q0p';
const EDITOR_ID = 11;
const CALLER_ID = 12;
const scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: ORGANIZATION_PUBLIC_ID });
const TEAM = { id: 7, public_id: ORGANIZATION_PUBLIC_ID, type: 'TEAM' };
const ACCOUNT = {
  id: 3,
  public_id: 'iga_k7x9m2pqr4w8n1v3a1b2c',
  connection_status: 'connected',
};
const instagramAccount = { organizationId: TEAM.id, instagramAccountId: ACCOUNT.id };
const SAVED_AT = new Date('2026-11-21T08:30:00.000Z');

function settingsRow(
  overrides: Partial<InstagramAccountSettingsRow> = {},
): InstagramAccountSettingsRow {
  return {
    id: 91,
    organization_id: TEAM.id,
    instagram_account_id: ACCOUNT.id,
    is_automation_enabled: true,
    is_public_reply_safety_enabled: false,
    public_reply_chance_percent: 80,
    public_reply_hour_limit: 60,
    public_reply_gap_min_seconds: 20,
    public_reply_gap_max_seconds: 60,
    updated_by_user_id: EDITOR_ID,
    created_at: new Date('2026-11-21T08:00:00.000Z'),
    updated_at: SAVED_AT,
    ...overrides,
  };
}

function setup({
  organizationType = 'TEAM',
  account = ACCOUNT as typeof ACCOUNT | null,
  saved = settingsRow() as InstagramAccountSettingsRow | null,
}: {
  organizationType?: 'TEAM' | 'PERSONAL';
  account?: typeof ACCOUNT | null;
  saved?: InstagramAccountSettingsRow | null;
} = {}) {
  const settingsRepository = {
    insertDefaults: vi.fn(async (): Promise<InstagramAccountSettingsRow | null> => settingsRow()),
    findByInstagramAccount: vi.fn(async () => saved),
    findByInstagramAccountForUpdate: vi.fn(async () => saved),
    update: vi.fn(
      async ({
        changes,
        updatedByUserId,
      }: {
        changes: InstagramAccountSettingsChanges;
        updatedByUserId: number | null;
      }): Promise<InstagramAccountSettingsRow | null> =>
        settingsRow({
          ...(changes as Partial<InstagramAccountSettingsRow>),
          updated_by_user_id: updatedByUserId,
          updated_at: new Date('2026-11-21T10:00:00.000Z'),
        }),
    ),
  };
  const accountRepository = { findLiveByOrganizationId: vi.fn(async () => account) };
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
    accountRepository as unknown as InstagramAccountRepository,
    organizationService as unknown as OrganizationService,
  );
  return { service, settingsRepository, accountRepository, organizationService };
}

/** Route 3's input: the caller is a user and no version is named, unless overridden. */
function updateInput(
  overrides: Partial<Parameters<InstagramAccountSettingsService['updateSettings']>[0]> = {},
): Parameters<InstagramAccountSettingsService['updateSettings']>[0] {
  return {
    scope,
    changes: { is_automation_enabled: false },
    expectedUpdatedAt: undefined,
    updatedByUserPublicId: CALLER_PUBLIC_ID,
    ...overrides,
  };
}

/** The error a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

describe('InstagramAccountSettingsService.createDefaultSettings', () => {
  it('answers the row it created, without reading another', async () => {
    const { service, settingsRepository } = setup();
    const created = settingsRow({ id: 120 });
    settingsRepository.insertDefaults.mockResolvedValueOnce(created);

    await expect(service.createDefaultSettings({ scope, instagramAccount })).resolves.toBe(created);

    expect(settingsRepository.insertDefaults).toHaveBeenCalledWith(instagramAccount);
    expect(settingsRepository.findByInstagramAccount).not.toHaveBeenCalled();
    expect(withAppDatabaseContext).toHaveBeenLastCalledWith(expect.objectContaining({ scope }));
  });

  it('answers the kept row when the account already had one (a reconnect)', async () => {
    const kept = settingsRow({ id: 4, is_automation_enabled: false });
    const { service, settingsRepository } = setup({ saved: kept });
    settingsRepository.insertDefaults.mockResolvedValueOnce(null);

    await expect(service.createDefaultSettings({ scope, instagramAccount })).resolves.toBe(kept);

    expect(settingsRepository.findByInstagramAccount).toHaveBeenCalledWith(instagramAccount);
  });

  it('fails when the row was neither created nor found — the account is not in this organization', async () => {
    const { service, settingsRepository } = setup({ saved: null });
    settingsRepository.insertDefaults.mockResolvedValueOnce(null);

    await expect(service.createDefaultSettings({ scope, instagramAccount })).rejects.toThrow(
      'neither created nor found',
    );
  });
});

describe('InstagramAccountSettingsService.findSettings', () => {
  it('reads the row in the given scope, or null when the account has none', async () => {
    const { service, settingsRepository } = setup();

    await expect(service.findSettings({ scope, instagramAccount })).resolves.toMatchObject({
      id: 91,
    });
    expect(settingsRepository.findByInstagramAccount).toHaveBeenCalledWith(instagramAccount);
    expect(withAppDatabaseContext).toHaveBeenLastCalledWith(expect.objectContaining({ scope }));

    const withoutRow = setup({ saved: null });
    await expect(withoutRow.service.findSettings({ scope, instagramAccount })).resolves.toBeNull();
  });
});

describe('InstagramAccountSettingsService.updateSettings (route 3)', () => {
  it('locks the saved row, writes only the change with the caller, and answers it as saved', async () => {
    const { service, settingsRepository, accountRepository, organizationService } = setup();

    const result = await service.updateSettings(
      updateInput({
        changes: { is_automation_enabled: false, public_reply_gap_max_seconds: 90 },
      }),
    );

    expect(organizationService.requireOrganizationByPublicId).toHaveBeenCalledWith(
      ORGANIZATION_PUBLIC_ID,
    );
    expect(accountRepository.findLiveByOrganizationId).toHaveBeenCalledWith(TEAM.id);
    expect(settingsRepository.findByInstagramAccountForUpdate).toHaveBeenCalledWith(
      instagramAccount,
    );
    expect(settingsRepository.update).toHaveBeenCalledWith({
      ...instagramAccount,
      changes: { is_automation_enabled: false, public_reply_gap_max_seconds: 90 },
      updatedByUserId: CALLER_ID,
    });
    expect(
      settingsRepository.findByInstagramAccountForUpdate.mock.invocationCallOrder[0],
    ).toBeLessThan(settingsRepository.update.mock.invocationCallOrder[0] as number);
    expect(result).toEqual({
      settings: {
        is_automation_enabled: false,
        is_public_reply_safety_enabled: false,
        public_reply_chance_percent: 80,
        public_reply_hour_limit: 60,
        public_reply_gap_min_seconds: 20,
        public_reply_gap_max_seconds: 90,
        updated_by_user_id: CALLER_PUBLIC_ID,
        updated_at: '2026-11-21T10:00:00.000Z',
      },
      instagramAccountPublicId: ACCOUNT.public_id,
    });
  });

  it('records no editor for an API key, and answers none', async () => {
    const { service, settingsRepository } = setup();

    const { settings } = await service.updateSettings(
      updateInput({ updatedByUserPublicId: undefined }),
    );

    expect(settingsRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({ updatedByUserId: null }),
    );
    expect(settings.updated_by_user_id).toBeNull();
  });

  it('answers no editor when the caller’s user is not found any more', async () => {
    const { service, organizationService } = setup();
    organizationService.resolveUserInternalIdByPublicId.mockResolvedValueOnce(null);

    const { settings } = await service.updateSettings(updateInput());

    expect(settings.updated_by_user_id).toBeNull();
  });

  it.each(['connected', 'expired', 'error'])(
    'takes the change while the account is %s, so automation can go off before a reconnect',
    async (connectionStatus) => {
      const { service } = setup({ account: { ...ACCOUNT, connection_status: connectionStatus } });

      const { settings } = await service.updateSettings(updateInput());

      expect(settings.is_automation_enabled).toBe(false);
    },
  );

  it('refuses a personal organization with 422 before reading the account (IA3)', async () => {
    const { service, accountRepository, settingsRepository } = setup({
      organizationType: 'PERSONAL',
    });

    const error = await rejection(service.updateSettings(updateInput()));

    expect(error).toBeInstanceOf(UnprocessableEntityError);
    expect((error as UnprocessableEntityError).messageKey).toBe(
      'errors:personalOrganizationNoInstagram',
    );
    expect(accountRepository.findLiveByOrganizationId).not.toHaveBeenCalled();
    expect(settingsRepository.update).not.toHaveBeenCalled();
  });

  it('answers 404 instagram_not_connected without a live account, locking nothing', async () => {
    const { service, settingsRepository } = setup({ account: null });

    const error = await rejection(service.updateSettings(updateInput()));

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).reason).toBe('instagram_not_connected');
    expect(settingsRepository.findByInstagramAccountForUpdate).not.toHaveBeenCalled();
  });

  it('answers 409 record_changed naming who saved since and when, writing nothing (D43)', async () => {
    const { service, settingsRepository, organizationService } = setup();

    const error = await rejection(
      service.updateSettings(updateInput({ expectedUpdatedAt: '2026-11-21T08:29:59.000Z' })),
    );

    expect(error).toBeInstanceOf(ConflictError);
    const conflict = error as ConflictError;
    expect(conflict.reason).toBe('record_changed');
    expect(conflict.messageParams).toEqual({
      updated_at: SAVED_AT.toISOString(),
      updated_by: EDITOR_PUBLIC_ID,
    });
    expect(organizationService.resolveUserPublicIdByInternalId).toHaveBeenCalledWith(EDITOR_ID);
    expect(settingsRepository.update).not.toHaveBeenCalled();
  });

  it('names "someone" when the saved row has no editor', async () => {
    const { service, organizationService } = setup({
      saved: settingsRow({ updated_by_user_id: null }),
    });

    const error = await rejection(
      service.updateSettings(updateInput({ expectedUpdatedAt: '2026-11-21T08:00:00.000Z' })),
    );

    expect((error as ConflictError).messageParams).toMatchObject({ updated_by: 'someone' });
    expect(organizationService.resolveUserPublicIdByInternalId).not.toHaveBeenCalled();
  });

  it('takes the version it read in any UTC offset', async () => {
    const { service, settingsRepository } = setup();

    await service.updateSettings(
      updateInput({ expectedUpdatedAt: '2026-11-21T14:00:00.000+05:30' }),
    );

    expect(settingsRepository.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the minimum alone, above the saved maximum', { public_reply_gap_min_seconds: 61 }],
    ['the maximum alone, below the saved minimum', { public_reply_gap_max_seconds: 19 }],
    [
      'both ends the wrong way round',
      { public_reply_gap_min_seconds: 100, public_reply_gap_max_seconds: 99 },
    ],
  ])('answers 400 on the maximum gap for %s, writing nothing', async (_case, changes) => {
    const { service, settingsRepository } = setup();

    const error = await rejection(service.updateSettings(updateInput({ changes })));

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).errors).toEqual([
      expect.objectContaining({ field: 'body.public_reply_gap_max_seconds' }),
    ]);
    expect(settingsRepository.update).not.toHaveBeenCalled();
  });

  it('checks the version before the gap: a stale save is a 409 even with a bad gap', async () => {
    const { service } = setup();

    const error = await rejection(
      service.updateSettings(
        updateInput({
          changes: { public_reply_gap_min_seconds: 3600 },
          expectedUpdatedAt: '2026-11-21T08:00:00.000Z',
        }),
      ),
    );

    expect((error as ConflictError).reason).toBe('record_changed');
  });

  it('fails when the account has no settings row, and when the row vanished under the lock', async () => {
    const withoutRow = setup({ saved: null });
    await expect(withoutRow.service.updateSettings(updateInput())).rejects.toThrow(
      'instagram account has no settings row',
    );
    expect(withoutRow.settingsRepository.update).not.toHaveBeenCalled();

    const vanished = setup();
    vanished.settingsRepository.update.mockResolvedValueOnce(null);
    await expect(vanished.service.updateSettings(updateInput())).rejects.toThrow('vanished');
  });
});
