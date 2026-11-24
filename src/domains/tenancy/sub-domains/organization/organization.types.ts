import type { OrganizationLogoColor } from './organization.constants.js';

/** Internal domain row mirroring `tenancy.organizations` — includes audit columns and soft-delete. */
export interface Organization {
  id: number;
  public_id: string;
  name: string;
  /** Null for PERSONAL organizations (no human handle); kebab string for TEAM. */
  slug: string | null;
  /** `PERSONAL` (single-owner workspace) or `TEAM` (shareable). */
  type: string;
  owner_user_id: number;
  status: string;
  logo_url: string | null;
  /** The tile colour (TN8) — one of `ORGANIZATION_LOGO_COLORS`. */
  logo_color: OrganizationLogoColor;
  stripe_customer_id: string | null;
  /** IANA time zone its timed work runs in (D41). */
  timezone: string;
  /** Always `INR` at launch (server-set). */
  currency: string;
  deleted_at: Date | null;
  deletion_started_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Public organization shape returned by the API — produced by {@link serializeOrganization}. */
export interface OrganizationOutput {
  id: string;
  name: string;
  /** Null for the personal organization. */
  slug: string | null;
  type: string;
  status: string;
  /**
   * The owner's user id (`usr_…`, launch D81 (4)) — compare with `user.id` to know whether you own
   * it; null only when the owner's login is gone.
   */
  owner_user_id: string | null;
  logo_url: string | null;
  /**
   * The tile colour shown when there is no logo (TN8): `sky` · `lavender` · `sage` · `peach` ·
   * `slate`; picked from the name at create unless one is chosen.
   */
  logo_color: OrganizationLogoColor;
  /** IANA time zone its timed work runs in (D41). */
  timezone: string;
  /** Always `INR` at launch. */
  currency: string;
  created_at: string;
  updated_at: string;
}

/**
 * One organization of the chooser (`GET /users/me/organizations`, route 132, feat-instagram-dm-sending
 * UN5): the organization, the caller's main role and the three counts.
 */
export interface OrganizationChooserOutput extends OrganizationOutput {
  /** The caller's main role here (`rol_…` and its name). */
  role: { id: string; name: string } | null;
  /** Active members. */
  members_count: number;
  /** Channel accounts not revoked. */
  channel_accounts_count: number;
  /** Automations live and not deleted. */
  live_automations_count: number;
}

/**
 * The counts of one organization the chooser shows, as the app's counts port answers them (UN1, UN5).
 */
export interface OrganizationCounts {
  organizationPublicId: string;
  membersCount: number;
  channelAccountsCount: number;
  liveAutomationsCount: number;
}

/** Internal organization fields exposed to cross-domain billing services. */
export interface OrganizationBillingContext {
  id: number;
  public_id: string;
  name: string;
  slug: string | null;
  type: string;
  stripe_customer_id: string | null;
}

/** Organization fields required for membership flows within the tenancy domain. */
export interface OrganizationMembershipContext extends OrganizationBillingContext {
  owner_user_id: number;
}
