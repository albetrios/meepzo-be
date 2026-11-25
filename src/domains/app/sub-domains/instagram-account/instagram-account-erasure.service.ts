import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { ChannelAccountKey } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import type { ChannelConnectionLanePort } from '@/domains/app/sub-domains/channel-connection/channel-connection.types.js';
import type { InstagramMediaService } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.service.js';
import type { InstagramAccountService } from './instagram-account.service.js';
import type {
  InstagramAccountDisconnectChange,
  InstagramAccountErasure,
  InstagramAccountMetaErasureInput,
} from './instagram-account.types.js';

/**
 * The one place an Instagram account's data is erased in an organization: Meta's deauthorize and
 * data-deletion callbacks (IA19, IA20) and the organization's delete (D54) — the account revoked, its
 * token erased and, except on a deauthorize, its profile and its stored posts erased, in one
 * transaction.
 *
 * @remarks
 * Algorithm:
 * - The account service disconnects (and erases the profile), the media service deletes the stored
 *   posts of each account it disconnected (IQ4), in the same unit of work in the organization's own
 *   scope. Only the accounts something changed on are named, so a repeat reports nothing.
 *
 * Failure modes:
 * - A database failure rolls the whole erase back and reaches the caller: Meta retries its request,
 *   and an organization delete stops before the soft delete (its reconcile worker starts it again).
 *
 * Side effects:
 * - Revokes the channel accounts and writes their Instagram extensions; deletes the connections'
 *   tokens (`app.channel_connection_tokens`, sub-domain 1) and the `app.instagram_media` rows, through
 *   the owners' services; on an organization delete, one best-effort Instagram call per live account
 *   outside the transaction, and every connection of the organization revoked (IAC5) with the
 *   sending lanes of each account it revoked stopped in the same transaction, through the lane port
 *   (sub-domain 6's lane service, as route 8 does, CA8). The audit entries are the callers'
 *   controllers' (D36).
 *
 * Notes:
 * - No run is cancelled and automations stay as they are (IQ1, D24): an automation names a post by
 *   its Instagram media id, and a deleted organization's rows go with its purge.
 */
export class InstagramAccountErasureService {
  constructor(
    private readonly accountService: InstagramAccountService,
    private readonly mediaService: InstagramMediaService,
    /** Sub-domain 6's lane service: an organization delete stops the revoked accounts' lanes. */
    private readonly lanePort: Pick<ChannelConnectionLanePort, 'stopLanes'>,
  ) {}

  /**
   * Meta's deauthorize or data deletion in one organization the resolver named (IA19, IA20).
   *
   * @remarks
   * Algorithm: one transaction in the given verified scope —
   * {@link InstagramAccountService.disconnectForMeta} (an account connected after Meta signed the
   * request is left alone, D53), then on a data deletion the stored posts. Failure modes: as the class
   * lists. Side effects: as the class lists, no Instagram call (the app is already removed). Returns
   * `null` when nothing was left to do.
   */
  async eraseForMeta({
    scope,
    match,
    issuedAt,
    shouldEraseData,
  }: InstagramAccountMetaErasureInput): Promise<InstagramAccountErasure | null> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const accounts = await this.accountService.disconnectForMeta({
          scope,
          match,
          issuedAt,
          shouldEraseProfile: shouldEraseData,
        });
        return this.eraseStoredPosts({ scope, accounts, shouldEraseData });
      },
    });
  }

  /**
   * The organization delete's Instagram step (D54), called by tenancy through its offboarding port
   * before the organization is soft-deleted: the Instagram account is free to connect elsewhere at
   * once, and nothing of it is left for a later request of Meta's.
   *
   * @remarks
   * Algorithm: the best-effort unsubscribe of every live account ({@link
   * InstagramAccountService.unsubscribeForOrganizationOffboarding}, outside any unit of work), then one
   * transaction in the organization's scope —
   * {@link InstagramAccountService.disconnectForOrganizationOffboarding} (every account and every
   * connection, IAC5), the stored posts of every account and the lanes of each account it revoked
   * stopped (CA8 — a deleted organization's waiting messages never reach a turn). Failure modes: a failed unsubscribe is logged and never blocks; a database failure reaches
   * the delete, which stops. Side effects: as the class lists. Returns `null` when the organization had
   * nothing to erase. Notes: safe to repeat — the reconcile worker runs the whole delete again after a
   * crash. It must run in the organization's own scope while the organization is live: row-level
   * security hides a soft-deleted organization's rows, so later it would silently erase nothing.
   */
  async eraseForOrganizationOffboarding(
    scope: OrganizationPrincipalDatabaseScope,
  ): Promise<InstagramAccountErasure | null> {
    await this.accountService.unsubscribeForOrganizationOffboarding({ scope });
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const accounts = await this.accountService.disconnectForOrganizationOffboarding({ scope });
        const erasure = await this.eraseStoredPosts({ scope, accounts, shouldEraseData: true });
        for (const channelAccount of erasure?.revokedChannelAccounts ?? []) {
          await this.lanePort.stopLanes({ scope, ...channelAccount });
        }
        return erasure;
      },
    });
  }

  /**
   * Deletes the stored posts of each disconnected account (when the data is erased) inside the
   * caller's transaction, and names the accounts something changed on; `null` when none did.
   */
  private async eraseStoredPosts({
    scope,
    accounts,
    shouldEraseData,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    accounts: readonly InstagramAccountDisconnectChange[];
    shouldEraseData: boolean;
  }): Promise<InstagramAccountErasure | null> {
    let erasedPostCount = 0;
    const instagramAccountPublicIds: string[] = [];
    const revokedChannelAccounts: ChannelAccountKey[] = [];
    for (const account of accounts) {
      if (account.wasRevoked) revokedChannelAccounts.push(account.channelAccount);
      const accountPostCount = shouldEraseData
        ? await this.mediaService.deleteForAccount({
            scope,
            channelAccount: account.channelAccount,
          })
        : 0;
      erasedPostCount += accountPostCount;
      if (
        account.wasRevoked ||
        account.wasTokenErased ||
        account.wasProfileErased ||
        accountPostCount > 0
      ) {
        instagramAccountPublicIds.push(account.instagramAccountPublicId);
      }
    }
    if (instagramAccountPublicIds.length === 0) return null;
    return { instagramAccountPublicIds, erasedPostCount, revokedChannelAccounts };
  }
}
