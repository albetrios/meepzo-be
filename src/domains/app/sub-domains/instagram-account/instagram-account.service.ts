import { runEnqueueAfterCommit } from '@/core/events/event-bus.js';
import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  subscribeInstagramWebhookFields,
  unsubscribeInstagramWebhookFields,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import type { ChannelConnectionTokenService } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { assertTeamOrganizationForRead } from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import { MILLISECONDS_PER_SECOND } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import type { ChannelAccountRepository } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import type {
  InstagramAccountBrokenConnectionStatus,
  InstagramAccountConnectionStatus,
} from './instagram-account.constants.js';
import type { InstagramAccountExtensionService } from './instagram-account-extension.service.js';
import type {
  InstagramAccountKey,
  InstagramAccountRepository,
  InstagramAccountRow,
} from './instagram-account.repository.js';
import { channelAccountNotFoundError } from '@/domains/app/sub-domains/channel-account/channel-account-error.util.js';
import {
  type InstagramConnectionBreak,
  enqueueInstagramReconnectNoticeBestEffort,
} from './queues/instagram-reconnect-notice.queue.js';
import type {
  InstagramAccountAccess,
  InstagramAccountDisconnectChange,
  InstagramAccountReadAccess,
  InstagramAccountMetaDisconnectInput,
  InstagramAccountVisibleConnectionStatus,
  InstagramAutomationAccountAccess,
  InstagramWebhookAccountState,
  InstagramWebhookProcessingAccount,
} from './instagram-account.types.js';

/**
 * Whether the account was connected — or connected again: a reconnect moves `connected_at` — after
 * Meta signed the request (D53). Such an account is a new connection the request never meant. Meta
 * signs whole seconds, so a connection of the same second counts as older; a request without
 * `issued_at` is never older than a connection.
 */
function isConnectedAfterMetaRequest({
  account,
  issuedAt,
}: {
  account: InstagramAccountRow;
  /** Meta's `issued_at` (Unix seconds), or `null` when it sent none. */
  issuedAt: number | null;
}): boolean {
  if (issuedAt === null) return false;
  return Math.floor(account.connected_at.getTime() / MILLISECONDS_PER_SECOND) > issuedAt;
}

/** What a failed Instagram call may say in a log line — its class and codes, never its text. */
function describeInstagramFailure(error: unknown): Record<string, unknown> {
  if (error instanceof MetaGraphApiError) {
    return {
      errorClass: error.errorClass,
      instagramErrorCode: error.instagramErrorCode,
      instagramErrorSubcode: error.instagramErrorSubcode,
      fbtraceId: error.fbtraceId,
    };
  }
  return { errorName: error instanceof Error ? error.name : typeof error };
}

/**
 * The Instagram account service (routes-final § 1.A): read (route 2, IA13), disconnect (route 4,
 * IA14), the live account and its encrypted token for the post and
 * story pickers (routes 5–6, IA16), the disconnect and profile erase of Meta's deauthorize and
 * data-deletion callbacks (routes 7–8, IA19, IA20) and of an organization delete (D54), the one
 * guarded status change every later caller uses (IA9), and the Instagram webhook's lookups — the
 * resolver a delivery entry is routed by and the account state its events are stored by (WH3, WH10).
 *
 * @remarks
 * Algorithm:
 * - Every route works in three steps (1.10): read in the caller's organization scope, close that
 *   unit of work, call Instagram, then write in one new unit of work — never an Instagram call
 *   inside a database context (`rls-context-network-isolation.global.test.ts`).
 * - Team-only (K1, IA3): the writes refuse a personal organization with `422`
 *   (`assertTeamOrganization`, capability `INSTAGRAM`) and the read with
 *   `404 team_organization_required` (`assertTeamOrganizationForRead`) — the second line behind the
 *   permission gate, since a personal Owner never holds the codes.
 *
 * Failure modes:
 * - `404 instagram_not_connected` (read, disconnect) — 1.A.9.
 *
 * Side effects:
 * - Moves the channel account's status (the guarded break and the revoke, through
 *   `ChannelAccountRepository`, CA4, CA8) and writes the Instagram extension through
 *   {@link InstagramAccountExtensionService} (2.A.10); with the connection's last account, revokes the
 *   connection and its token (through {@link ChannelConnectionTokenService}, CA8); calls Instagram
 *   (`subscribed_apps`).
 *   The audit entries are the controller's, after commit (D36).
 *
 * Notes:
 * - The launch's connect (route 1, Instagram Login) is gone (RC-6): accounts come in through a
 *   channel connection's pick (`ChannelAccountService`, feat-instagram-dm-sending MC7, R5).
 * - The token lives on the account's channel connection (P111) and stays ciphertext here: the
 *   client takes it encrypted (MC9).
 * - A disconnect cancels no automation run (IQ1, D24).
 */
