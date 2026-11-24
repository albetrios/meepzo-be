import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { InstagramAccountProfile } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type {
  ChannelConnectionAdAccess,
  ChannelConnectionChannel,
  ChannelConnectionStatus,
} from './channel-connection.constants.js';
import type { ChannelConnectionProvider } from './channel-connection-state.js';

/** One channel account of a connection as the connection's answers name it (1.6). */
export interface ChannelConnectionAccountOutput {
  /** The account's public id. */
  id: string;
  channel: ChannelConnectionChannel;
  display_name: string;
  profile_picture_url: string | null;
  /** `connected` · `error` · `revoked` (the launch account's `expired` reads as `error`). */
  connection_status: string;
}

/** The Channel connection object of routes 2, 4, 42 (routes-final § 1.6). Never the token. */
export interface ChannelConnectionOutput {
  id: string;
  provider: ChannelConnectionProvider;
  client_business_id: string;
  login_type: string;
  status: ChannelConnectionStatus;
  status_changed_at: string;
  scopes: string[];
  /** `ads_read` granted (MC13). */
  has_ads_access: boolean;
  connected_by_user_id: string | null;
  connected_at: string;
  last_checked_at: string | null;
  last_check_error: string | null;
  disconnected_at: string | null;
  channel_accounts: ChannelConnectionAccountOutput[];
  created_at: string;
  updated_at: string;
}

/** Routes 1 and 40's answer — the login address and when its state ends (1.6). */
export interface ChannelConnectStartOutput {
  login_url: string;
  state_expires_at: string;
}

/** The plan's room for channel accounts (1.6 `plan_room`). */
export interface ChannelAccountPlanRoomOutput {
  accounts_max: number;
  accounts_used: number;
  accounts_free: number;
}

/** One assigned account of the callback's answer (1.6). */
export interface ChannelConnectAccountOutput {
  channel: ChannelConnectionChannel;
  provider_account_id: string;
  username: string | null;
  profile_picture_url: string | null;
  /** `connected_here` · `connected_elsewhere` (cannot be picked) · `free`. */
  state: 'connected_here' | 'connected_elsewhere' | 'free';
  /** The account's public id when `connected_here`, else `null`. */
  channel_account_id: string | null;
}

/** Route 2's answer — the Channel connect result (1.6). */
export interface ChannelConnectResultOutput {
  is_reconnect: boolean;
  channel_connection: ChannelConnectionOutput;
  accounts: ChannelConnectAccountOutput[];
  reconnected_account_ids: string[];
  plan_room: ChannelAccountPlanRoomOutput;
}

/** One pick's result in route 3's answer (1.6). */
export interface ChannelAccountPickItemOutput {
  provider_account_id: string;
  result: 'connected' | 'already_connected' | 'connected_elsewhere' | 'not_assigned';
  /** The account when `connected` or `already_connected`, else `null`. */
  channel_account: ChannelConnectionAccountOutput | null;
}

/** Route 3's answer — the Channel account pick result (1.6). */
export interface ChannelAccountPickResultOutput {
  channel_connection_id: string;
  results: ChannelAccountPickItemOutput[];
  plan_room: ChannelAccountPlanRoomOutput;
}

/** One ad account of route 41's answer — the Meta ad account object (1.6). */
export interface MetaAdAccountOutput {
  /** Meta's ad account id, digits, without the `act_` prefix. */
  ad_account_id: string;
  name: string | null;
  /** Meta's `account_status` number (1 active, 2 disabled, …), or `null`. */
  account_status: number | null;
}

/** One ad of route 15's answer — the Meta ad object (1.6). */
export interface MetaAdOutput {
  ad_id: string;
  name: string | null;
  /** Meta's `effective_status` (`ACTIVE`, `PAUSED`, …). */
  status: string | null;
  ad_account_id: string;
  /** The Instagram post the ad runs, or `null` for an ad that is not an Instagram post. */
  instagram_media_id: string | null;
  /** The organization's channel account the ad runs as (matched by its Instagram id), or `null`. */
  channel_account_id: string | null;
  thumbnail_url: string | null;
  /** Meta's `created_time`, as sent. */
  created_at: string | null;
}

/** Route 41's result: the ad accounts and whether the connection may read ads (MC13). */
export interface ChannelConnectionAdAccountList {
  adAccess: ChannelConnectionAdAccess;
  items: MetaAdAccountOutput[];
}

/** Route 15's result: one page of one ad account's ads, Meta's cursor and the ad access (MC13). */
export interface ChannelConnectionAdPage {
  adAccess: ChannelConnectionAdAccess;
  items: MetaAdOutput[];
  /** The page size asked for (`meta.pagination.per_page`). */
  limit: number;
  /** Meta's `after` cursor of the next page, or `null` on the last page. */
  nextCursor: string | null;
}

/** A channel account as the connection's account port names it. */
export interface ChannelConnectionAccount {
  /** The account's internal id (its organization is the caller's). */
  internalId: number;
  publicId: string;
  channel: ChannelConnectionChannel;
  /** The provider's id of the account (Instagram: its user id). */
  providerAccountId: string;
  displayName: string;
  profilePictureUrl: string | null;
  connectionStatus: string;
  /** `app.channel_connections.id` of the connection the account came through. */
  channelConnectionId: number;
  /** Whether its webhook events are subscribed (the after-commit step skips one that is). */
  isWebhookSubscribed: boolean;
}

/** The organization scope and internal id every port call runs with. */
export interface ChannelConnectionAccountScope {
  /** The caller's organization scope; the port joins the caller's open unit of work. */
  scope: OrganizationPrincipalDatabaseScope;
  /** `tenancy.organizations.id` of the scope's organization. */
  organizationId: number;
}

