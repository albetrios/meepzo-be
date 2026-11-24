import { describe, expect, it } from 'vitest';
import { decideSending } from '@/domains/app/sub-domains/instagram-sending/sending-state.service.js';

const STATE = {
  environment_id: 'production',
  settings_version: '3',
  minimum_compatible_settings_version: '2',
};

/**
 * Whether a server may send (feat-instagram-dm-sending routes-final § 6 SN7, D20, P95; AC-17.21):
 * the switch, the environment id against the database's row, and the settings versions.
 */
describe('decideSending', () => {
  it('refuses while SENDING_ENABLED is off, whatever the row says', () => {
    expect(
      decideSending({
        isSendingEnabled: false,
        environmentId: 'production',
        serverSettingsVersion: '3',
        state: STATE,
      }),
    ).toEqual({ maySend: false, reason: 'sending_disabled' });
  });

  it('refuses a server whose environment id differs from the database row — a restored copy', () => {
    expect(
      decideSending({
        isSendingEnabled: true,
        environmentId: 'staging-branch',
        serverSettingsVersion: '3',
        state: STATE,
      }),
    ).toEqual({ maySend: false, reason: 'environment_mismatch' });
  });

  it('refuses with no environment id and with no row', () => {
    expect(
      decideSending({
        isSendingEnabled: true,
        environmentId: undefined,
        serverSettingsVersion: '3',
        state: STATE,
      }).reason,
    ).toBe('environment_id_missing');
    expect(
      decideSending({
        isSendingEnabled: true,
        environmentId: 'production',
        serverSettingsVersion: '3',
        state: null,
      }).reason,
    ).toBe('sending_state_missing');
  });

  it('lets an older but compatible server send, and refuses one older than the minimum (P95)', () => {
    expect(
      decideSending({
        isSendingEnabled: true,
        environmentId: 'production',
        serverSettingsVersion: '2',
        state: STATE,
      }),
    ).toEqual({ maySend: true, reason: null });
    expect(
      decideSending({
        isSendingEnabled: true,
        environmentId: 'production',
        serverSettingsVersion: '1',
        state: STATE,
      }),
    ).toEqual({ maySend: false, reason: 'settings_version_too_old' });
  });

  it('compares versions as numbers, not text', () => {
    expect(
      decideSending({
        isSendingEnabled: true,
        environmentId: 'production',
        serverSettingsVersion: '10',
        state: { ...STATE, minimum_compatible_settings_version: '9' },
      }).maySend,
    ).toBe(true);
  });
});
