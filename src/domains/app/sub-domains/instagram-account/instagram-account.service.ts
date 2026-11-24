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
import {
  assertTeamOrganization,
  assertTeamOrganizationForRead,
} from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import { MILLISECONDS_PER_SECOND } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import { serializeInstagramAccountSettings } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.serializer.js';
import type { InstagramAccountSettingsRow } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import type {
  InstagramAccountBrokenConnectionStatus,
  InstagramAccountConnectionStatus,
} from './instagram-account.constants.js';
import type {
  InstagramAccountKey,
  InstagramAccountRepository,
  InstagramAccountRow,
} from './instagram-account.repository.js';
import { instagramNotConnectedError } from './instagram-account-error.util.js';
import {
  type InstagramConnectionBreak,
  enqueueInstagramReconnectNoticeBestEffort,
} from './queues/instagram-reconnect-notice.queue.js';
import { serializeInstagramAccount } from './instagram-account.serializer.js';
import type {
  InstagramAccountAccess,
  InstagramAccountDisconnectChange,
  InstagramAccountDisconnectInput,
  InstagramAccountMetaDisconnectInput,
  InstagramAccountOutput,
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
 * - Writes the account; reads and — with the connection's last account — revokes the connection's
 *   token (through {@link ChannelConnectionTokenService}, CA8); calls Instagram (`subscribed_apps`).
 *   The audit entries are the controller's, after commit (D36).
 *
 * Notes:
 * - The launch's connect (route 1, Instagram Login) is gone (RC-6): accounts come in through a
 *   channel connection's pick (`InstagramAccountConnectionService`, feat-instagram-dm-sending MC7).
 * - The token lives on the account's channel connection (P111) and stays ciphertext here: the
 *   client takes it encrypted (MC9).
 * - A disconnect cancels no automation run (IQ1, D24).
 */
export class InstagramAccountService {
  constructor(
    private readonly accountRepository: InstagramAccountRepository,
    private readonly connectionTokenService: ChannelConnectionTokenService,
    private readonly settingsService: InstagramAccountSettingsService,
    private readonly organizationService: OrganizationService,
  ) {}

  /**
   * The organization's not-revoked account with its settings (route 2, IA13) — `expired` and
   * `error` included, so a reload shows the reconnect card.
   *
   * @remarks
   * Algorithm: one unit of work — the team check (`404 team_organization_required` on a personal
   * organization), the live account, its settings, the two users' public ids. Failure modes:
   * `404 instagram_not_connected` when the organization has none (or only revoked rows). Side
   * effects: none — the database only, never Instagram; the token is never read.
   */
  async getAccount({
    scope,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
  }): Promise<InstagramAccountOutput> {
    const { account, settings } = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        const account = await this.accountRepository.findLiveByOrganizationId(organization.id);
        if (account === null) throw instagramNotConnectedError();
        const settings = await this.settingsService.findSettings({
          scope,
          instagramAccount: { organizationId: organization.id, instagramAccountId: account.id },
        });
        return { account, settings };
      },
    });
    if (settings === null) {
      // The connect transaction always writes the settings row with the account (1.B.10).
      throw new Error('instagram account has no settings row');
    }
    const userPublicIds = await this.resolveUserPublicIds({ account, settings });
    return this.toAccountOutput({ account, settings, userPublicIds });
  }

  /**
   * The organization's not-revoked account — `connected`, `expired` or `error`, the account route 2
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
   * The organization's live account and its encrypted token, for an Instagram read made after the
   * unit of work closes — the post and story pickers (routes 5–6, IA16).
   *
   * @remarks
   * Algorithm: one unit of work in the caller's organization scope — the team check
   * (`404 team_organization_required` on a personal organization, IA3), the live account, its
   * encrypted token (through {@link ChannelConnectionTokenService}). Failure modes:
   * `404 instagram_not_connected` when the organization has none (or only revoked rows). Side
   * effects: none — reads only, never Instagram. Notes: an `expired` or `error` account is returned
   * as it is; the caller decides (`404 instagram_reconnect_required` without a call). The token
   * stays ciphertext (IA5).
   */
  async findLiveAccountAccess({
    scope,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
  }): Promise<InstagramAccountAccess> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        const access = await this.findLiveAccess({ scope, organizationId: organization.id });
        if (access === null) throw instagramNotConnectedError();
        return access;
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
   * webhook user id), the account's settings. Failure modes: none of its own — the organization
   * gone, no live account, or a live account with another Instagram id (disconnected and another
   * connected since the resolver ran) are all `null`. Side effects: none — reads only; never the
   * token, never Instagram. Notes: an account without its settings row reads the column default
   * (automation on) — connect always creates the row (IA12).
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
        const settings = await this.settingsService.findSettings({ scope, instagramAccount });
        return {
          instagramAccount,
          instagramAccountPublicId: account.public_id,
          instagramUserId: account.instagram_user_id,
          instagramAppUserId: account.instagram_app_user_id,
          connectionStatus: account.connection_status as InstagramAccountVisibleConnectionStatus,
          isAutomationEnabled: settings?.is_automation_enabled ?? true,
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
   * own. Side effects: none — reads only, never Instagram. Notes: an `expired` or `error` account
   * is returned with its status — the engine sends nothing for it; the token stays ciphertext
   * (IA5).
   */
  async findAutomationAccountAccess({
    scope,
    instagramAccountPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    /** `iga_…` — the event's account. */
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
        const settings = await this.settingsService.findSettings({ scope, instagramAccount });
        return {
          instagramAccount,
          instagramAccountPublicId: account.public_id,
          instagramAppUserId: account.instagram_app_user_id,
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
   * waiting events must still be marked), its settings row, and the token only for a `connected`
   * account (through {@link ChannelConnectionTokenService}). Read once when the job starts (the key
   * its claims use) and again before each event (the switch and the status can change while an
   * event waits, WH12). Failure modes: none of its own. Side effects: none — reads only, never
   * Instagram. Notes: an account without its settings row reads the column default (automation
   * on); the token stays ciphertext (IA5).
   */
  async findWebhookProcessingAccount({
    scope,
    instagramAccountPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    /** `iga_…` — the processing job's account. */
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
        const settings = await this.settingsService.findSettings({ scope, instagramAccount });
        const token =
          account.connection_status === 'connected'
            ? await this.findAccountToken({ scope, account })
            : null;
        return {
          instagramAccount,
          instagramAccountPublicId: account.public_id,
          connectionStatus: account.connection_status as InstagramAccountConnectionStatus,
          isAutomationEnabled: settings?.is_automation_enabled ?? true,
          encryptedAccessToken: token?.encryptedAccessToken ?? null,
        };
      },
    });
  }

  /**
   * Disconnects the organization's account (route 4, IA14): a best-effort unsubscribe, then one
   * transaction — `revoked`, `disconnected_at`, the token erased, the expiry copy and the webhook
   * stamp emptied. Settings and profile stay; no run is cancelled (IQ1). Returns the revoked
   * account's public id for the caller's audit entry.
   *
   * @remarks
   * Algorithm:
   * 1. Organization scope: the team check (`422`), the live account (`404 instagram_not_connected`)
   *    and its encrypted token.
   * 2. Outside any context, when a token is there: `DELETE subscribed_apps`; a failure is logged
   *    (`app.instagram_account.webhook_unsubscription_failed`) and never blocks.
   * 3. One transaction: revoke (a concurrent disconnect that won → `404 instagram_not_connected`),
   *    erase the token.
   *
   * Failure modes: as above. Side effects: the transaction of step 3; one Instagram call. The
   * audit entry is the controller's, after commit (the repository's audit-emission pattern).
   */
  async disconnect({
    scope,
    requestId,
  }: InstagramAccountDisconnectInput): Promise<{ instagramAccountPublicId: string }> {
    const access = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const access = await this.findLiveAccess({ scope, organizationId: organization.id });
        if (access === null) throw instagramNotConnectedError();
        return access;
      },
    });

    await this.unsubscribeWebhookFieldsBestEffort({ scope, access, requestId });

    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const revoked = await this.accountRepository.revoke(access.instagramAccount);
        if (revoked === null) throw instagramNotConnectedError();
        await this.releaseConnectionWhenUnused({ scope, account: revoked });
        return { instagramAccountPublicId: revoked.public_id };
      },
    });
  }

  /**
   * The public ids of every organization holding a row of this app-scoped Instagram id, any status
   * — the first step of Meta's deauthorize and data-deletion callbacks (IA6, IA19, IA20; IQ3: Meta
   * signs the app-scoped id).
   *
   * @remarks
   * Algorithm: the SECURITY DEFINER resolver
   * `app.resolve_organization_public_ids_for_instagram_app_user`, outside any database context —
   * it returns public ids only and reads no other column of another organization's row. Failure
   * modes: none of its own; empty when no organization ever stored this id. Side effects: none.
   */
  async resolveOrganizationPublicIdsForInstagramAppUser(
    instagramAppUserId: string,
  ): Promise<string[]> {
    return this.accountRepository.resolveOrganizationPublicIdsForInstagramAppUser(
      instagramAppUserId,
    );
  }

  /**
   * Meta's deauthorize (IA19) or data deletion (IA20) in one organization: every account there with
   * this app-scoped id, connected before Meta signed the request, is disconnected as route 4 does
   * (IA14) — without the unsubscribe call, the app is already removed — and, for a data deletion,
   * its profile erased.
   *
   * @remarks
   * Algorithm: one unit of work in the given scope (joining the caller's, so the erasure service can
   * erase the stored posts in the same transaction): list and lock the organization's accounts of
   * this app-scoped id (any status — a revoked row of the same person is erased too); leave out one
   * connected (or connected again) after `issuedAt` — Meta retries a request it got no answer for,
   * and a new connection was never part of it (D53) — and {@link disconnectAccounts} the rest.
   * Failure modes: none of its own — an organization with no such account answers an empty list.
   * Side effects: writes `app.instagram_accounts` and, with a connection's last account, revokes the connection and deletes its token
   * (through {@link ChannelConnectionTokenService}); settings stay. No Instagram call. Notes: a
   * disconnect cancels no automation run (IQ1, D24); safe to repeat — an account already changed
   * answers every flag `false`, one connected since is not in the answer. The row lock makes a
   * connect racing this one wait and then connect again on top of it.
   */
  async disconnectForMeta({
    scope,
    instagramAppUserId,
    issuedAt,
    shouldEraseProfile,
  }: InstagramAccountMetaDisconnectInput): Promise<InstagramAccountDisconnectChange[]> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const accounts = await this.accountRepository.lockByInstagramAppUserInOrganization({
          organizationPublicId: scope.organizationPublicId,
          instagramAppUserId,
        });
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

  /**
   * The organization delete's unsubscribe (D54): best effort, stops Instagram sending the live
   * account's events.
   *
   * @remarks
   * Algorithm: one read in the organization's scope — its live account and encrypted token — then,
   * that unit closed and only when there is a token, `DELETE subscribed_apps`. Failure modes: none —
   * an organization gone, without a live account or without a token calls nothing; a failed call is
   * logged (`app.instagram_account.webhook_unsubscription_failed`) and never blocks the delete. Side
   * effects: at most one Instagram call. Notes: safe to repeat — after the erase there is no token.
   */
  async unsubscribeForOrganizationOffboarding({
    scope,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
  }): Promise<void> {
    const access = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.findOrganizationByPublicId(
          scope.organizationPublicId,
        );
        return organization === null
          ? null
          : this.findLiveAccess({ scope, organizationId: organization.id });
      },
    });
    if (access === null) return;
    await this.unsubscribeWebhookFieldsBestEffort({ scope, access, requestId: undefined });
  }

  /**
   * The organization delete's disconnect (D54): every account the organization ever held — the live
   * one and the revoked ones — revoked, its token erased and its profile erased, as Meta's data
   * deletion does ({@link disconnectAccounts}).
   *
   * @remarks
   * Algorithm: one unit of work in the organization's scope (joining the caller's, so the erasure
   * service can erase the stored posts in the same transaction): lock the organization's accounts,
   * then disconnect each. Failure modes: none of its own — an organization gone or without accounts
   * answers an empty list. Side effects: writes `app.instagram_accounts`, revokes its connections
   * and deletes their tokens; settings, automations, runs and contacts stay until the
   * organization's purge. No Instagram call. Notes: it must run before the organization is
   * soft-deleted — row-level security hides a deleted organization's rows from its own scope; safe
   * to repeat.
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
        return this.disconnectAccounts({ scope, accounts, shouldEraseProfile: true });
      },
    });
  }

  /**
   * The one guarded way an account leaves `connected` (IA9): `connected` → `expired` | `error`,
   * stamping `connection_status_changed_at` — for routes 5–6, the daily check and sub-domains 3–4
   * on an Instagram token error. The call that wins enqueues the break's reconnect notice after the
   * commit.
   *
   * @remarks
   * Algorithm: one guarded update in the caller's organization scope (joining the caller's open
   * unit of work for the same organization); when it changed the row, the reconnect-notice job of
   * this break (job id = the account and `connection_status_changed_at`, IAC9) is enqueued once
   * that unit commits (`runEnqueueAfterCommit` — over HTTP from the request's after-commit flush,
   * in a worker right after the commit), never if it rolls back. Failure modes: none of its own —
   * returns `null` when the account was not `connected` any more (another caller won the race, or
   * it was revoked), so only the winner enqueues a notice; a failed enqueue is logged and the break
   * stands. Side effects: the status change; one `instagram-reconnect-notice` job per break.
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
        const broken = await this.accountRepository.markConnectionBroken({
          ...instagramAccount,
          connectionStatus,
        });
        if (broken !== null) {
          const connectionBreak: InstagramConnectionBreak = {
            organizationPublicId: scope.organizationPublicId,
            instagramAccountPublicId: broken.public_id,
            connectionStatus,
            connectionStatusChangedAt: broken.connection_status_changed_at,
          };
          await runEnqueueAfterCommit(() =>
            enqueueInstagramReconnectNoticeBestEffort({ connectionBreak, requestId }),
          );
        }
        return broken;
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
      const revoked = await this.accountRepository.revoke(key);
      const wasTokenErased = await this.releaseConnectionWhenUnused({ scope, account });
      const erased = shouldEraseProfile ? await this.accountRepository.eraseProfile(key) : null;
      changes.push({
        instagramAccount: key,
        instagramAccountPublicId: account.public_id,
        wasRevoked: revoked !== null,
        wasTokenErased,
        wasProfileErased: erased !== null,
      });
    }
    return changes;
  }

  /**
   * The organization's not-revoked account, its key and its encrypted token, inside the caller's
   * unit of work; `null` when it has none.
   */
  private async findLiveAccess({
    scope,
    organizationId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
  }): Promise<InstagramAccountAccess | null> {
    const account = await this.accountRepository.findLiveByOrganizationId(organizationId);
    if (account === null) return null;
    const instagramAccount: InstagramAccountKey = {
      organizationId,
      instagramAccountId: account.id,
    };
    const token = await this.findAccountToken({ scope, account });
    return {
      account,
      instagramAccount,
      encryptedAccessToken: token?.encryptedAccessToken ?? null,
    };
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
        instagramAppUserId: access.account.instagram_app_user_id,
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
    const liveCount = await this.accountRepository.countLiveByConnection(channelConnection);
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
        instagramAppUserId: account.instagram_app_user_id,
        requestId,
      });
      const key: InstagramAccountKey = {
        organizationId: account.organization_id,
        instagramAccountId: account.id,
      };
      const stamped = await withAppDatabaseContext({
        scope,
        callback: async () => {
          const recorded = await this.accountRepository.recordWebhookSubscribed(key);
          return recorded ? this.accountRepository.findById(key) : null;
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

  /** The `usr_…` ids of the connecting user and the settings' last editor (one resolver call). */
  private async resolveUserPublicIds({
    account,
    settings,
  }: {
    account: InstagramAccountRow;
    settings: InstagramAccountSettingsRow;
  }): Promise<ReadonlyMap<number, string>> {
    return this.organizationService.resolveUserPublicIdsByInternalIds(
      [account.connected_by_user_id, settings.updated_by_user_id].filter(
        (identifier): identifier is number => identifier !== null,
      ),
    );
  }

  /** The account object from rows already read — no read of its own. */
  private toAccountOutput({
    account,
    settings,
    userPublicIds,
  }: {
    account: InstagramAccountRow;
    settings: InstagramAccountSettingsRow;
    userPublicIds: ReadonlyMap<number, string>;
  }): InstagramAccountOutput {
    const publicIdOf = (identifier: number | null): string | null =>
      identifier === null ? null : (userPublicIds.get(identifier) ?? null);
    return serializeInstagramAccount({
      account,
      settings: serializeInstagramAccountSettings({
        settings,
        updated_by_user_public_id: publicIdOf(settings.updated_by_user_id),
      }),
      connected_by_user_public_id: publicIdOf(account.connected_by_user_id),
    });
  }
}