/**
 * The channel accounts the connection brings in, as the connection needs them (routes-final § 1
 * MC5–MC8) — the port of sub-domain 1B (channel account) and 2 (its Instagram extension).
 *
 * @remarks
 * Built at ROUTE row R3 over the launch's `app.instagram_accounts` (P111); implemented since ROUTE
 * row R5 by `ChannelAccountService` on `app.channel_accounts` with its Instagram extension (P116). Every write joins the caller's unit of work; no provider call is made in
 * one — the subscribe and unsubscribe steps run outside any unit.
 */
export interface ChannelConnectionAccountPort {
  /** The not-revoked accounts of these connections. */
  listAccountsOfConnections(
    options: ChannelConnectionAccountScope & { channelConnectionIds: readonly number[] },
  ): Promise<ChannelConnectionAccount[]>;
  /** The organization's accounts (any status) with these provider ids. */
  findAccountsByProviderIds(
    options: ChannelConnectionAccountScope & { providerAccountIds: readonly string[] },
  ): Promise<ChannelConnectionAccount[]>;
  /** How many not-revoked accounts the organization has (the plan's count, MC7). */
  countLiveAccounts(options: ChannelConnectionAccountScope): Promise<number>;
  /** The organization holding a not-revoked account of this provider id, or `null` (any organization). */
  resolveLiveOrganizationPublicIdForProviderAccount(
    providerAccountId: string,
  ): Promise<string | null>;
  /**
   * MC6: every not-revoked account of the organization with one of these provider ids is attached to
   * the connection and set `connected`; returns the accounts with the connection each came from.
   */
  reconnectAccounts(
    options: ChannelConnectionAccountScope & {
      channelConnectionId: number;
      providerAccountIds: readonly string[];
    },
  ): Promise<Array<{ account: ChannelConnectionAccount; previousChannelConnectionId: number }>>;
  /**
   * MC7: a picked account connected on this connection — a new row with its default settings, or
   * the organization's own revoked row back.
   */
  connectPickedAccount(
    options: ChannelConnectionAccountScope & {
      channelConnectionId: number;
      providerAccountId: string;
      /** The pick's profile read, or `null` when it failed open (the username alone is enough). */
      profile: InstagramAccountProfile | null;
      username: string | null;
      connectedByUserId: number | null;
    },
  ): Promise<ChannelConnectionAccount>;
  /** MC8: every not-revoked account of the connection revoked; returns them. */
  revokeAccountsOfConnection(
    options: ChannelConnectionAccountScope & { channelConnectionId: number },
  ): Promise<ChannelConnectionAccount[]>;
  /**
   * MC11: every `connected` account of the connection → `error` in the caller's unit (the one guarded
   * change per account); each account that changed now gets one reconnect notice after the commit
   * (WC-46). Returns the accounts it changed.
   */
  markAccountsOfConnectionBroken(
    options: ChannelConnectionAccountScope & { channelConnectionId: number; requestId: string },
  ): Promise<ChannelConnectionAccount[]>;
  /** How many not-revoked accounts still use the connection. */
  countLiveAccountsOfConnection(
    options: ChannelConnectionAccountScope & { channelConnectionId: number },
  ): Promise<number>;
  /**
   * After commit, outside any unit of work: subscribes each account to the webhook fields and stamps
   * it (best effort, logged — AC-1.7). The account-set-up job (WC-30) replaces it at ROUTE row R40.
   */
  subscribeAccountsBestEffort(options: {
    scope: OrganizationPrincipalDatabaseScope;
    accounts: readonly ChannelConnectionAccount[];
    encryptedAccessToken: string;
    requestId: string;
  }): Promise<void>;
  /** Before "Disconnect business", outside any unit of work: unsubscribes each account (best effort). */
  unsubscribeAccountsBestEffort(options: {
    scope: OrganizationPrincipalDatabaseScope;
    accounts: readonly ChannelConnectionAccount[];
    encryptedAccessToken: string;
    requestId: string;
  }): Promise<void>;
}

/**
 * The lane steps of a pick, a reconnect and "Disconnect business" (routes-final § 1 MC6–MC8, CA5) —
 * the port of sub-domain 6's lane service, built with the lanes at ROUTE row R18. Until then the app
 * container passes none and the steps are skipped (no lane table exists).
 */
export interface ChannelConnectionLanePort {
  /** A new account's four `ready` lanes (MC7), in the caller's unit. */
  createLanesForAccount(
    options: ChannelConnectionAccountScope & { channelAccountId: number },
  ): Promise<void>;
  /** A reconnected account's login stops ended and its lanes woken (MC6), in the caller's unit. */
  endLoginStops(
    options: ChannelConnectionAccountScope & { channelAccountId: number },
  ): Promise<void>;
  /** A disconnected account's lanes stopped with no turn (MC8), in the caller's unit. */
  stopLanes(options: ChannelConnectionAccountScope & { channelAccountId: number }): Promise<void>;
}

/**
 * The trial step of a pick during a trial (routes-final § 1 MC7, sub-domain 8 BL14, BL18) — the
 * port of billing's trial service, built with `billing.trial_accounts` at ROUTE row R24. Until then
 * the app container passes none and a trial pick is checked only against the plan's limit.
 */
export interface ChannelConnectionTrialPort {
  /** `409 trial_used_by_account` when one of these provider ids already had a trial anywhere. */
  assertAccountsMayTrial(options: { providerAccountIds: readonly string[] }): Promise<void>;
  /** Records the picked accounts' trial rows, in the pick's unit of work. */
  recordTrialAccounts(
    options: ChannelConnectionAccountScope & { providerAccountIds: readonly string[] },
  ): Promise<void>;
}
