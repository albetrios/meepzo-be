import type {
  MetaAd,
  MetaAdAccount,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type { ChannelConnectionRow } from './channel-connection.repository.js';
import {
  type ChannelConnectionStatus,
  META_ADS_PERMISSION,
} from './channel-connection.constants.js';
import type { ChannelConnectionProvider } from './channel-connection-state.js';
import type {
  ChannelAccountPlanRoomOutput,
  ChannelConnectionAccount,
  ChannelConnectionAccountOutput,
  ChannelConnectionOutput,
  ChannelSharedAssetOutput,
  MetaAdAccountOutput,
  MetaAdOutput,
} from './channel-connection.types.js';

/** A timestamp as ISO 8601, `null` kept. */
function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** One channel account of a connection's answer (routes-final § 1.6). */
export function serializeChannelConnectionAccount(
  account: ChannelConnectionAccount,
): ChannelConnectionAccountOutput {
  return {
    id: account.publicId,
    channel: account.channel,
    display_name: account.displayName,
    profile_picture_url: account.profilePictureUrl,
    connection_status: account.connectionStatus,
  };
}

/**
 * One of this connection's accounts Meta no longer lists, as route 151 answers it
 * (feat-meta-connect-flow CN7): `not_shared_any_more`, with the account's own name and id.
 */
export function serializeNotSharedAnyMoreAsset(
  account: ChannelConnectionAccount,
): ChannelSharedAssetOutput {
  return {
    channel: account.channel,
    provider_account_id: account.providerAccountId,
    username: account.displayName.startsWith('@')
      ? account.displayName.slice(1)
      : account.displayName,
    profile_picture_url: account.profilePictureUrl,
    state: 'not_shared_any_more',
    channel_account_id: account.publicId,
  };
}

/**
 * The Channel connection object (routes-final § 1.6): its business, status, granted permissions,
 * who connected it and when, the last check and its error codes, and its not-revoked accounts.
 * Never the token.
 */
export function serializeChannelConnection({
  connection,
  connected_by_user_public_id,
  accounts,
}: {
  connection: ChannelConnectionRow;
  connected_by_user_public_id: string | null;
  accounts: readonly ChannelConnectionAccount[];
}): ChannelConnectionOutput {
  return {
    id: connection.public_id,
    provider: connection.provider as ChannelConnectionProvider,
    client_business_id: connection.client_business_id,
    login_type: connection.login_type,
    status: connection.status as ChannelConnectionStatus,
    status_changed_at: connection.status_changed_at.toISOString(),
    scopes: [...connection.scopes],
    has_ads_access: connection.scopes.includes(META_ADS_PERMISSION),
    connected_by_user_id: connected_by_user_public_id,
    connected_at: connection.connected_at.toISOString(),
    last_checked_at: toIsoOrNull(connection.last_checked_at),
    last_check_error: connection.last_check_error,
    disconnected_at: toIsoOrNull(connection.disconnected_at),
    channel_accounts: accounts.map(serializeChannelConnectionAccount),
    created_at: connection.created_at.toISOString(),
    updated_at: connection.updated_at.toISOString(),
  };
}

/** The plan's room for channel accounts (1.6 `plan_room`). */
export function serializeChannelAccountPlanRoom({
  accounts_max,
  accounts_used,
}: {
  accounts_max: number;
  accounts_used: number;
}): ChannelAccountPlanRoomOutput {
  return {
    accounts_max,
    accounts_used,
    accounts_free: Math.max(0, accounts_max - accounts_used),
  };
}

/** One ad account of route 41 — the Meta ad account object (1.6). */
export function serializeMetaAdAccount(adAccount: MetaAdAccount): MetaAdAccountOutput {
  return {
    ad_account_id: adAccount.adAccountId,
    name: adAccount.name,
    account_status: adAccount.accountStatus,
  };
}

/**
 * One ad of route 15 — the Meta ad object (1.6): its Instagram post and the organization's channel
 * account the ad runs as, matched by its Instagram id (`null` when none of this organization's).
 */
export function serializeMetaAd({
  ad,
  ad_account_id,
  channel_account_public_id,
}: {
  ad: MetaAd;
  ad_account_id: string;
  channel_account_public_id: string | null;
}): MetaAdOutput {
  return {
    ad_id: ad.adId,
    name: ad.name,
    status: ad.status,
    ad_account_id,
    instagram_media_id: ad.instagramMediaId,
    channel_account_id: channel_account_public_id,
    thumbnail_url: ad.thumbnailUrl,
    created_at: ad.createdAt,
  };
}
