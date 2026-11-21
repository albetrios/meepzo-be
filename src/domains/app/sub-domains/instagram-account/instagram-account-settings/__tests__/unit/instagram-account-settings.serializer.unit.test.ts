import { describe, expect, it } from 'vitest';
import { serializeInstagramAccountSettings } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.serializer.js';

describe('serializeInstagramAccountSettings', () => {
  it('maps the six settings, the editor public id and updated_at (1.B.6) — never the internal ids', () => {
    const output = serializeInstagramAccountSettings({
      settings: {
        id: 9,
        organization_id: 3,
        instagram_account_id: 4,
        updated_by_user_id: 12,
        is_automation_enabled: false,
        is_public_reply_safety_enabled: true,
        public_reply_chance_percent: 50,
        public_reply_hour_limit: 10,
        public_reply_gap_min_seconds: 5,
        public_reply_gap_max_seconds: 3600,
        updated_at: new Date('2026-11-21T09:00:00.000Z'),
      } as never,
      updated_by_user_public_id: 'usr_m7n2p5q8w1r4x9k3a1b2c',
    });

    expect(output).toEqual({
      is_automation_enabled: false,
      is_public_reply_safety_enabled: true,
      public_reply_chance_percent: 50,
      public_reply_hour_limit: 10,
      public_reply_gap_min_seconds: 5,
      public_reply_gap_max_seconds: 3600,
      updated_by_user_id: 'usr_m7n2p5q8w1r4x9k3a1b2c',
      updated_at: '2026-11-21T09:00:00.000Z',
    });
  });
});
