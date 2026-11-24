import { describe, expect, it } from 'vitest';
import { responseBodyContainsSecretFields } from '@/shared/utils/idempotency/idempotency-fingerprint.util.js';
import {
  serializeChannelAccountPlanRoom,
  serializeChannelConnection,
  serializeMetaAd,
  serializeMetaAdAccount,
} from '@/domains/app/sub-domains/channel-connection/channel-connection.serializer.js';
import type { ChannelConnectionRow } from '@/domains/app/sub-domains/channel-connection/channel-connection.repository.js';

/** The Channel connection object (routes-final § 1.6): its fields, `has_ads_access`, never the token. */

const timestamp = new Date('2026-11-24T09:00:00.000Z');

function connectionRow(overrides: Partial<ChannelConnectionRow> = {}): ChannelConnectionRow {
  return {
    id: 4,
    public_id: 'chc_abcdefghij0123456789k',
    organization_id: 7,
    provider: 'meta',
    client_business_id: '5550001234567890',
    config_id: '1234567890',
    login_type: 'unified',
    status: 'connected',
    status_changed_at: timestamp,
    scopes: ['instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments'],
    connected_by_user_id: 3,
    connected_at: timestamp,
    last_checked_at: null,
    last_check_error: null,
    disconnected_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

describe('serializeChannelConnection', () => {
  it('shapes the connection with its accounts and no token', () => {
    const output = serializeChannelConnection({
      connection: connectionRow(),
      connected_by_user_public_id: 'usr_abcdefghij0123456789k',
      accounts: [
        {
          internalId: 9,
          publicId: 'iga_abcdefghij0123456789k',
          channel: 'instagram',
          providerAccountId: '178414',
          displayName: '@acme.shop',
          profilePictureUrl: null,
          connectionStatus: 'connected',
          channelConnectionId: 4,
          isWebhookSubscribed: true,
        },
      ],
    });

    expect(output).toEqual({
      id: 'chc_abcdefghij0123456789k',
      provider: 'meta',
      client_business_id: '5550001234567890',
      login_type: 'unified',
      status: 'connected',
      status_changed_at: '2026-11-24T09:00:00.000Z',
      scopes: ['instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments'],
      has_ads_access: false,
      connected_by_user_id: 'usr_abcdefghij0123456789k',
      connected_at: '2026-11-24T09:00:00.000Z',
      last_checked_at: null,
      last_check_error: null,
      disconnected_at: null,
      channel_accounts: [
        {
          id: 'iga_abcdefghij0123456789k',
          channel: 'instagram',
          display_name: '@acme.shop',
          profile_picture_url: null,
          connection_status: 'connected',
        },
      ],
      created_at: '2026-11-24T09:00:00.000Z',
      updated_at: '2026-11-24T09:00:00.000Z',
    });
    expect(responseBodyContainsSecretFields(JSON.stringify({ data: output }))).toBe(false);
  });

  it('reads ads access from the granted ads_read permission (MC13)', () => {
    const output = serializeChannelConnection({
      connection: connectionRow({ scopes: ['instagram_basic', 'ads_read'] }),
      connected_by_user_public_id: null,
      accounts: [],
    });
    expect(output.has_ads_access).toBe(true);
  });
});

describe('serializeChannelAccountPlanRoom', () => {
  it('answers the free room, never below zero', () => {
    expect(serializeChannelAccountPlanRoom({ accounts_max: 3, accounts_used: 1 })).toEqual({
      accounts_max: 3,
      accounts_used: 1,
      accounts_free: 2,
    });
    expect(
      serializeChannelAccountPlanRoom({ accounts_max: 1, accounts_used: 2 }).accounts_free,
    ).toBe(0);
  });

  it("shapes the ad picker's ad account and ad (1.6) key for key", () => {
    expect(serializeMetaAdAccount({ adAccountId: '42', name: 'Shop', accountStatus: 1 })).toEqual({
      ad_account_id: '42',
      name: 'Shop',
      account_status: 1,
    });
    expect(
      serializeMetaAd({
        ad: {
          adId: '7',
          name: 'Sale',
          status: 'ACTIVE',
          instagramMediaId: '180',
          instagramUserId: '178',
          thumbnailUrl: null,
          createdAt: '2026-11-01T10:00:00+0000',
        },
        ad_account_id: '42',
        channel_account_public_id: 'iga_000000000000000000001',
      }),
    ).toEqual({
      ad_id: '7',
      name: 'Sale',
      status: 'ACTIVE',
      ad_account_id: '42',
      instagram_media_id: '180',
      channel_account_id: 'iga_000000000000000000001',
      thumbnail_url: null,
      created_at: '2026-11-01T10:00:00+0000',
    });
  });
});
