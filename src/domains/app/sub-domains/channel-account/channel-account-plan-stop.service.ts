import { PLAN_ACCESS_STATE } from '@/domains/billing/sub-domains/subscription/subscription.constants.js';
import { CHANNEL_ACCOUNT_PLAN_STOP_REASON } from './channel-account.constants.js';
import type { ChannelAccountPlanAccessService } from './channel-account.service.js';
import type {
  ChannelAccountPlanStopPort,
  ChannelAccountPortScope,
} from './channel-account.types.js';

/**
 * The organization-wide plan stop an activated account takes instead of `plan_downgrade` (routes-final
 * § 1B CA9, `ChannelAccountPlanStopPort`): `plan_ended` while the organization's plan entitlement is
 * `read_only` (sub-domain 8 BL3 — a lapsed or cancelled paid plan; ROUTE row R24).
 *
 * @remarks
 * - **Algorithm:** billing's one plan read (`SubscriptionService.getPlanAccess`, BL2) for the scope's
 *   organization — read in the caller's unit (a surrounding unit of the same organization lends its
 *   transaction); `read_only` → `plan_ended`, otherwise none.
 * - **Failure modes:** a read failure propagates into the caller's unit.
 * - **Side effects:** none.
 * - **Notes:** `plan_limit` (the organization at its month limit — sub-domain 6's month count) joins
 *   this answer at ROUTE row R18; until then a month-limited organization's activated account takes
 *   no plan stop.
 */
export class ChannelAccountPlanStopService implements ChannelAccountPlanStopPort {
  constructor(private readonly planAccessService: ChannelAccountPlanAccessService) {}

  /** The organization's plan stop now: `plan_ended` while its plan is read-only, else `null`. */
  async readOrganizationPlanStop({
    scope,
  }: ChannelAccountPortScope): Promise<typeof CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_ENDED | null> {
    const access = await this.planAccessService.getPlanAccess({
      organizationPublicId: scope.organizationPublicId,
    });
    return access.state === PLAN_ACCESS_STATE.READ_ONLY
      ? CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_ENDED
      : null;
  }
}
