import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type {
  ChannelConnectionAccount,
  ChannelConnectionAccountPort,
  ChannelConnectionAccountScope,
} from '@/domains/app/sub-domains/channel-connection/channel-connection.types.js';
import type { InstagramAccountProfile } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import type {
  InstagramAccountKey,
  InstagramAccountRepository,
  InstagramAccountRow,
} from './instagram-account.repository.js';
import type { InstagramAccountService } from './instagram-account.service.js';

/** The account as the channel connection's port names it. */
function toConnectionAccount(account: InstagramAccountRow): ChannelConnectionAccount {
  return {
    internalId: account.id,
    publicId: account.public_id,
    channel: 'instagram',
    providerAccountId: account.instagram_user_id,
    displayName: account.username === null ? account.instagram_user_id : `@${account.username}`,
    profilePictureUrl: account.profile_picture_url,
    // The launch's `expired` is the connection's `error` (D24: the connection's token never ends).
    connectionStatus: account.connection_status === 'expired' ? 'error' : account.connection_status,
    channelConnectionId: account.channel_connection_id,
    isWebhookSubscribed: account.webhook_subscribed_at !== null,
  };
}

/** The account's key from its row. */
function keyOf(account: InstagramAccountRow): InstagramAccountKey {
  return { organizationId: account.organization_id, instagramAccountId: account.id };
}

/**
 * The channel connection's account port over the launch's `app.instagram_accounts`
 * (feat-instagram-dm-sending routes-final § 1 MC5–MC8, P111): the accounts a connection brings in,
 * the plan's count, the reconnect, the pick's write with its default settings, the revoke of
 * "Disconnect business", the break of a connection (MC11) and the webhook subscription steps.
 *
 * @remarks
 * Algorithm:
 * - Every database method runs in `withAppDatabaseContext` with the caller's organization scope,
 *   joining the caller's open unit of work (the callback's, the pick's, the disconnect's commit).
 * - The subscribe and unsubscribe steps run outside any unit (never a Meta call inside one), through
 *   the account service's best-effort calls.
 *
 * Failure modes:
 * - A pick that races another organization for the same Instagram account fails the unique index
 *   `idx_instagram_accounts_instagram_user_live` (23505) — the caller maps it.
 *
 * Side effects:
 * - Writes `app.instagram_accounts` and `app.instagram_account_settings`; Meta's `subscribed_apps`.
 *
 * Notes:
 * - A bridge until ROUTE row R5 builds `app.channel_accounts` (1B) and R6 the Instagram extension
 *   (2.A): they implement {@link ChannelConnectionAccountPort} on the new tables and replace this in
 *   the app container. `instagram_app_user_id` takes the Instagram user id — the id Unified Login's
 *   Graph calls take.
 */
export class InstagramAccountConnectionService implements ChannelConnectionAccountPort {
  constructor(
    private readonly accountRepository: InstagramAccountRepository,
    private readonly settingsService: InstagramAccountSettingsService,
    private readonly accountService: InstagramAccountService,
  ) {}

  /** The not-revoked accounts of these connections, oldest connected first. */
  async listAccountsOfConnections({
    scope,
    organizationId,
    channelConnectionIds,
  }: ChannelConnectionAccountScope & {
    channelConnectionIds: readonly number[];
  }): Promise<ChannelConnectionAccount[]> {
    const accounts = await withAppDatabaseContext({
      scope,
      callback: () =>
        this.accountRepository.listLiveByConnections({ organizationId, channelConnectionIds }),
    });
    return accounts.map(toConnectionAccount);
  }

  /** The organization's accounts, any status, with these Instagram user ids. */
  async findAccountsByProviderIds({
    scope,
    organizationId,
    providerAccountIds,
  }: ChannelConnectionAccountScope & {
    providerAccountIds: readonly string[];
  }): Promise<ChannelConnectionAccount[]> {
    const accounts = await withAppDatabaseContext({
      scope,
      callback: () =>
        this.accountRepository.findByInstagramUserIds({
          organizationId,
          instagramUserIds: providerAccountIds,
        }),
    });
    return accounts.map(toConnectionAccount);
  }

