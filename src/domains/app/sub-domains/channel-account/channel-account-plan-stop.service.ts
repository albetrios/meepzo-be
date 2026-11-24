import { PLAN_ACCESS_STATE } from '@/domains/billing/sub-domains/subscription/subscription.constants.js';
import {
  CHANNEL_ACCOUNT_PLAN_STOP_REASON,
  type ChannelAccountPlanStopReason,
} from './channel-account.constants.js';
import type { ChannelAccountPlanAccessService } from './channel-account.service.js';
import type {
  ChannelAccountPlanStopPort,
  ChannelAccountPortScope,
} from './channel-account.types.js';

/**
 * The organization-wide plan stop an activated account takes instead of `plan_downgrade` (routes-final
 * § 1B CA9, `ChannelAccountPlanStopPort`): `plan_ended` while the organization's plan entitlement is
 * `read_only` (sub-domain 8 BL3 — a lapsed or cancelled paid plan; ROUTE row R24), else `plan_limit`
 * while the organization is at its month limit (sub-domain 6's month count, ROUTE row R18).
 *
 * @remarks
 * - **Algorithm:** billing's one plan read (`SubscriptionService.getPlanAccess`, BL2) for the scope's
 *   organization — read in the caller's unit (a surrounding unit of the same organization lends its
 *   transaction); `read_only` → `plan_ended`; otherwise the month-limit port's answer
 *   (`MessageMonthCountService.readOrganizationPlanStop` — `plan_limit` or none).
 * - **Failure modes:** a read failure propagates into the caller's unit.
 * - **Side effects:** none.
 * - **Notes:** the month-limit port is optional so a unit test can leave it out; without it a
 *   month-limited organization's activated account takes no plan stop.
 */
export class ChannelAccountPlanStopService implements ChannelAccountPlanStopPort {
  constructor(
    private readonly planAccessService: ChannelAccountPlanAccessService,
    private readonly monthLimitPort?: ChannelAccountPlanStopPort,
  ) {}

  /** The organization's plan stop now: `plan_ended`, else `plan_limit`, else `null`. */
  async readOrganizationPlanStop(
    options: ChannelAccountPortScope,
  ): Promise<Exclude<ChannelAccountPlanStopReason, 'plan_downgrade'> | null> {
    const access = await this.planAccessService.getPlanAccess({
      organizationPublicId: options.scope.organizationPublicId,
    });
    if (access.state === PLAN_ACCESS_STATE.READ_ONLY) {
      return CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_ENDED;
    }
    return (await this.monthLimitPort?.readOrganizationPlanStop(options)) ?? null;
  }
}
