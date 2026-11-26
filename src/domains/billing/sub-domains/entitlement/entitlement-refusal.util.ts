import { ConflictError, ForbiddenError } from '@/shared/errors/index.js';
import type { EntitlementSwitchKey } from './entitlement.constants.js';

/** The plan refusal reasons (change-plan-gates EN5): one error body each, statuses as built. */
export type PlanRefusalReason =
  | 'organization_read_only'
  | 'plan_lacks_feature'
  | 'plan_account_limit'
  | 'seat_limit_reached'
  | 'message_month_limit_reached';

/**
 * What {@link buildPlanRefusal} needs for each reason (EN5): the read-only refusal its grace end, a
 * feature refusal the switch it reads, a limit refusal the ceiling and how much is used — and the
 * month refusal the day its count starts again (P6).
 */
export type PlanRefusalInput =
  | { reason: 'organization_read_only'; graceEndsAt: Date | null }
  | { reason: 'plan_lacks_feature'; feature: EntitlementSwitchKey }
  | { reason: 'plan_account_limit'; limit: number; used: number }
  | { reason: 'seat_limit_reached'; limit: number; used: number }
  | {
      reason: 'message_month_limit_reached';
      limit: number;
      used: number;
      /** The 1st of next month, `YYYY-MM-DD` (the spelling of `limits.direct_messages.resets_on`). */
      resetsOn: string;
    };

/**
 * Builds the one plan refusal for a reason (change-plan-gates EN5, P6, P7) — the only producer of
 * plan refusals, each body exactly as the code answers it today.
 *
 * @remarks
 * - **Algorithm:** one case per reason:
 *   - `organization_read_only` → `403` `errors:organizationReadOnly` + `grace_ends_at` (ISO 8601 or
 *     `null`), `upgrade_required: true` (as `SubscriptionService.assertOrganizationWritable`);
 *   - `plan_lacks_feature` → `403` `errors:planLacksFeature` + `feature`, `upgrade_required: true`
 *     (as the channel account's feature check and the automation's PRO-part check);
 *   - `plan_account_limit` → `409` `errors:planAccountLimit` + `limit`, `used`,
 *     `upgrade_required: true` (as the channel connection's pick and the account activate);
 *   - `seat_limit_reached` → `409` `errors:seatLimitReached` (interpolating `used`, `limit`) +
 *     `limit`, `used`, `upgrade_required: true` (as the membership seat check);
 *   - `message_month_limit_reached` → `409` `errors:messageMonthLimitReached` + `limit`, `used`,
 *     `resets_on` — the numbers P6 adds to today's reason-only body.
 * - **Failure modes:** none — it builds the error; the caller throws it.
 * - **Side effects:** none — pure.
 * - **Notes:** no plan id anywhere (P7): the client picks the plan from `GET /billing/plans` by
 *   `feature` / `limit`. Every field is one of the shared error fields (`APP_ERROR_FIELD_KINDS`).
 */
export function buildPlanRefusal(input: PlanRefusalInput): ForbiddenError | ConflictError {
  switch (input.reason) {
    case 'organization_read_only':
      return new ForbiddenError('errors:organizationReadOnly').withReason(input.reason).withFields({
        grace_ends_at: input.graceEndsAt?.toISOString() ?? null,
        upgrade_required: true,
      });
    case 'plan_lacks_feature':
      return new ForbiddenError('errors:planLacksFeature')
        .withReason(input.reason)
        .withFields({ feature: input.feature, upgrade_required: true });
    case 'plan_account_limit':
      return new ConflictError('errors:planAccountLimit')
        .withReason(input.reason)
        .withFields({ limit: input.limit, used: input.used, upgrade_required: true });
    case 'seat_limit_reached':
      return new ConflictError('errors:seatLimitReached', {
        used: input.used,
        limit: input.limit,
      })
        .withReason(input.reason)
        .withFields({ limit: input.limit, used: input.used, upgrade_required: true });
    case 'message_month_limit_reached':
      return new ConflictError('errors:messageMonthLimitReached')
        .withReason(input.reason)
        .withFields({ limit: input.limit, used: input.used, resets_on: input.resetsOn });
  }
}
