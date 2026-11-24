/**
 * Faker generators for the Instagram account bulk seeder. Callers pass the orchestrator's seeded
 * `faker` so a given `SEED` reproduces the same profiles.
 */
import type { Faker } from '@faker-js/faker';

/** The longest Instagram username Instagram allows. */
const INSTAGRAM_USERNAME_MAX_LENGTH = 30;

/** Generated profile content for one demo `app.instagram_accounts` row (ids are the seeder's). */
export interface BulkInstagramAccountProfile {
  /** Lower-case letters, digits, `.` and `_`, at most 30 characters — Instagram's own rule. */
  username: string;
  /** A one-line bio. */
  biography: string;
  /** A link on the reserved `example.com` domain, never a real site. */
  website: string;
  /** Follower count. */
  followersCount: number;
  /** Following count. */
  followsCount: number;
  /** Posts and reels count. */
  mediaCount: number;
}

/**
 * Builds one fake Instagram professional account profile from the provided faker instance.
 *
 * @remarks
 * Algorithm: a faker username folded to Instagram's alphabet (lower case, `.` and `_` only) and
 * cut to 30 characters; a catch phrase as the bio; an `example.com`
 * link; plausible counts. Failure modes: none. Side effects: advances the faker sequence.
 */
export function generateBulkInstagramAccountProfile(faker: Faker): BulkInstagramAccountProfile {
  const username =
    faker.internet
      .username()
      .toLowerCase()
      .replace(/[^a-z0-9._]/g, '_')
      .slice(0, INSTAGRAM_USERNAME_MAX_LENGTH) || 'demo_shop';
  return {
    username,
    biography: faker.company.catchPhrase(),
    website: `https://example.com/${username}`,
    followersCount: faker.number.int({ min: 100, max: 50_000 }),
    followsCount: faker.number.int({ min: 10, max: 2_000 }),
    mediaCount: faker.number.int({ min: 5, max: 500 }),
  };
}