export class InstagramAccountService {
  constructor(
    private readonly accountRepository: InstagramAccountRepository,
    private readonly extensionService: InstagramAccountExtensionService,
    private readonly channelAccountRepository: ChannelAccountRepository,
    private readonly connectionTokenService: ChannelConnectionTokenService,
    private readonly settingsService: InstagramAccountSettingsService,
    private readonly organizationService: OrganizationService,
  ) {}

  /**
   * The organization's not-revoked account — `connected` or `error`, the account route 2
   * reads (IA13) — or `null` when it has none: the account an automation is created on (routes-final
   * § 3.A AU27).
   *
   * @remarks
   * Algorithm: one read in the caller's organization scope; a caller already inside a unit of work
   * for that organization (the automation create) joins it, so the account is read in the same
   * transaction as the insert. Failure modes: none of its own — no team check (the caller makes
   * it) and no 404 (the caller answers `409 instagram_not_connected`). Side effects: none — never
   * Instagram; the token is never read.
   */
  async findLiveAccount({
    scope,
    organizationId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    /** `tenancy.organizations.id` of the scope's organization. */
    organizationId: number;
  }): Promise<InstagramAccountRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.accountRepository.findLiveByOrganizationId(organizationId),
    });
  }

  /**
   * The named Instagram account, its connection's status and its encrypted token, for a Meta read
   * made after the unit of work closes — the post and story pickers (routes 13–14, IA15).
   *
   * @remarks
   * Algorithm: one unit of work in the caller's organization scope — the team check
   * (`404 team_organization_required` on a personal organization), the channel account by its public
   * id, its Instagram row, then its connection's status and token (through
   * {@link ChannelConnectionTokenService.findConnectionAccess}). Failure modes:
   * `404 channel_account_not_found` when the id is not the organization's, the account is revoked,
   * or its channel is not `instagram` (2.5). Side effects: none — reads only, never Meta. Notes: an
   * `error` account or connection is returned as it is; the caller answers
   * `404 instagram_reconnect_required` without a call. The token stays ciphertext.
   */
  async findAccountReadAccess({
    scope,
    channelAccountPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    /** `cha_…` — the route's `{channel_account_id}` (P47). */
    channelAccountPublicId: string;
  }): Promise<InstagramAccountReadAccess> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        const channelAccount = await this.channelAccountRepository.findByPublicId({
          organizationId: organization.id,
          channelAccountPublicId,
        });
        if (
          channelAccount === null ||
          channelAccount.connection_status === 'revoked' ||
          channelAccount.channel !== 'instagram'
        ) {
          throw channelAccountNotFoundError();
        }
        const [account] = await this.accountRepository.findByChannelAccountIds({
          organizationId: organization.id,
          channelAccountIds: [channelAccount.id],
        });
        if (account === undefined) throw channelAccountNotFoundError();
        const channelConnection = {
          organizationId: organization.id,
          channelConnectionId: account.channel_connection_id,
        };
        const connection = await this.connectionTokenService.findConnectionAccess({
          scope,
          channelConnection,
        });
        return {
          account,
          channelAccount: { organizationId: organization.id, channelAccountId: channelAccount.id },
          channelConnection,
          connectionStatus: connection?.connectionStatus ?? 'revoked',
          encryptedAccessToken: connection?.encryptedAccessToken ?? null,
        };
      },
    });
  }

  /**
   * The public id of the organization whose not-revoked account has this Instagram user id, or
   * `null` — the narrow resolver (IA6) the Instagram webhook routes a delivery entry by before the
   * organization is known (WH3, K5).
   *
   * @remarks
   * Algorithm: `app.resolve_organization_public_id_for_instagram_user` (SECURITY DEFINER), outside
   * any database context. Failure modes: none of its own — no such account (or only a revoked one)
   * is `null`. Side effects: none; it reads no other column of another organization's row.
   */
  async resolveOrganizationPublicIdForInstagramUser(
    instagramUserId: string,
  ): Promise<string | null> {
    return this.accountRepository.resolveOrganizationPublicIdForInstagramUser(instagramUserId);
  }

  /**
   * The organization's not-revoked account with this webhook user id, its status and automation
   * switch — what the Instagram webhook stores a delivery entry's events by (WH3, WH10); `null`
   * when the organization holds no such account any more.
   *
   * @remarks
   * Algorithm: one unit of work in the caller's organization scope (the receiver's verified scope —
   * it joins the receiver's open unit): the organization, its live account (it must carry this
   * webhook user id) with its channel account's automation switch (P42). Failure modes: none of
   * its own — the organization gone, no live account, or a live account with another Instagram id
   * (disconnected and another connected since the resolver ran) are all `null`. Side effects: none
   * — reads only; never the token, never Instagram.
   */
  async findWebhookAccountState({
    scope,
    instagramUserId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    instagramUserId: string;
  }): Promise<InstagramWebhookAccountState | null> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.findOrganizationByPublicId(
          scope.organizationPublicId,
        );
        if (organization === null) return null;
        const account = await this.accountRepository.findLiveByOrganizationId(organization.id);
        if (account === null || account.instagram_user_id !== instagramUserId) return null;
        const instagramAccount: InstagramAccountKey = {
          organizationId: organization.id,
          instagramAccountId: account.id,
        };
        return {
          instagramAccount,
          channelAccountId: account.channel_account_id,
          instagramAccountPublicId: account.public_id,
          instagramUserId: account.instagram_user_id,
          connectionStatus: account.connection_status as InstagramAccountVisibleConnectionStatus,
          isAutomationEnabled: account.is_automation_enabled,
        };
      },
    });
  }

  /**
   * The event's account as the run engine sends with it (routes-final § 3.B, AU5, AU27): the
   * organization's not-revoked account when its public id is `instagramAccountPublicId`, with its
   * encrypted token and its settings; `null` when the organization holds no such account (gone,
   * revoked, or another account connected since the event).
   *
   * @remarks
   * Algorithm: one unit of work in the caller's organization scope (the job's, relayed by the
   * engine): the organization, its live account (it must carry this public id), the token
   * (through {@link ChannelConnectionTokenService}) and the settings row. Failure modes: none of its
   * own. Side effects: none — reads only, never Instagram. Notes: an `error` account
   * is returned with its status — the engine sends nothing for it; the token stays ciphertext
   * (IA5).
   */
  async findAutomationAccountAccess({
    scope,
    instagramAccountPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    /** `cha_…` — the event's account. */
    instagramAccountPublicId: string;
  }): Promise<InstagramAutomationAccountAccess | null> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.findOrganizationByPublicId(
          scope.organizationPublicId,
        );
        if (organization === null) return null;
        const account = await this.accountRepository.findLiveByOrganizationId(organization.id);
        if (account === null || account.public_id !== instagramAccountPublicId) return null;
        const instagramAccount: InstagramAccountKey = {
          organizationId: organization.id,
          instagramAccountId: account.id,
        };
        const token = await this.findAccountToken({ scope, account });
        const settings = await this.settingsService.findSettings({
          scope,
          channelAccount: {
            organizationId: organization.id,
            channelAccountId: account.channel_account_id,
          },
        });
        return {
          instagramAccount,
          instagramAccountPublicId: account.public_id,
          instagramUserId: account.instagram_user_id,
          username: account.username,
          connectionStatus: account.connection_status as InstagramAccountVisibleConnectionStatus,
          encryptedAccessToken: token?.encryptedAccessToken ?? null,
          settings,
        };
      },
    });
  }

  /**
   * The account Instagram webhook event processing works for (routes-final § 4.A, WH12, WH13): the
   * organization's account with this public id in any status, its automation switch and, while it
   * is `connected`, its encrypted token; `null` when the organization (live) holds no account with
   * this public id.
   *
   * @remarks
   * Algorithm: one unit of work in the caller's organization scope (the processing job's): the
   * organization, the account by its public id within that organization (revoked included — its
   * waiting events must still be marked) with its channel account's automation switch (P42), and
   * the token only for a `connected`
   * account (through {@link ChannelConnectionTokenService}). Read once when the job starts (the key
   * its claims use) and again before each event (the switch and the status can change while an
   * event waits, WH12). Failure modes: none of its own. Side effects: none — reads only, never
   * Instagram. Notes: the token stays ciphertext (IA5).
   */
  async findWebhookProcessingAccount({
    scope,
    instagramAccountPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    /** `cha_…` — the processing job's account. */
    instagramAccountPublicId: string;
  }): Promise<InstagramWebhookProcessingAccount | null> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.findOrganizationByPublicId(
          scope.organizationPublicId,
        );
        if (organization === null) return null;
        const account = await this.accountRepository.findByPublicIdInOrganization({
          organizationPublicId: scope.organizationPublicId,
          instagramAccountPublicId,
        });
        if (account === null) return null;
        const instagramAccount: InstagramAccountKey = {
          organizationId: organization.id,
          instagramAccountId: account.id,
        };
        const token =
          account.connection_status === 'connected'
            ? await this.findAccountToken({ scope, account })
            : null;
        return {
          instagramAccount,
          channelAccountId: account.channel_account_id,
          instagramAccountPublicId: account.public_id,
          connectionStatus: account.connection_status as InstagramAccountConnectionStatus,
          isAutomationEnabled: account.is_automation_enabled,
          encryptedAccessToken: token?.encryptedAccessToken ?? null,
        };
      },
    });
  }

  /**
   * Meta's deauthorize (IA19) or data deletion (IA20) in one organization the resolver named
   * (routes-final § 1 MC15, MC16): every account the match reaches there, connected before Meta
   * signed the request, is disconnected as route 8 does (CA8) — without the unsubscribe call, the
   * app is already removed — and, for a data deletion, its profile erased.
   *
   * @remarks
   * Algorithm: one unit of work in the given scope (joining the caller's, so the erasure service can
   * erase the stored posts in the same transaction): list and lock the reached accounts — by account,
   * every account of the signed provider account id, any status (a revoked row of the same person is
   * erased too); by business, every not-revoked account of the named connections (P56) — leave out
   * one connected (or connected again) after `issuedAt` — Meta retries a request it got no answer
   * for, and a new connection was never part of it (D53) — and {@link disconnectAccounts} the rest.
   * Failure modes: none of its own — an organization with no such account answers an empty list.
   * Side effects: revokes the channel accounts, clears their extensions' webhook stamp and, with a
   * connection's last account, revokes the connection and deletes its token (through
   * {@link ChannelConnectionTokenService}); settings stay. No Instagram call. Notes: a disconnect
   * cancels no automation run (IQ1, D24); safe to repeat — an account already changed answers every
   * flag `false`, one connected since is not in the answer. The row lock makes a connect racing this
   * one wait and then connect again on top of it.
   */
  async disconnectForMeta({
    scope,
    match,
    issuedAt,
    shouldEraseProfile,
  }: InstagramAccountMetaDisconnectInput): Promise<InstagramAccountDisconnectChange[]> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const accounts = await this.lockAccountsForMeta({ scope, match });
        return this.disconnectAccounts({
          scope,
          accounts: accounts.filter(
            (account) => !isConnectedAfterMetaRequest({ account, issuedAt }),
          ),
          shouldEraseProfile,
        });
      },
    });
  }

  /** The accounts a Meta callback's match reaches in the scope's organization, locked (MC15). */
  private async lockAccountsForMeta({
    scope,
    match,
  }: Pick<InstagramAccountMetaDisconnectInput, 'scope' | 'match'>): Promise<InstagramAccountRow[]> {
    if (match.kind === 'provider_account') {
      return this.accountRepository.lockByProviderAccountInOrganization({
        organizationPublicId: scope.organizationPublicId,
        providerAccountId: match.providerAccountId,
      });
    }
    const organization = await this.organizationService.findOrganizationByPublicId(
      scope.organizationPublicId,
    );
    if (organization === null) return [];
    return this.accountRepository.lockLiveByConnections({
      organizationId: organization.id,
      channelConnectionIds: match.channelConnectionIds,
    });
  }

  /**
   * The organization delete's unsubscribe (D54, IAC5): best effort, stops Instagram sending the
   * events of every not-revoked account of the organization.
   *
   * @remarks
   * Algorithm: one read in the organization's scope — its not-revoked accounts, each with its
   * connection's encrypted token — then, that unit closed, `DELETE subscribed_apps` for each account
   * that has a token. Failure modes: none — an organization gone, without live accounts or without
   * tokens calls nothing; a failed call is logged (`app.instagram_account.webhook_unsubscription_failed`)
   * and never blocks the delete. Side effects: at most one Instagram call per account. Notes: safe to
   * repeat — after the erase there is no token.
   */
  async unsubscribeForOrganizationOffboarding({
    scope,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
  }): Promise<void> {
    const accesses = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.findOrganizationByPublicId(
          scope.organizationPublicId,
        );
        if (organization === null) return [];
        const accounts = await this.accountRepository.listLiveByOrganizationId(organization.id);
        const found: InstagramAccountAccess[] = [];
        for (const account of accounts) {
          const token = await this.findAccountToken({ scope, account });
          found.push({
            account,
            instagramAccount: { organizationId: organization.id, instagramAccountId: account.id },
            encryptedAccessToken: token?.encryptedAccessToken ?? null,
          });
        }
        return found;
      },
    });
    for (const access of accesses) {
      await this.unsubscribeWebhookFieldsBestEffort({ scope, access, requestId: undefined });
    }
  }

  /**
   * The organization delete's disconnect (D54, IAC5): every account the organization ever held —
   * the live ones and the revoked ones — revoked, each connection's token erased and each profile
   * erased, as Meta's data deletion does ({@link disconnectAccounts}); then every connection still
   * live (one with no account left) revoked with its token, through sub-domain 1.
   *
   * @remarks
   * Algorithm: one unit of work in the organization's scope (joining the caller's, so the erasure
   * service can erase the stored posts in the same transaction): lock the organization's accounts,
   * disconnect each, then `ChannelConnectionTokenService.revokeOrganizationConnections`. Failure
   * modes: none of its own — an organization gone or without accounts answers an empty list. Side
   * effects: revokes the channel accounts and their connections, deletes the tokens, erases the
   * extensions' profiles; settings, automations, runs and contacts stay until the organization's
   * purge. No Instagram call. Notes: it must run before the organization is soft-deleted — row-level
   * security hides a deleted organization's rows from its own scope; safe to repeat.
   */
  async disconnectForOrganizationOffboarding({
    scope,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
  }): Promise<InstagramAccountDisconnectChange[]> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.findOrganizationByPublicId(
          scope.organizationPublicId,
        );
        if (organization === null) return [];
        const accounts = await this.accountRepository.lockByOrganizationId(organization.id);
        const changes = await this.disconnectAccounts({
          scope,
          accounts,
          shouldEraseProfile: true,
        });
        // A connection left with no account (a login without a pick) holds a token too (IAC5).
        await this.connectionTokenService.revokeOrganizationConnections({
          scope,
          organizationId: organization.id,
        });
        return changes;
      },
    });
  }

  /**
   * The one guarded way an account leaves `connected` (CA4, IA9): its channel account `connected` →
   * `error` — for the pickers, the daily check and sub-domains 3–4 on an Instagram token error. The
   * call that wins enqueues the break's reconnect notice after the commit.
   *
   * @remarks
   * Algorithm: one unit in the caller's organization scope (joining the caller's open unit for the
   * same organization): the Instagram row, then the guarded break of its channel account
   * (`ChannelAccountRepository.markBroken`); when it changed the row, the reconnect-notice job of
   * this break (job id = the account and the break's time — the channel account's `updated_at` at the
   * break, IAC9) is enqueued once that unit commits (`runEnqueueAfterCommit`), never if it rolls
   * back. Failure modes: none of its own — returns `null` when the account was not `connected` any
   * more (another caller won the race, or it was revoked), so only the winner enqueues a notice; a
   * failed enqueue is logged and the break stands. Side effects: the status change; one
   * `instagram-reconnect-notice` job per break. Notes: `expired` (Meta's subcode 463) lands as
   * `error` too — the channel account has no `expired` (CA4).
   */
  async markConnectionBroken({
    scope,
    instagramAccount,
    connectionStatus,
    requestId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    instagramAccount: InstagramAccountKey;
    connectionStatus: InstagramAccountBrokenConnectionStatus;
    /** The caller's request or job id, carried into the notice job for log correlation. */
    requestId?: string | undefined;
  }): Promise<InstagramAccountRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const account = await this.accountRepository.findById(instagramAccount);
        if (account === null) return null;
        const broken = await this.channelAccountRepository.markBroken({
          organizationId: account.organization_id,
          channelAccountId: account.channel_account_id,
        });
        if (broken === null) return null;
        const connectionBreak: InstagramConnectionBreak = {
          organizationPublicId: scope.organizationPublicId,
          instagramAccountPublicId: broken.public_id,
          connectionStatus,
          connectionStatusChangedAt: broken.updated_at,
        };
        await runEnqueueAfterCommit(() =>
          enqueueInstagramReconnectNoticeBestEffort({ connectionBreak, requestId }),
        );
        return this.accountRepository.findById(instagramAccount);
      },
    });
  }

  /**
   * The one erase of an account's connection, inside the caller's unit of work: revoke (a revoked row
   * stays as it is), erase the token and, when `shouldEraseProfile`, the profile (only once: an
   * erased profile stays as it is). One entry per account, its flags saying what changed now.
   */
  private async disconnectAccounts({
    scope,
    accounts,
    shouldEraseProfile,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    accounts: readonly InstagramAccountRow[];
    shouldEraseProfile: boolean;
  }): Promise<InstagramAccountDisconnectChange[]> {
    const changes: InstagramAccountDisconnectChange[] = [];
    for (const account of accounts) {
      const key: InstagramAccountKey = {
        organizationId: account.organization_id,
        instagramAccountId: account.id,
      };
      const revoked = await this.channelAccountRepository.revoke({
        organizationId: account.organization_id,
        channelAccountId: account.channel_account_id,
      });
      if (revoked !== null) {
        await this.extensionService.clearOnRevoke({ scope, instagramAccount: key });
      }
      const wasTokenErased = await this.releaseConnectionWhenUnused({ scope, account });
      const erased = shouldEraseProfile
        ? await this.extensionService.eraseProfile({ scope, instagramAccount: key })
        : null;
      changes.push({
        instagramAccount: key,
        channelAccount: {
          organizationId: account.organization_id,
          channelAccountId: account.channel_account_id,
        },
        instagramAccountPublicId: account.public_id,
        wasRevoked: revoked !== null,
        wasTokenErased,
        wasProfileErased: erased !== null,
      });
    }
    return changes;
  }

  /**
   * `DELETE subscribed_apps` outside any database context, when the account has a token. Never
   * throws: a failure is logged and the caller goes on.
   */
  async unsubscribeWebhookFieldsBestEffort({
    scope,
    access,
    requestId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    access: InstagramAccountAccess;
    /** The caller's request id; `undefined` when no request is at hand (an organization delete). */
    requestId: string | undefined;
  }): Promise<void> {
    if (access.encryptedAccessToken === null) return;
    try {
      await unsubscribeInstagramWebhookFields({
        encryptedAccessToken: access.encryptedAccessToken,
        instagramUserId: access.account.instagram_user_id,
        requestId,
      });
    } catch (error) {
      logger.warn(
        {
          requestId,
          organizationPublicId: scope.organizationPublicId,
          instagramAccountPublicId: access.account.public_id,
          ...describeInstagramFailure(error),
        },
        'app.instagram_account.webhook_unsubscription_failed',
      );
    }
  }

  /**
   * The account's encrypted token — its channel connection's (P111, MC9) — inside the caller's unit
   * of work; `null` when the connection has none (revoked).
   */
  private async findAccountToken({
    scope,
    account,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    account: InstagramAccountRow;
  }): Promise<{ encryptedAccessToken: string } | null> {
    return this.connectionTokenService.findAccessToken({
      scope,
      channelConnection: {
        organizationId: account.organization_id,
        channelConnectionId: account.channel_connection_id,
      },
    });
  }

  /**
   * CA8 (feat-instagram-dm-sending): once no other not-revoked account uses the revoked account's
   * connection, the connection is revoked and its token deleted, in the caller's unit of work.
   * Returns whether the token went now.
   */
  private async releaseConnectionWhenUnused({
    scope,
    account,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    account: InstagramAccountRow;
  }): Promise<boolean> {
    const channelConnection = {
      organizationId: account.organization_id,
      channelConnectionId: account.channel_connection_id,
    };
    const liveCount = await this.channelAccountRepository.countLiveByConnection(channelConnection);
    if (liveCount > 0) return false;
    return this.connectionTokenService.revokeConnection({ scope, channelConnection });
  }

  /**
   * `subscribed_apps` after a pick's or a reconnect's commit when the account is not subscribed yet
   * (MC7, AC-1.7); returns the account as it now stands. Never throws: a failure is logged and the
   * account stays connected (the daily check retries).
   */
  async subscribeWebhookFieldsBestEffort({
    scope,
    account,
    encryptedAccessToken,
    requestId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    account: InstagramAccountRow;
    encryptedAccessToken: string;
    requestId: string | undefined;
  }): Promise<InstagramAccountRow> {
    if (account.webhook_subscribed_at !== null) return account;
    try {
      await subscribeInstagramWebhookFields({
        encryptedAccessToken,
        instagramUserId: account.instagram_user_id,
        requestId,
      });
      const stamped = await this.extensionService.recordWebhookSubscribed({
        scope,
        instagramAccount: {
          organizationId: account.organization_id,
          instagramAccountId: account.id,
        },
      });
      return stamped ?? account;
    } catch (error) {
      logger.warn(
        {
          requestId,
          organizationPublicId: scope.organizationPublicId,
          instagramAccountPublicId: account.public_id,
          ...describeInstagramFailure(error),
        },
        'app.instagram_account.webhook_subscription_failed',
      );
      return account;
    }
  }
}
