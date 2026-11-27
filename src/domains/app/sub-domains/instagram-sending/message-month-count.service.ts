import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { runEnqueueAfterCommit } from '@/core/events/event-bus.js';
import { limit } from '@/domains/billing/sub-domains/entitlement/entitlement-snapshot.util.js';
import type { EntitlementSnapshot } from '@/domains/billing/sub-domains/entitlement/entitlement.types.js';
import {
  type ChannelAccountEntitlementService,
  readEntitlementSnapshot,
} from '@/domains/app/sub-domains/channel-account/channel-account-entitlement.util.js';
import type {
  ChannelAccountPlanStopPort,
  ChannelAccountPortScope,
} from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import type {
  MessageMonthCountRead,
  MessageMonthCountRepository,
} from './message-month-count.repository.js';
import {
  getCachedMessageMonthCount,
  invalidateCachedMessageMonthCount,
  setCachedMessageMonthCount,
} from './message-month-count.cache.js';

/**
 * The organization's month count of messages sent into people's chats (feat-instagram-dm-sending
 * routes-final § 6 SN8, SN11, D34): the meter's read through its 10-second Redis copy, the add the
 * send's claim makes, and the `plan_limit` answer of the channel account's plan-stop port (CA9).
 *
 * @remarks
 * Algorithm:
 * - The month is the organization's (its time zone); `used` is the sum of its 16 slots.
 * - The meter (route 64) reads the copy first and falls through to Postgres on a miss or a Redis
 *   failure (fail open); the add tombstones the copy after its commit. The plan stop and the claim
 *   read Postgres, never the copy.
 *
 * Failure modes: none of its own; Redis failures are misses.
 *
 * Side effects: the add writes one slot row and, after commit, one Redis tombstone.
 *
 * Notes: implements {@link ChannelAccountPlanStopPort} for `plan_limit` (ROUTE row R18); `plan_ended`
 * is ROUTE row R24's. The 80 % / 100 % notices and the plan stop at the crossing are the claim's
 * (ROUTE row R42, WC-56).
 */
export class MessageMonthCountService implements ChannelAccountPlanStopPort {
  constructor(
    private readonly repository: MessageMonthCountRepository,
    private readonly entitlementService: ChannelAccountEntitlementService,
  ) {}

  /**
   * This month's count for the meter (route 64), through the Redis copy.
   *
   * @remarks
   * Algorithm: the copy; on a miss, one Postgres read in the scope, then the copy populated.
   * Failure modes: an organization the scope cannot see reads a zero month at the epoch's 1st — the
   * caller already checked it. Side effects: one Redis populate on a miss.
   */
  async readMonth({
    scope,
    organizationId,
  }: ChannelAccountPortScope): Promise<MessageMonthCountRead> {
    const cached = await getCachedMessageMonthCount(scope.organizationPublicId);
    if (cached !== null) return cached;
    const month = await this.readMonthFromDatabase({ scope, organizationId });
    await setCachedMessageMonthCount({ organizationPublicId: scope.organizationPublicId, month });
    return month;
  }

  /**
   * This month's count from Postgres (the plan stop, the claim's re-check), in the caller's unit.
   *
   * @remarks
   * Algorithm: one read. Failure modes: as {@link readMonth}. Side effects: none.
   */
  async readMonthFromDatabase({
    scope,
    organizationId,
  }: ChannelAccountPortScope): Promise<MessageMonthCountRead> {
    const month = await withAppDatabaseContext({
      scope,
      callback: () => this.repository.readMonth(organizationId),
    });
    return month ?? { monthStart: '1970-01-01', resetsOn: '1970-02-01', used: 0 };
  }

  /**
   * Adds messages to this month's slot of a channel account, in the caller's unit (the send's claim
   * commit, SN3, ROUTE row R42); the Redis copy is tombstoned after that commit.
   *
   * @remarks
   * Algorithm: one upsert; the tombstone through `runEnqueueAfterCommit` (immediately when no unit is
   * open). Failure modes: none of its own; a failed tombstone is logged and the copy ages out in
   * 10 s. Side effects: one slot row; one Redis key.
   */
  async addMessages({
    scope,
    organizationId,
    channelAccountId,
    count,
  }: ChannelAccountPortScope & { channelAccountId: number; count: number }): Promise<void> {
    await withAppDatabaseContext({
      scope,
      callback: async () => {
        await this.repository.addToMonth({ organizationId, channelAccountId, count });
        await runEnqueueAfterCommit(() =>
          invalidateCachedMessageMonthCount(scope.organizationPublicId),
        );
      },
    });
  }

  /**
   * The organization's plan stop from its month count (CA9's port, D34): `plan_limit` when this
   * month's count has reached the plan's `message_month_limit`, else `null`.
   *
   * @remarks
   * Algorithm: {@link readMonthLimitReached} over the caller's entitlement snapshot (else one
   * resolve). Failure modes: a plan read failure propagates. Side effects: none. Notes: an
   * organization with no plan in the catalog has no limit to reach.
   */
  async readOrganizationPlanStop(
    options: ChannelAccountPortScope & { entitlement?: EntitlementSnapshot | undefined },
  ): Promise<'plan_limit' | null> {
    return (await this.readMonthLimitReached(options)) === null ? null : 'plan_limit';
  }

  /**
   * This month's count when it has reached the plan's `message_month_limit` — the numbers the month
   * refusal carries (change-plan-gates AP4, P6) — else `null`.
   *
   * @remarks
   * Algorithm: the ceiling with `limit('message_month_limit')` from the caller's entitlement snapshot
   * (else one resolve, P24); then the month from Postgres in the caller's unit; reached when `used`
   * is at or over the ceiling. Failure modes: a plan read failure propagates. Side effects: none.
   * Notes: no plan in the catalog (`null`) has no limit to reach. The send claim's own month guard
   * (`InstagramSendGateService`) keeps its locks and only reads the ceiling (P8, K4).
   */
  async readMonthLimitReached({
    scope,
    organizationId,
    entitlement,
  }: ChannelAccountPortScope & { entitlement?: EntitlementSnapshot | undefined }): Promise<{
    limit: number;
    used: number;
    resetsOn: string;
  } | null> {
    const monthLimit = limit({
      snapshot: await readEntitlementSnapshot({
        entitlementService: this.entitlementService,
        scope,
        entitlement,
      }),
      key: 'message_month_limit',
    });
    if (monthLimit === null) return null;
    const month = await this.readMonthFromDatabase({ scope, organizationId });
    return month.used >= monthLimit
      ? { limit: monthLimit, used: month.used, resetsOn: month.resetsOn }
      : null;
  }

  /**
   * The plan's `message_month_limit` (P37), or `null` when the catalog has no plan.
   *
   * @remarks
   * Algorithm: one entitlement resolve, then `limit('message_month_limit')` (change-plan-gates AP1,
   * AP4) — once per send job, before the claim. Failure modes: propagates. Side effects: none.
   */
  async readMonthLimit(scope: OrganizationPrincipalDatabaseScope): Promise<number | null> {
    const entitlement = await readEntitlementSnapshot({
      entitlementService: this.entitlementService,
      scope,
    });
    return limit({ snapshot: entitlement, key: 'message_month_limit' });
  }
}
