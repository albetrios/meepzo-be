import { describe, expect, it } from 'vitest';
import {
  serializeInstagramAccount,
  serializeInstagramConnectResult,
} from '@/domains/app/sub-domains/instagram-account/instagram-account.serializer.js';
import { serializeInstagramAccountSettings } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.serializer.js';
import { responseBodyContainsSecretFields } from '@/shared/utils/idempotency/idempotency-fingerprint.util.js';

const timestamp = new Date('2026-11-21T09:00:00.000Z');

function buildRow(
  overrides: Partial<Parameters<typeof serializeInstagramAccount>[0]['account']> = {},
) {
  return {
    public_id: 'iga_k7x9m2pqr4w8n1v3a1b2c',
    instagram_user_id: '17841400000000001',
    username: 'handmade.shop',
    name: 'Handmade Shop',
    biography: null,
    website: null,
    profile_picture_url: null,
    followers_count: 3,
    follows_count: 2,
    media_count: 1,
    scopes: ['instagram_business_basic'],
    connection_status: 'connected',
    token_expires_at: timestamp,
    webhook_subscribed_at: null,
    connected_at: timestamp,
    profile_synced_at: null,
    updated_at: timestamp,
    ...overrides,
  };
}

const settings = serializeInstagramAccountSettings({
  settings: {
    is_automation_enabled: true,
    is_public_reply_safety_enabled: false,
    public_reply_chance_percent: 80,
    public_reply_hour_limit: 60,
    public_reply_gap_min_seconds: 20,
    public_reply_gap_max_seconds: 60,
    updated_at: timestamp,
  },
  updated_by_user_public_id: null,
});

describe('serializeInstagramAccount', () => {
  it('maps the row to the account object (1.A.6) with the profile link and the webhook flag', () => {
    const output = serializeInstagramAccount({
      account: buildRow({ webhook_subscribed_at: timestamp }),
      settings,
      connected_by_user_public_id: 'usr_m7n2p5q8w1r4x9k3a1b2c',
    });

    expect(output).toEqual({
      id: 'iga_k7x9m2pqr4w8n1v3a1b2c',
      instagram_user_id: '17841400000000001',
      username: 'handmade.shop',
      name: 'Handmade Shop',
      biography: null,
      website: null,
      profile_picture_url: null,
      profile_url: 'https://instagram.com/handmade.shop',
      followers_count: 3,
      follows_count: 2,
      media_count: 1,
      scopes: ['instagram_business_basic'],
      connection_status: 'connected',
      access_expires_at: '2026-11-21T09:00:00.000Z',
      is_webhook_subscribed: true,
      settings,
      connected_by_user_id: 'usr_m7n2p5q8w1r4x9k3a1b2c',
      connected_at: '2026-11-21T09:00:00.000Z',
      profile_synced_at: null,
      updated_at: '2026-11-21T09:00:00.000Z',
    });
  });

  it('reads not subscribed, no profile link without a username, and no expiry when there is none', () => {
    const output = serializeInstagramAccount({
      account: buildRow({ username: null, token_expires_at: null }),
      settings,
      connected_by_user_public_id: null,
    });

    expect(output).toMatchObject({
      is_webhook_subscribed: false,
      profile_url: null,
      access_expires_at: null,
      connected_by_user_id: null,
    });
  });

  it('never carries the internal ids or the app-scoped id', () => {
    const output = serializeInstagramAccount({
      account: { ...buildRow(), id: 7, organization_id: 3, instagram_app_user_id: '1' } as never,
      settings,
      connected_by_user_public_id: null,
    });

    expect(output).not.toHaveProperty('organization_id');
    expect(output).not.toHaveProperty('instagram_app_user_id');
    expect(output.id).toBe('iga_k7x9m2pqr4w8n1v3a1b2c');
  });
});

describe('serializeInstagramConnectResult', () => {
  it('wraps the account with whether it is a new connection', () => {
    const instagramAccount = serializeInstagramAccount({
      account: buildRow(),
      settings,
      connected_by_user_public_id: null,
    });

    expect(
      serializeInstagramConnectResult({
        is_new_connection: false,
        instagram_account: instagramAccount,
      }),
    ).toEqual({ is_new_connection: false, instagram_account: instagramAccount });
  });

  it('names no token or secret, so the idempotency layer stores it and a repeated key replays it (K3, D35)', () => {
    const connectResult = serializeInstagramConnectResult({
      is_new_connection: true,
      instagram_account: serializeInstagramAccount({
        account: buildRow({ webhook_subscribed_at: timestamp }),
        settings,
        connected_by_user_public_id: 'usr_m7n2p5q8w1r4x9k3a1b2c',
      }),
    });

    expect(connectResult.instagram_account).not.toHaveProperty('token_expires_at');
    expect(
      responseBodyContainsSecretFields(
        JSON.stringify({ data: connectResult, meta: { request_id: 'req-test' } }),
      ),
    ).toBe(false);
  });
});
