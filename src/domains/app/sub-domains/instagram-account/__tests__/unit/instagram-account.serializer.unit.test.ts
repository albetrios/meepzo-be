import { describe, expect, it } from 'vitest';
import { serializeInstagramAccountExtension } from '@/domains/app/sub-domains/instagram-account/instagram-account.serializer.js';
import type { InstagramAccountSettingsOutput } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.types.js';

/** The `instagram` object of the channel account (routes-final § 2.A.6, ROUTE row R6). */
describe('serializeInstagramAccountExtension (2.A.6)', () => {
  const settings = { is_automation_enabled: true } as unknown as InstagramAccountSettingsOutput;
  const row = {
    instagram_user_id: '17841400000000001',
    username: 'handmade.shop',
    account_type: 'creator',
    is_private: true,
    followers_count: 1204,
    profile_picture_url: 'https://cdn.example.com/picture.jpg',
    starter_questions_set_at: new Date('2026-11-22T10:00:00.000Z'),
    webhook_subscribed_at: new Date('2026-11-21T09:00:00.000Z'),
    messages_webhook_missing_at: null,
    profile_synced_at: null,
    message_access: 'unknown',
    message_access_checked_at: null,
  };

  it('names exactly the 2.A.6 keys, the private flag and the times as ISO 8601', () => {
    const output = serializeInstagramAccountExtension({ instagram: row, settings });

    expect(output).toEqual({
      instagram_user_id: '17841400000000001',
      username: 'handmade.shop',
      account_type: 'creator',
      is_private: true,
      followers_count: 1204,
      profile_picture_url: 'https://cdn.example.com/picture.jpg',
      starter_questions_set_at: '2026-11-22T10:00:00.000Z',
      is_webhook_subscribed: true,
      is_messages_webhook_missing: false,
      message_access: { status: 'unknown', checked_at: null },
      profile_synced_at: null,
      settings,
    });
    // No id, token, scopes or launch-only fields (IA8).
    for (const gone of ['id', 'name', 'scopes', 'access_expires_at', 'connection_status']) {
      expect(output).not.toHaveProperty(gone);
    }
  });

  it('reads a missing webhook stamp as not subscribed and an unknown account type as null', () => {
    const output = serializeInstagramAccountExtension({
      instagram: { ...row, webhook_subscribed_at: null, account_type: null, is_private: false },
      settings,
    });

    expect(output).toMatchObject({
      is_webhook_subscribed: false,
      account_type: null,
      is_private: false,
    });
  });

  it('reads the missing-messages flag as is_messages_webhook_missing (P358)', () => {
    const output = serializeInstagramAccountExtension({
      instagram: { ...row, messages_webhook_missing_at: new Date('2026-11-25T09:00:00.000Z') },
      settings,
    });

    expect(output.is_messages_webhook_missing).toBe(true);
  });

  it('shows the last message-access answer and when it was read (feat-meta-connect-flow IG4)', () => {
    const output = serializeInstagramAccountExtension({
      instagram: {
        ...row,
        message_access: 'off',
        message_access_checked_at: new Date('2026-11-26T08:00:00.000Z'),
      },
      settings,
    });

    expect(output.message_access).toEqual({
      status: 'off',
      checked_at: '2026-11-26T08:00:00.000Z',
    });
  });
});