  /** How many not-revoked accounts the organization has. */
  async countLiveAccounts({
    scope,
    organizationId,
  }: ChannelConnectionAccountScope): Promise<number> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.accountRepository.countLiveByOrganizationId(organizationId),
    });
  }

  /** The organization holding this Instagram account live, or `null` (the IA6 resolver). */
  async resolveLiveOrganizationPublicIdForProviderAccount(
    providerAccountId: string,
  ): Promise<string | null> {
    return this.accountService.resolveOrganizationPublicIdForInstagramUser(providerAccountId);
  }

  /** MC6: the organization's not-revoked accounts of these ids attached to the connection, `connected`. */
  async reconnectAccounts({
    scope,
    organizationId,
    channelConnectionId,
    providerAccountIds,
  }: ChannelConnectionAccountScope & {
    channelConnectionId: number;
    providerAccountIds: readonly string[];
  }): Promise<Array<{ account: ChannelConnectionAccount; previousChannelConnectionId: number }>> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const accounts = await this.accountRepository.findByInstagramUserIds({
          organizationId,
          instagramUserIds: providerAccountIds,
        });
        const reconnected: Array<{
          account: ChannelConnectionAccount;
          previousChannelConnectionId: number;
        }> = [];
        for (const account of accounts) {
          if (account.connection_status === 'revoked') continue;
          const attached = await this.accountRepository.attachToConnection({
            ...keyOf(account),
            channelConnectionId,
          });
          if (attached === null) continue;
          reconnected.push({
            account: toConnectionAccount(attached),
            previousChannelConnectionId: account.channel_connection_id,
          });
        }
        return reconnected;
      },
    });
  }

  /** MC7: the picked account connected on this connection, with its default settings. */
  async connectPickedAccount({
    scope,
    organizationId,
    channelConnectionId,
    providerAccountId,
    profile,
    username,
    scopes,
    connectedByUserId,
  }: ChannelConnectionAccountScope & {
    channelConnectionId: number;
    providerAccountId: string;
    profile: InstagramAccountProfile | null;
    username: string | null;
    scopes: readonly string[];
    connectedByUserId: number | null;
  }): Promise<ChannelConnectionAccount> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const { account } = await this.accountRepository.upsertConnected({
          organizationId,
          channelConnectionId,
          instagramUserId: providerAccountId,
          instagramAppUserId: providerAccountId,
          username: profile?.username ?? username ?? providerAccountId,
          name: profile?.name ?? null,
          biography: profile?.biography ?? null,
          website: profile?.website ?? null,
          profilePictureUrl: profile?.profilePictureUrl ?? null,
          followersCount: profile?.followersCount ?? 0,
          followsCount: profile?.followsCount ?? 0,
          mediaCount: profile?.mediaCount ?? 0,
          scopes: [...new Set(scopes)].slice(0, 20),
          connectedByUserId,
        });
        await this.settingsService.createDefaultSettings({
          scope,
          instagramAccount: keyOf(account),
        });
        return toConnectionAccount(account);
      },
    });
  }

  /** MC8: every not-revoked account of the connection revoked. */
  async revokeAccountsOfConnection({
    scope,
    organizationId,
    channelConnectionId,
  }: ChannelConnectionAccountScope & {
    channelConnectionId: number;
  }): Promise<ChannelConnectionAccount[]> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const accounts = await this.accountRepository.listLiveByConnections({
          organizationId,
          channelConnectionIds: [channelConnectionId],
        });
        const revoked: ChannelConnectionAccount[] = [];
        for (const account of accounts) {
          const row = await this.accountRepository.revoke(keyOf(account));
          if (row !== null) revoked.push(toConnectionAccount(row));
        }
        return revoked;
      },
    });
  }

  /**
   * MC11: every `connected` account of the connection → `error` through the account service's
   * guarded break (IA9), which enqueues each winner's reconnect notice after the commit.
   */
  async markAccountsOfConnectionBroken({
    scope,
    organizationId,
    channelConnectionId,
    requestId,
  }: ChannelConnectionAccountScope & {
    channelConnectionId: number;
    requestId: string;
  }): Promise<ChannelConnectionAccount[]> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const accounts = await this.accountRepository.listLiveByConnections({
          organizationId,
          channelConnectionIds: [channelConnectionId],
        });
        const broken: ChannelConnectionAccount[] = [];
        for (const account of accounts) {
          if (account.connection_status !== 'connected') continue;
          const changed = await this.accountService.markConnectionBroken({
            scope,
            instagramAccount: keyOf(account),
            connectionStatus: 'error',
            requestId,
          });
          if (changed !== null) broken.push(toConnectionAccount(changed));
        }
        return broken;
      },
    });
  }

  /** How many not-revoked accounts still use the connection. */
  async countLiveAccountsOfConnection({
    scope,
    organizationId,
    channelConnectionId,
  }: ChannelConnectionAccountScope & { channelConnectionId: number }): Promise<number> {
    return withAppDatabaseContext({
      scope,
      callback: () =>
        this.accountRepository.countLiveByConnection({ organizationId, channelConnectionId }),
    });
  }

  /** After commit: each not-subscribed account subscribed to the webhook fields (best effort). */
  async subscribeAccountsBestEffort({
    scope,
    accounts,
    encryptedAccessToken,
    requestId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    accounts: readonly ChannelConnectionAccount[];
    encryptedAccessToken: string;
    requestId: string;
  }): Promise<void> {
    for (const target of accounts) {
      if (target.isWebhookSubscribed) continue;
      const account = await this.readAccount({ scope, target });
      if (account === null) continue;
      await this.accountService.subscribeWebhookFieldsBestEffort({
        scope,
        account,
        encryptedAccessToken,
        requestId,
      });
    }
  }

  /** Before "Disconnect business": each account unsubscribed (best effort). */
  async unsubscribeAccountsBestEffort({
    scope,
    accounts,
    encryptedAccessToken,
    requestId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    accounts: readonly ChannelConnectionAccount[];
    encryptedAccessToken: string;
    requestId: string;
  }): Promise<void> {
    for (const target of accounts) {
      const account = await this.readAccount({ scope, target });
      if (account === null) continue;
      await this.accountService.unsubscribeWebhookFieldsBestEffort({
        scope,
        access: {
          account,
          instagramAccount: keyOf(account),
          encryptedAccessToken,
        },
        requestId,
      });
    }
  }

  /** The account row behind a port account, in the scope's organization. */
  private async readAccount({
    scope,
    target,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    target: ChannelConnectionAccount;
  }): Promise<InstagramAccountRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: () =>
        this.accountRepository.findByPublicIdInOrganization({
          organizationPublicId: scope.organizationPublicId,
          instagramAccountPublicId: target.publicId,
        }),
    });
  }
}
