import type { OrganizationEntitlementOverrideRow } from './entitlement-override.schema.js';
import type { EntitlementOverrideKey } from './entitlement.constants.js';
import { isEntitlementOverrideActive } from './entitlement-override.util.js';
import { entitlementSources, limit } from './entitlement-snapshot.util.js';
import type {
  EntitlementOverrideOutput,
  EntitlementPlanUsage,
  EntitlementSnapshot,
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
 * Shapes `GET /api/v1/billing/entitlements` (P271) from the resolved entitlement snapshot (the one
 * plan read, overrides already laid over its features), the app's usage and the member count.
 *
 * @remarks
 * Each limit is the snapshot's `limit()` — the merged `message_month_limit` / `channel_accounts_max`
 * or the plan's seats — `null` when there is no plan in the catalog (or the plan has no seat limit,
 * D55); `sources` names where every registry key's value came from (change-plan-gates EN6), so every
 * value reported is the one the gates read.
 */
export function serializeEntitlements({
  snapshot,
  usage,
  seats_used: seatsUsed,
}: {
  snapshot: EntitlementSnapshot;
  usage: EntitlementPlanUsage;
  seats_used: number;
}): EntitlementsOutput {
  const { planAccess } = snapshot;
  return {
    state: snapshot.state,
    plan: snapshot.plan ? { id: snapshot.plan.publicId, name: snapshot.plan.name } : null,
    features: planAccess.features,
    limits: {
      direct_messages: {
        used: usage.directMessagesUsed,
        limit: limit({ snapshot, key: 'message_month_limit' }),
        resets_on: usage.directMessagesResetsOn,
      },
      channel_accounts: {
        used: usage.channelAccountsUsed,
        limit: limit({ snapshot, key: 'channel_accounts_max' }),
      },
      seats: { used: seatsUsed, limit: limit({ snapshot, key: 'seats' }) },
    },
    trial_ends_at: snapshot.trialEndsAt?.toISOString() ?? null,
    grace_ends_at: snapshot.graceEndsAt?.toISOString() ?? null,
    is_plan_choice_required: planAccess.isPlanChoiceRequired,
    overrides: planAccess.overrides.map((override) => ({
      key: override.key,
      expires_at: override.expiresAt?.toISOString() ?? null,
    })),
    sources: entitlementSources(snapshot),
  };
}
