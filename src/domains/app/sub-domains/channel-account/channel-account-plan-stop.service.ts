import { PLAN_ACCESS_STATE } from '@/domains/billing/sub-domains/subscription/subscription.constants.js';
import {
  CHANNEL_ACCOUNT_PLAN_STOP_REASON,
  type ChannelAccountPlanStopReason,
} from './channel-account.constants.js';
import type { EntitlementSnapshot } from '@/domains/billing/sub-domains/entitlement/entitlement.types.js';
import {
  type ChannelAccountEntitlementService,
  readEntitlementSnapshot,
} from './channel-account-entitlement.util.js';
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
 * - **Algorithm:** the organization's entitlement snapshot — the caller's, else one resolve through
 *   the entitlement module (change-plan-gates AP5, P24) in the caller's unit (a surrounding unit of
 *   the same organization lends its transaction); its state `read_only` → `plan_ended`; otherwise
 *   the month-limit port's answer over the same snapshot
 *   (`MessageMonthCountService.readOrganizationPlanStop` — `plan_limit` or none), so the stop reads
 *   the plan once.
 * - **Failure modes:** a read failure propagates into the caller's unit.
 * - **Side effects:** none.
 * - **Notes:** the month-limit port is optional so a unit test can leave it out; without it a
 *   month-limited organization's activated account takes no plan stop.
 */
export class ChannelAccountPlanStopService implements ChannelAccountPlanStopPort {
  constructor(
    private readonly entitlementService: ChannelAccountEntitlementService,
    private readonly monthLimitPort?: ChannelAccountPlanStopPort,
  ) {}

  /** The organization's plan stop now: `plan_ended`, else `plan_limit`, else `null`. */
  async readOrganizationPlanStop(
    options: ChannelAccountPortScope & { entitlement?: EntitlementSnapshot | undefined },
  ): Promise<Exclude<ChannelAccountPlanStopReason, 'plan_downgrade'> | null> {
    const entitlement = await readEntitlementSnapshot({
      entitlementService: this.entitlementService,
      scope: options.scope,
      entitlement: options.entitlement,
    });
    if (entitlement.state === PLAN_ACCESS_STATE.READ_ONLY) {
      return CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_ENDED;
    }
    return (
      (await this.monthLimitPort?.readOrganizationPlanStop({ ...options, entitlement })) ?? null
    );
  }
}
