import type { PlanFeatures } from '@/domains/billing/sub-domains/plan/plan.types.js';
import type {
  PlanAccess,
  PlanAccessState,
} from '@/domains/billing/sub-domains/subscription/subscription.types.js';
import type {
  EntitlementKey,
  EntitlementLimitKey,
  EntitlementOverrideKey,
  EntitlementSwitchKey,
} from './entitlement.constants.js';

/**
 * Where a resolved entitlement value came from (change-plan-gates EN2, P19) — the merge order:
 * `override` (an active organization override set it) → `plan` (the plan row carried it) →
 * `default` (the registry default filled it).
 */
export type EntitlementSource = 'override' | 'plan' | 'default';

/** One resolved registry key: its value and where it came from (EN2). */
export interface EntitlementResolvedValue<Value> {
  value: Value;
  source: EntitlementSource;
}

/**
 * Every registry key resolved (EN2): a switch is on or off; a limit is a whole number, or `null` for
 * unlimited (seats by default, D55; and every limit with no plan in the catalog).
 */
export type EntitlementSnapshotValues = {
  [Key in EntitlementSwitchKey]: EntitlementResolvedValue<boolean>;
} & {
  [Key in EntitlementLimitKey]: EntitlementResolvedValue<number | null>;
};

/**
 * An organization's resolved entitlement (change-plan-gates EN2, P24) — what `resolve` answers from
 * the one plan read: the plan state and its dates, the plan, and every registry key with its source.
 * `can` and `limit` read it; a caller with several gates passes it on instead of reading again (K2).
 */
export interface EntitlementSnapshot {
  state: PlanAccessState;
  /** When the grace ends (`grace`) or ended (`read_only`); `null` when `active`. */
  graceEndsAt: Date | null;
  /** When the trial ends while it runs; `null` otherwise. */
  trialEndsAt: Date | null;
  /** The plan whose features apply; `null` only with no Free plan in the catalog. */
  plan: { publicId: string; name: string } | null;
  /** Every registry key's value and source. */
  values: EntitlementSnapshotValues;
  /** The plan read the snapshot was built from (features, overrides in force, plan choice). */
  planAccess: PlanAccess;
}

/** The source of every registry key, keyed by key — `sources` on `GET /billing/entitlements` (EN6). */
export type EntitlementSourcesOutput = Record<EntitlementKey, EntitlementSource>;

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

/** One limit with what the organization uses of it (`GET /billing/entitlements`, P271). */
export interface EntitlementLimitOutput {
  used: number;
  /** The plan's limit after overrides; `null` = unlimited (or no plan in the catalog). */
  limit: number | null;
}

/**
 * Public body of `GET /api/v1/billing/entitlements` (plan-gating close, P271): the organization's
 * plan state, the plan, its features after overrides, each limit with its usage, the dates and the
 * overrides in force.
 */
export interface EntitlementsOutput {
  state: PlanAccessState;
  /** The plan whose features apply (`pln_…` and name); `null` only with no Free plan in the catalog. */
  plan: { id: string; name: string } | null;
  /** The typed features with the active overrides laid over them; `null` exactly when `plan` is. */
  features: PlanFeatures | null;
  limits: {
    /** This month's DMs; `resets_on` is the 1st of next month (`YYYY-MM-DD`, the organization's month). */
    direct_messages: EntitlementLimitOutput & { resets_on: string };
    /** Channel accounts in the plan against `channel_accounts_max`. */
    channel_accounts: EntitlementLimitOutput;
    /** Members (active + invited) against the plan's seats (`null` = unlimited, D55). */
    seats: EntitlementLimitOutput;
  };
  /** ISO 8601 — while a trial runs; `null` otherwise. */
  trial_ends_at: string | null;
  /** ISO 8601 — when the grace ends (`grace`) or ended (`read_only`); `null` when `active`. */
  grace_ends_at: string | null;
  is_plan_choice_required: boolean;
  /** The overrides in force now (their keys are already in `features`). */
  overrides: { key: EntitlementOverrideKey; expires_at: string | null }[];
  /**
   * Where each registry key's value came from (change-plan-gates EN6): `override`, `plan` or
   * `default` — the 11 switches, `message_month_limit`, `channel_accounts_max` and `seats`.
   */
  sources: EntitlementSourcesOutput;
}

/** What the app reports of an organization's use of its plan — billing's usage port (P271). */
export interface EntitlementPlanUsage {
  /** DMs sent this month (the organization's month count). */
  directMessagesUsed: number;
  /** The 1st of next month, `YYYY-MM-DD` — when the count starts again. */
  directMessagesResetsOn: string;
  /** Channel accounts in the plan (active, not stopped by the plan). */
  channelAccountsUsed: number;
}
