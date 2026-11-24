import { describe, expect, it } from 'vitest';
import {
  resolveInstagramEffectiveLimits,
  serializeInstagramAccountSettings,
} from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.serializer.js';
import { buildInstagramAccountSettingsRow } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/__tests__/factories/instagram-account-settings.factory.js';

const NOW = new Date('2026-11-24T09:00:00.000Z');
const DAY_MILLISECONDS = 86_400_000;
/** Connected an hour ago — inside the 7-day new-account window (D5). */
const NEW_ACCOUNT_CONNECTED_AT = new Date(NOW.getTime() - 3_600_000);
/** Connected 7 days ago to the millisecond — the window has ended. */
const OLD_ACCOUNT_CONNECTED_AT = new Date(NOW.getTime() - 7 * DAY_MILLISECONDS);

describe('resolveInstagramEffectiveLimits (2.B.6, IA14)', () => {
  it('uses the settings file for every empty limit — 150 opening DMs an hour for a new account (AC-3.1, AC-3.2)', () => {
    expect(
      resolveInstagramEffectiveLimits({
        settings: buildInstagramAccountSettingsRow(),
        connected_at: NEW_ACCOUNT_CONNECTED_AT,
        now: NOW,
      }),
    ).toEqual({
      opening_hour_limit: 150,
      opening_day_limit: null,
      fast_hour_limit: 10_000,
      person_hour_limit: 60,
      broadcast_hour_limit: 600,
    });
  });

  it('uses 600 an hour once the 7 days have passed', () => {
    expect(
      resolveInstagramEffectiveLimits({
        settings: buildInstagramAccountSettingsRow(),
        connected_at: OLD_ACCOUNT_CONNECTED_AT,
        now: NOW,
      }).opening_hour_limit,
    ).toBe(600);
  });

  it("uses each owner value — an owner's opening limit replaces the new-account one; the day limit stays off", () => {
    expect(
      resolveInstagramEffectiveLimits({
        settings: buildInstagramAccountSettingsRow({
          opening_hour_limit: 400,
          opening_day_limit: 4000,
          fast_hour_limit: 20_000,
          person_hour_limit: 5,
          broadcast_hour_limit: 1,
        }),
        connected_at: NEW_ACCOUNT_CONNECTED_AT,
        now: NOW,
      }),
    ).toEqual({
      opening_hour_limit: 400,
      opening_day_limit: null,
      fast_hour_limit: 20_000,
      person_hour_limit: 5,
      broadcast_hour_limit: 1,
    });
  });
});

describe('serializeInstagramAccountSettings', () => {
  it("maps every setting, the channel account's switch, the editor public id and updated_at (2.B.6) — never an internal id or a public-reply field", () => {
    const output = serializeInstagramAccountSettings({
      settings: buildInstagramAccountSettingsRow({
        id: 9,
        organization_id: 3,
        channel_account_id: 4,
        updated_by_user_id: 12,
        opening_hour_limit: 300,
        extra_stop_words: ['band karo'],
        is_comment_reply_trigger_enabled: false,
        extra_delay_seconds_min: 2,
        extra_delay_seconds_max: 5,
        updated_at: new Date('2026-11-21T09:00:00.000Z'),
      }),
      channel_account: { is_automation_enabled: false, connected_at: OLD_ACCOUNT_CONNECTED_AT },
      updated_by_user_public_id: 'usr_m7n2p5q8w1r4x9k3a1b2c',
      now: NOW,
    });

    expect(output).toEqual({
      is_automation_enabled: false,
      opening_hour_limit: 300,
      opening_day_limit: null,
      fast_hour_limit: null,
      person_hour_limit: null,
      broadcast_hour_limit: null,
      effective_limits: {
        opening_hour_limit: 300,
        opening_day_limit: null,
        fast_hour_limit: 10_000,
        person_hour_limit: 60,
        broadcast_hour_limit: 600,
      },
      is_day_limit_enabled: false,
      is_automatic_notice_enabled: false,
      extra_stop_words: ['band karo'],
      is_comment_reply_trigger_enabled: false,
      is_once_per_person_per_post_enabled: true,
      is_mark_seen_after_reply_enabled: false,
      extra_delay_seconds_min: 2,
      extra_delay_seconds_max: 5,
      updated_by_user_id: 'usr_m7n2p5q8w1r4x9k3a1b2c',
      updated_at: '2026-11-21T09:00:00.000Z',
    });
  });
});
