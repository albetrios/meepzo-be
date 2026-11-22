/**
 * Faker generators for the automation bulk seeder. Callers pass the orchestrator's seeded `faker` so
 * a given `SEED` reproduces the same automations.
 */
import type { Faker } from '@faker-js/faker';

/** Keyword sets a demo automation may listen for (lower case, as the table stores them). */
const DEMO_KEYWORD_SETS = [
  ['price', 'cost'],
  ['link'],
  ['shop', 'buy'],
  ['info', 'details'],
  ['giveaway'],
] as const;

/** Tags a demo automation may give its contacts. */
const DEMO_TAGS = ['launch', 'vip', 'newsletter', 'catalog', 'price-request'] as const;

/** Generated content for one demo automation's words (the seeder sets the flow shape). */
export interface BulkAutomationWords {
  keywords: string[];
  tags: string[];
  /** The opening message's text. */
  openingText: string;
  /** The final message's text. */
  finalText: string;
}

/**
 * Builds the words of one demo automation from the provided faker instance.
 *
 * @remarks
 * Keywords come from a fixed list (lower case, deduplicated — as a save normalises them), tags
 * from another; the texts are short faker sentences. Never a real person's or brand's name.
 */
export function generateBulkAutomationWords(faker: Faker): BulkAutomationWords {
  return {
    keywords: [...faker.helpers.arrayElement(DEMO_KEYWORD_SETS)],
    tags: faker.helpers.arrayElements([...DEMO_TAGS], { min: 0, max: 2 }),
    openingText: `Thanks for reaching out! ${faker.lorem.sentence({ min: 3, max: 8 })}`.slice(
      0,
      1000,
    ),
    finalText: `Here you go. ${faker.lorem.sentence({ min: 3, max: 8 })}`.slice(0, 1000),
  };
}
