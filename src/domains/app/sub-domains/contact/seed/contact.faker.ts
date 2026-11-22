/**
 * Faker generators for the contact bulk seeder. Callers pass the orchestrator's seeded `faker` so a
 * given `SEED` reproduces the same contacts.
 */
import type { Faker } from '@faker-js/faker';

/** The longest Instagram username Instagram allows. */
const INSTAGRAM_USERNAME_MAX_LENGTH = 30;

/** The tags a demo run may have left on a contact (an automation's tag, or its name). */
const DEMO_CONTACT_TAGS = [
  'giveaway',
  'price-request',
  'vip',
  'newsletter',
  'Spring sale DM',
  'catalog',
] as const;

/** Generated content for one demo `app.contacts` row (ids and times are the seeder's). */
export interface BulkContactProfile {
  /** Instagram's alphabet, at most 30 characters; `null` for a DM-only contact never read. */
  username: string | null;
  fullName: string | null;
  /** An `https://` link on the reserved `example.com` domain, never a real CDN. */
  profilePictureUrl: string | null;
  followersCount: number | null;
  /** `null` = never checked. */
  isFollowingAccount: boolean | null;
  /** Lower case, on the reserved `example.com` domain; `null` when the contact never shared one. */
  email: string | null;
  /** An optional `+` and 10–15 digits (CT10); `null` when never shared. */
  phone: string | null;
  tags: string[];
}

/**
 * Builds one fake contact from the provided faker instance.
 *
 * @remarks
 * Algorithm: about one in six contacts has no username and no profile (a DM-only contact whose
 * profile was never read — it sorts last by username); the rest get a username folded to
 * Instagram's alphabet, a name, an `example.com` picture link and a follower count; about half
 * were follow-checked; about a third shared an email, a quarter a phone; zero to three tags.
 * Failure modes: none. Side effects: advances the faker sequence.
 */
export function generateBulkContactProfile(faker: Faker): BulkContactProfile {
  const hasProfile = faker.number.int({ min: 1, max: 6 }) > 1;
  const username = hasProfile
    ? faker.internet
        .username()
        .toLowerCase()
        .replace(/[^a-z0-9._]/g, '_')
        .slice(0, INSTAGRAM_USERNAME_MAX_LENGTH) || 'demo_contact'
    : null;
  const followChecked = faker.datatype.boolean();
  return {
    username,
    fullName: hasProfile ? faker.person.fullName() : null,
    profilePictureUrl: hasProfile ? `https://example.com/avatars/${username}.jpg` : null,
    followersCount: hasProfile ? faker.number.int({ min: 0, max: 20_000 }) : null,
    isFollowingAccount: followChecked ? faker.datatype.boolean() : null,
    email:
      faker.number.int({ min: 1, max: 3 }) === 1
        ? `${faker.string.alphanumeric({ length: 10, casing: 'lower' })}@example.com`
        : null,
    phone:
      faker.number.int({ min: 1, max: 4 }) === 1
        ? `+1${faker.string.numeric({ length: 10, allowLeadingZeros: false })}`
        : null,
    tags: faker.helpers.arrayElements(DEMO_CONTACT_TAGS, { min: 0, max: 3 }),
  };
}
