/**
 * Faker generators for the Instagram webhook event bulk seeder. Callers pass the orchestrator's
 * seeded `faker` so a given `SEED` reproduces the same texts.
 */
import type { Faker } from '@faker-js/faker';

/** The longest Instagram username Instagram allows. */
const INSTAGRAM_USERNAME_MAX_LENGTH = 30;

/** Generated content for one demo account's events (keys, ids and statuses are the seeder's). */
export interface BulkInstagramWebhookEventContent {
  /** The commenter's and sender's username — Instagram's alphabet, at most 30 characters. */
  contactUsername: string;
  /** A comment asking for the link. */
  commentText: string;
  /**
   * A DM answering with an email on the reserved `example.com` domain and a phone number — so the
   * list's masking has something to mask.
   */
  directMessageText: string;
  /** A story reply. */
  storyReplyText: string;
}

/**
 * Builds one demo account's event texts from the provided faker instance.
 *
 * @remarks
 * Algorithm: a faker username folded to Instagram's alphabet; short sentences for the texts; the
 * DM carries an `example.com` email and a 10-digit phone number. Failure modes: none. Side
 * effects: advances the faker sequence.
 */
export function generateBulkInstagramWebhookEventContent(
  faker: Faker,
): BulkInstagramWebhookEventContent {
  const contactUsername =
    faker.internet
      .username()
      .toLowerCase()
      .replace(/[^a-z0-9._]/g, '_')
      .slice(0, INSTAGRAM_USERNAME_MAX_LENGTH) || 'demo_customer';
  const email = faker.internet.email({ provider: 'example.com' }).toLowerCase();
  const phone = `+1 ${faker.string.numeric(3)} ${faker.string.numeric(3)} ${faker.string.numeric(4)}`;
  return {
    contactUsername,
    commentText: `${faker.lorem.words(4)} — link please`,
    directMessageText: `Sure, my email is ${email} and my number is ${phone}`,
    storyReplyText: faker.lorem.sentence(),
  };
}
