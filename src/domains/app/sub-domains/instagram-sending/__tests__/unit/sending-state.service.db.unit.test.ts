import { beforeEach, describe, expect, it } from 'vitest';
import { env } from '@/shared/config/env.config.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { SendingStateService } from '@/domains/app/sub-domains/instagram-sending/sending-state.service.js';

/**
 * The global sending row in the database (feat-instagram-dm-sending routes-final § 6 SN7, P16, P95,
 * S13; AC-17.21): created once and never overwritten, the versions only go up, the app-level usage
 * keeps the newer reading, and a server whose environment id differs — a restored copy — may not
 * send.
 */
describe('SendingStateService (database)', () => {
  const service = new SendingStateService();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('creates the row with the environment id once, and never overwrites it', async () => {
    const first = await service.ensureSendingState({ environmentId: 'production' });
    expect(first.created).toBe(true);
    expect(first.state).toMatchObject({
      environment_id: 'production',
      settings_version: '1',
      minimum_compatible_settings_version: '1',
    });
    const again = await service.ensureSendingState({ environmentId: 'restored-copy' });
    expect(again.created).toBe(false);
    expect(again.state?.environment_id).toBe('production');
  });

  it('raises the versions only upward and lets the rollback set the minimum', async () => {
    await service.ensureSendingState({ environmentId: 'production' });
    await operatorQuery`
      UPDATE app.sending_states SET settings_version = '5', minimum_compatible_settings_version = '4'`;
    const kept = await service.ensureSendingState({ environmentId: 'production' });
    expect(kept.state).toMatchObject({
      settings_version: '5',
      minimum_compatible_settings_version: '4',
    });
    const lowered = await service.setMinimumCompatibleSettingsVersion('1');
    expect(lowered?.minimum_compatible_settings_version).toBe('1');
  });

  it('keeps the newer app-level usage reading (S13)', async () => {
    await service.ensureSendingState({ environmentId: 'production' });
    await service.writeAppUsage({ usagePercent: 40, readAt: new Date('2026-11-24T10:05:00Z') });
    await service.writeAppUsage({ usagePercent: 90, readAt: new Date('2026-11-24T10:00:00Z') });
    await service.writeAppUsage({ usagePercent: 140, readAt: new Date('2026-11-24T10:10:00Z') });
    expect(await service.readSendingState()).toMatchObject({ app_usage_percent: 100 });
  });

  it('may not send with SENDING_ENABLED off, or from a copy whose environment id differs (AC-17.21)', async () => {
    await service.ensureSendingState({ environmentId: 'production' });
    const { SENDING_ENABLED: enabled, SENDING_ENVIRONMENT_ID: environmentId } = env;
    try {
      env.SENDING_ENABLED = false;
      env.SENDING_ENVIRONMENT_ID = 'production';
      expect((await service.checkSending()).reason).toBe('sending_disabled');
      env.SENDING_ENABLED = true;
      env.SENDING_ENVIRONMENT_ID = 'test-server';
      expect(await service.checkSending()).toMatchObject({
        maySend: false,
        reason: 'environment_mismatch',
      });
      // A clock in line (WC-23, R48) — the worker's clock watch reads it in a real process.
      const inLine = { readClockSkewMilliseconds: () => 0 };
      expect(await new SendingStateService(inLine).mayTakeTickets()).toBe(false);
      env.SENDING_ENVIRONMENT_ID = 'production';
      expect(await new SendingStateService(inLine).mayTakeTickets()).toBe(true);
    } finally {
      env.SENDING_ENABLED = enabled;
      env.SENDING_ENVIRONMENT_ID = environmentId;
    }
  });
});
