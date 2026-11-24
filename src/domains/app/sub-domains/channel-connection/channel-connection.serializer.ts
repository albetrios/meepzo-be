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
