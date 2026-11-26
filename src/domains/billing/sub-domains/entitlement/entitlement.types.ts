import type { EntitlementOverrideKey } from './entitlement.constants.js';

/**
 * Public body of one organization entitlement override (plan-gating close, P270) — the admin
 * list, set and remove answer it.
 */
export interface EntitlementOverrideOutput {
  /** `ovr_…` */
  id: string;
  /** The organization's `org_…` id. */
  organization_id: string;
  key: EntitlementOverrideKey;
  /** A boolean for a plan feature switch, an integer for a limit. */
  value: boolean | number;
  /** ISO 8601; `null` = no end. */
  expires_at: string | null;
  /** Whether it is in force now (not removed and not past `expires_at`). */
  is_active: boolean;
  reason: string;
  created_at: string;
  updated_at: string;
}
