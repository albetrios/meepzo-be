import { CHIP_TONE } from '@/shared/constants/record-fields.constants.js';

/** IANA timezone a new organization starts with; timed work runs in the organization's timezone. */
export const ORGANIZATION_DEFAULT_TIMEZONE = 'Asia/Kolkata';

/** The one currency an organization trades in at launch — server-set, never client-written. */
export const ORGANIZATION_CURRENCY = 'INR';

/**
 * The organization's tile colours (`tenancy.organizations.logo_color`, routes-final § 9.A TN8): five
 * of the shared chip tones, so one tone vocabulary serves roles, members and organizations.
 *
 * @remarks
 * - **Algorithm:** the order is the one `tenancy.fn_organization_logo_color(name)` indexes into
 *   (`20261124062835_tenancy_organizations_logo_color.sql`) — keep the two in step.
 * - **Failure modes:** a value outside the list fails the DTO (400, `body.logo_color`) and the
 *   table's `chk_organizations_logo_color` CHECK (Postgres `23514`).
 */
export const ORGANIZATION_LOGO_COLORS = [
  CHIP_TONE.SKY,
  CHIP_TONE.LAVENDER,
  CHIP_TONE.SAGE,
  CHIP_TONE.PEACH,
  CHIP_TONE.SLATE,
] as const;

/** Literal union of {@link ORGANIZATION_LOGO_COLORS}. */
export type OrganizationLogoColor = (typeof ORGANIZATION_LOGO_COLORS)[number];

/** The longest organization slug (`tenancy.organizations.slug` is `varchar(100)`). */
export const ORGANIZATION_SLUG_MAX_LENGTH = 100;

/** The slug made for a name that holds no letter or digit (`"🌸🌸"` → `organization`). */
export const ORGANIZATION_SLUG_FALLBACK = 'organization';

/** Length of the random suffix a made slug takes when the plain one is taken (`acme-x7k2p9`). */
export const ORGANIZATION_SLUG_SUFFIX_LENGTH = 6;

/** How many made slugs a create tries before answering `409 organization_slug_exists`. */
export const ORGANIZATION_SLUG_MAX_ATTEMPTS = 4;

/** The longest `q` the organization chooser takes (route 132, feat-instagram-dm-sending UN5). */
export const ORGANIZATION_CHOOSER_SEARCH_MAX_LENGTH = 100;
