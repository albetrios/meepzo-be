import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { ChannelConnectionUsageService } from '@/domains/app/sub-domains/channel-connection/channel-connection-usage.service.js';
import type { MetaGraphUsageRecorder } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type { MetaUsageDecision } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-usage.util.js';
import type { InstagramSendAccess } from './instagram-sending.types.js';

/**
 * The one read every Instagram sender makes before a Meta call (feat-instagram-dm-sending
 * routes-final § 6 SN22, SN23; SNC16): the account's send access, the pace from the connection's
 * Meta usage, and the connection's usage recorder for the call.
 *
 * @remarks
 * - **Algorithm:** `readSendAccess` reads the account, its connection and token in one unit
 *   (`InstagramAccountService.findAccountReadAccess` — the same read as the pickers). `readSendPace`
 *   asks the connection's usage (`ChannelConnectionUsageService.readConnectionUsage`, MC19) for the
 *   entries of two assets: the account's Instagram user id and the connection's business id — so a
 *   business-wide 95 % holds every lane of every account of that connection, while one account's
 *   own reading holds only that account (S13). The lanes keep no usage of their own (SN23).
 * - **Failure modes:** an account that is not this organization's, revoked, or not Instagram →
 *   `404 channel_account_not_found` (the read's own error); a usage store failure propagates (the
 *   sender puts its ticket back).
 * - **Side effects:** reads only; the recorder writes the connection's usage after the call.
 * - **Notes:** used by the attachment upload (6.C, ROUTE row R20) and, from ROUTE row R42, by every
 *   lane turn and fast message before its send; a `wait` pace means no Meta call before
 *   `waitUntil`, a `slow` pace doubles the lane's boxes (R43).
 */
export class InstagramSendAccessService {
  constructor(
    private readonly options: {
      accountService: Pick<InstagramAccountService, 'findAccountReadAccess'>;
      usageService: Pick<
        ChannelConnectionUsageService,
        'readConnectionUsage' | 'buildUsageRecorder'
      >;
    },
  ) {}

  /**
   * The account's send access: keys, Instagram user id, the connection's usage key and business
   * id, the encrypted token and whether a call may go now.
   *
   * @remarks
   * Algorithm: one unit over the account and its connection. Failure modes: `404
   * channel_account_not_found` for a revoked or foreign account. Side effects: none.
   */
  async readSendAccess({
    scope,
    channelAccountPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
  }): Promise<InstagramSendAccess> {
    const access = await this.options.accountService.findAccountReadAccess({
      scope,
      channelAccountPublicId,
    });
    return {
      channelAccount: access.channelAccount,
      channelAccountPublicId,
      channelConnection: access.channelConnection,
      channelConnectionPublicId: access.channelConnectionPublicId,
      clientBusinessId: access.clientBusinessId,
      instagramUserId: access.account.instagram_user_id,
      encryptedAccessToken: access.encryptedAccessToken,
      isSendable:
        access.account.connection_status === 'connected' &&
        access.connectionStatus === 'connected' &&
        access.encryptedAccessToken !== null &&
        access.channelConnectionPublicId !== null,
    };
  }

  /**
   * The pace before this account's next Meta call (SN23): `wait` until Meta's time (or 15 minutes)
   * at ≥ 95 %, `slow` at ≥ 80 %, else `normal` — from the account's and the business's entries.
   *
   * @remarks
   * Algorithm: one usage read (Redis copy, Postgres behind it). Failure modes: a store failure
   * propagates. Side effects: none. A connection that is gone reads `normal` (it is not sendable).
   */
  async readSendPace({
    scope,
    access,
    now,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    access: InstagramSendAccess;
    now?: Date | undefined;
  }): Promise<MetaUsageDecision> {
    if (access.channelConnectionPublicId === null) return { pace: 'normal', waitUntil: null };
    const usage = await this.options.usageService.readConnectionUsage({
      scope,
      channelConnectionPublicId: access.channelConnectionPublicId,
      assetIds: [access.instagramUserId, access.clientBusinessId].filter(
        (assetId): assetId is string => assetId !== null,
      ),
      now,
    });
    return { pace: usage.pace, waitUntil: usage.waitUntil };
  }

  /**
   * The connection's usage recorder for this account's Meta calls (MC19) — every send and upload
   * passes it, so the answer's usage reaches the connection; `undefined` when the connection is gone.
   *
   * @remarks
   * Algorithm: delegates to the usage service. Failure modes: none (the recorder swallows its own
   * failures). Side effects: none until the client calls it.
   */
  buildUsageRecorder({
    scope,
    access,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    access: InstagramSendAccess;
  }): MetaGraphUsageRecorder | undefined {
    if (access.channelConnectionPublicId === null) return undefined;
    return this.options.usageService.buildUsageRecorder({
      scope,
      channelConnectionPublicId: access.channelConnectionPublicId,
    });
  }
}
