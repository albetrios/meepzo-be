import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { assertTeamOrganization } from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import { CircuitBreakerOpenError } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  RedisLockUnavailableError,
  withRedisLock,
} from '@/infrastructure/cache/redis-lock.util.js';
import {
  assertInstagramConfigured,
  probeInstagramMessageAccess,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  MetaGraphApiError,
  describeMetaGraphError,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { isMetaTokenRefused } from '@/domains/app/sub-domains/channel-connection/channel-connection-error.util.js';
import { stopDurationOf } from '@/domains/app/sub-domains/instagram-sending/instagram-send-error.util.js';
import { INSTAGRAM_SEND_STOP_ENDED_BY } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import type { InstagramSendLaneService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.service.js';
import type { InstagramMediaConnectionBreakPort } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.types.js';
import type { InstagramMessageAccessState } from '@/shared/constants/instagram.constants.js';
import type { InstagramAccountExtensionService } from './instagram-account-extension.service.js';
import type { InstagramAccountService } from './instagram-account.service.js';
import type { InstagramAccountReadAccess } from './instagram-account.types.js';
import { MESSAGE_ACCESS_RECHECK_MIN_SECONDS } from './instagram-account.constants.js';
import {
  instagramNotConnectedConflictError,
  instagramUnavailableError,
  metaGraphCircuitOpenError,
} from './instagram-account-error.util.js';

/**
 * The `access_off` stop's end for a probe or a re-check that found "Allow access to messages" off
 * (P354, feat-meta-connect-flow IG2) — the first rung of the stop's ladder, as a send's own
 * `access_off` answer starts it. One rule for the set-up job and route 154.
 *
 * @remarks
 * Algorithm: `now` + the ladder's first `access_off` step (`stopDurationOf`). Failure modes: none.
 * Side effects: none — a pure computation.
 */
export function messageAccessOffStopUntil(now: Date = new Date(Date.now())): Date {
  const durationMilliseconds =
    stopDurationOf({ reason: 'access_off', stopCount: 0, lane: 'slow' }) ?? 0;
  return new Date(now.getTime() + durationMilliseconds);
}

/** How long one account's check may hold its lock — past the probe's Meta timeout. */
const MESSAGE_ACCESS_CHECK_LOCK_TTL_SECONDS = 30;

/** How long a second check of the same account waits for the first one's answer. */
const MESSAGE_ACCESS_CHECK_LOCK_WAIT_MS = 15_000;

/** The stored answer, without calling Meta (`is_from_meta: false`). */
function storedAnswer({
  channelAccountPublicId,
  access,
}: {
  channelAccountPublicId: string;
  access: InstagramAccountReadAccess;
}): InstagramMessageAccessCheckOutput {
  return {
    channel_account_id: channelAccountPublicId,
    status: access.account.message_access as InstagramMessageAccessState,
    checked_at: access.account.message_access_checked_at?.toISOString() ?? null,
    is_from_meta: false,
  };
}

/**
 * Route 154's answer (routes-final § 3.6).
 *
 * @remarks
 * Notes: `checked_at` is `null` only when the account was revoked between the read and the write.
 */
export interface InstagramMessageAccessCheckOutput {
  channel_account_id: string;
  status: InstagramMessageAccessState;
  checked_at: string | null;
  /** `false` when the 60-second rule answered the stored result without calling Meta. */
  is_from_meta: boolean;
}

/**
 * The lane calls route 154 makes (sub-domain 6's lane service).
 *
 * @remarks
 * Notes: structural, so a test can stub it; `InstagramSendLaneService` satisfies it.
 */
export type InstagramMessageAccessLanePort = Pick<
  InstagramSendLaneService,
  'startLaneStop' | 'endLaneStops' | 'wakeLanes' | 'listLanes'
>;

/**
 * Route 154 — the owner's "check Allow access to messages now" (feat-meta-connect-flow routes-final
 * § 3, IG2): the same probe the set-up job runs, its answer stored, the `access_off` stop ended,
 * started or left as the answer says.
 *
 * @remarks
 * - Reads the account, its connection and token through {@link InstagramAccountService}; stores
 *   through {@link InstagramAccountExtensionService}; stops through the lane service.
 * - A refused token (code 190) breaks the connection through the channel connection (K2), as the
 *   pickers do.
 */
export class InstagramAccountMessageAccessService {
  constructor(
    private readonly accountService: Pick<InstagramAccountService, 'findAccountReadAccess'>,
    private readonly extensionService: Pick<
      InstagramAccountExtensionService,
      'recordMessageAccess'
    >,
    private readonly lanePort: InstagramMessageAccessLanePort,
    private readonly connectionBreakPort: InstagramMediaConnectionBreakPort,
    private readonly organizationService: Pick<
      OrganizationService,
      'requireOrganizationByPublicId'
    >,
  ) {}

  /**
   * Checks "Allow access to messages" now and stores the answer (route 154).
   *
   * @remarks
   * Algorithm: one check per account at a time (a Redis lock; a second check waits up to 15 s, then
   * answers the stored result), so a burst spends one Meta call and starts the stop once.
   * (1) the team check (a personal organization → `422`, as every write); the account
   * (`404 channel_account_not_found`: not this organization's, revoked
   * or not Instagram) — `connected` with a `connected` connection and a token, else
   * `409 instagram_not_connected`; (2) a check within {@link MESSAGE_ACCESS_RECHECK_MIN_SECONDS} of
   * the last answers the stored result, no Meta call; (3) the probe, outside any unit; (4) the
   * answer stored; `on` ends the `access_off` stop and wakes the lanes, `off` starts it on every
   * lane unless a lane already holds it, `unknown` leaves the stop.
   * Failure modes: `503 instagram_not_configured`; Meta down, throttling or its circuit open →
   * `503 instagram_unavailable`, nothing stored; a refused token → the connection's break, then
   * `409 instagram_not_connected`.
   * Side effects: at most one Meta call; the account's two message-access columns; lane stops.
   */
  async checkMessageAccess({
    scope,
    channelAccountPublicId,
    requestId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
    requestId: string;
  }): Promise<InstagramMessageAccessCheckOutput> {
    await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
      },
    });
    try {
      // One check per account at a time: a second one waits, then reads the first one's answer.
      return await withRedisLock({
        options: {
          key: `app:instagram:message-access-check:${channelAccountPublicId}`,
          ttlSeconds: MESSAGE_ACCESS_CHECK_LOCK_TTL_SECONDS,
          waitTimeoutMs: MESSAGE_ACCESS_CHECK_LOCK_WAIT_MS,
        },
        fn: () => this.checkUnderLock({ scope, channelAccountPublicId, requestId }),
      });
    } catch (error) {
      if (!(error instanceof RedisLockUnavailableError)) throw error;
      const access = await this.readConnectedAccess({ scope, channelAccountPublicId });
      return storedAnswer({ channelAccountPublicId, access });
    }
  }

  /** The account, `connected` with a token, else `409 instagram_not_connected`. */
  private async readConnectedAccess({
    scope,
    channelAccountPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
  }): Promise<InstagramAccountReadAccess> {
    const access = await this.accountService.findAccountReadAccess({
      scope,
      channelAccountPublicId,
    });
    if (
      access.account.connection_status !== 'connected' ||
      access.connectionStatus !== 'connected' ||
      access.encryptedAccessToken === null
    ) {
      throw instagramNotConnectedConflictError();
    }
    return access;
  }

  /** Route 154's read, the 60-second rule, the probe, the write and the stop — under the lock. */
  private async checkUnderLock({
    scope,
    channelAccountPublicId,
    requestId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
    requestId: string;
  }): Promise<InstagramMessageAccessCheckOutput> {
    const access = await this.readConnectedAccess({ scope, channelAccountPublicId });
    const lastCheckedAt = access.account.message_access_checked_at;
    if (
      lastCheckedAt !== null &&
      Date.now() - lastCheckedAt.getTime() < MESSAGE_ACCESS_RECHECK_MIN_SECONDS * 1000
    ) {
      // The stop follows the stored answer again — a stop start that failed after the write is
      // put right by the next check, without a Meta call.
      await this.applyStop({
        scope,
        access,
        status: access.account.message_access as InstagramMessageAccessState,
      });
      return storedAnswer({ channelAccountPublicId, access });
    }
    assertInstagramConfigured();
    const status = await this.probe({ scope, access, requestId });
    const stored = await this.extensionService.recordMessageAccess({
      scope,
      channelAccount: access.channelAccount,
      status,
    });
    await this.applyStop({ scope, access, status });
    return {
      channel_account_id: channelAccountPublicId,
      status,
      checked_at: stored?.checkedAt.toISOString() ?? null,
      is_from_meta: true,
    };
  }

  /** The probe, with Meta's failures as route errors (3.9). */
  private async probe({
    scope,
    access,
    requestId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    access: InstagramAccountReadAccess;
    requestId: string;
  }): Promise<InstagramMessageAccessState> {
    try {
      return await probeInstagramMessageAccess({
        encryptedAccessToken: access.encryptedAccessToken ?? '',
        instagramUserId: access.account.instagram_user_id,
        requestId,
        isOutageThrown: true,
      });
    } catch (error) {
      if (error instanceof CircuitBreakerOpenError) throw metaGraphCircuitOpenError(error);
      if (!(error instanceof MetaGraphApiError)) throw error;
      if (isMetaTokenRefused(error)) {
        await this.connectionBreakPort.markConnectionBroken({
          scope,
          channelConnection: access.channelConnection,
          lastCheckError: describeMetaGraphError(error),
          requestId,
        });
        throw instagramNotConnectedConflictError();
      }
      throw instagramUnavailableError(error.retryAfterSeconds);
    }
  }

  /** The `access_off` stop as the answer says (IG2): ended on `on`, started on `off`, else left. */
  private async applyStop({
    scope,
    access,
    status,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    access: InstagramAccountReadAccess;
    status: InstagramMessageAccessState;
  }): Promise<void> {
    const target = { scope, ...access.channelAccount };
    if (status === 'on') {
      await this.lanePort.endLaneStops({
        ...target,
        reasons: ['access_off'],
        endedBy: INSTAGRAM_SEND_STOP_ENDED_BY.OWNER,
      });
      await this.lanePort.wakeLanes(target);
      return;
    }
    if (status !== 'off') return;
    const lanes = await this.lanePort.listLanes(target);
    if (lanes.some((lane) => lane.stop_reason === 'access_off')) return;
    await this.lanePort.startLaneStop({
      ...target,
      lanes: 'all',
      reason: 'access_off',
      stopUntil: messageAccessOffStopUntil(),
    });
  }
}
