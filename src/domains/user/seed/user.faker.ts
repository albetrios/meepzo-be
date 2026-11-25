/**
 * Faker generators for the user bulk seeder. Callers pass the orchestrator's seeded
 * `faker` so output is reproducible for a given `SEED`.
 */
import type { Faker } from '@faker-js/faker';
import {
  USER_GOALS,
  USER_INSTAGRAM_HANDLE_MAX_LENGTH,
  type UserGoal,
} from '@/domains/user/user.constants.js';

/** A generated user's display fields (email is derived deterministically by index, not here). */
export interface BulkUserProfile {
  /** First name. */
  first_name: string;
  /** Last name. */
  last_name: string;
  /** Free-text job title (onboarding profile field). */
  job_title: string;
  /** Onboarding's Instagram handle — Instagram's form (feat-instagram-dm-sending UN3). */
  instagram_handle: string;
  /** Onboarding's goal (UN3). */
  goal: UserGoal;
}

/** Builds one fake user's name + job-title fields from the provided faker instance. */
export function generateBulkUser(faker: Faker): BulkUserProfile {
  return {
    first_name: faker.person.firstName(),
    last_name: faker.person.lastName(),
    job_title: faker.person.jobTitle(),
    instagram_handle:
      faker.internet
        .username()
        .toLowerCase()
        .replace(/[^a-z0-9._]/g, '')
        .slice(0, USER_INSTAGRAM_HANDLE_MAX_LENGTH) || 'creator',
    goal: faker.helpers.arrayElement(USER_GOALS),
  };
}
