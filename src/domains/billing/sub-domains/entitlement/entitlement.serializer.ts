import type { OrganizationEntitlementOverrideRow } from './entitlement-override.schema.js';
import type { EntitlementOverrideKey } from './entitlement.constants.js';
import { isEntitlementOverrideActive } from './entitlement-override.util.js';
import type { EntitlementOverrideOutput } from './entitlement.types.js';

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
