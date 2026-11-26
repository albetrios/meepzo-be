import type { OrganizationEntitlementOverrideRow } from './entitlement-override.schema.js';
import type { EntitlementOverrideKey } from './entitlement.constants.js';
import { isEntitlementOverrideActive } from './entitlement-override.util.js';
import type { PlanAccess } from '@/domains/billing/sub-domains/subscription/subscription.types.js';
import type {
  EntitlementOverrideOutput,
  EntitlementPlanUsage,
  EntitlementsOutput,
} from './entitlement.types.js';

/**
 * Shapes one stored override into its public body (P270): the `ovr_…` id as `id`, the owning
 * organization's `org_…` id, ISO timestamps and `is_active` at `now` (a removed row is never active).
 */
export function serializeEntitlementOverride({
  row,
  organization_public_id,
  now,
}: {
  row: OrganizationEntitlementOverrideRow;
  organization_public_id: string;
  now: Date;
}): EntitlementOverrideOutput {
  return {
    id: row.public_id,
    organization_id: organization_public_id,
    key: row.key as EntitlementOverrideKey,
    value: row.value,
    expires_at: row.expires_at?.toISOString() ?? null,
    is_active:
      row.deleted_at === null &&
      isEntitlementOverrideActive({ override: { expiresAt: row.expires_at }, now }),
    reason: row.reason,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * Shapes `GET /api/v1/billing/entitlements` (P271) from the one plan read (overrides already laid
 * over its features), the app's usage and the member count.
 *
 * @remarks
 * Each limit is the merged feature (`message_month_limit`, `channel_accounts_max`) or the plan's seats,
 * `null` when there is no plan in the catalog (or the plan has no seat limit, D55).
 */
export function serializeEntitlements({
  plan_access: planAccess,
  usage,
  seats_used: seatsUsed,
}: {
  plan_access: PlanAccess;
  usage: EntitlementPlanUsage;
  seats_used: number;
}): EntitlementsOutput {
  return {
    state: planAccess.state,
    plan: planAccess.plan ? { id: planAccess.plan.publicId, name: planAccess.plan.name } : null,
    features: planAccess.features,
    limits: {
      direct_messages: {
        used: usage.directMessagesUsed,
        limit: planAccess.features?.message_month_limit ?? null,
        resets_on: usage.directMessagesResetsOn,
      },
      channel_accounts: {
        used: usage.channelAccountsUsed,
        limit: planAccess.features?.channel_accounts_max ?? null,
      },
      seats: { used: seatsUsed, limit: planAccess.seatLimit },
    },
    trial_ends_at: planAccess.trialEndsAt?.toISOString() ?? null,
    grace_ends_at: planAccess.graceEndsAt?.toISOString() ?? null,
    is_plan_choice_required: planAccess.isPlanChoiceRequired,
    overrides: planAccess.overrides.map((override) => ({
      key: override.key,
      expires_at: override.expiresAt?.toISOString() ?? null,
    })),
  };
}
