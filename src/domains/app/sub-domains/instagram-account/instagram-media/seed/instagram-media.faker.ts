/**
 * Faker generators for the stored-posts bulk seeder. Callers pass the orchestrator's seeded `faker`
 * so a given `SEED` reproduces the same posts.
 */
import type { Faker } from '@faker-js/faker';
import type {
  InstagramMediaProductType,
  InstagramMediaType,
} from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.constants.js';

/** The oldest a seeded post may be, in days. */
const SEEDED_POST_MAX_AGE_DAYS = 90;

/** Generated content for one demo `app.instagram_media` row (ids and links are the seeder's). */
export interface BulkInstagramMediaPost {
  /** A short caption that invites a keyword comment, as the comment automations expect. */
  caption: string;
  mediaType: InstagramMediaType;
  /** `feed` for images and carousels, `reels` for videos. */
  mediaProductType: Extract<InstagramMediaProductType, 'feed' | 'reels'>;
  commentsCount: number;
  likeCount: number;
  /** How many days ago the post was published (1–90). */
  publishedDaysAgo: number;
}

/**
 * Builds one fake post or reel from the provided faker instance.
 *
 * @remarks
 * Algorithm: a media type picked from the three, its product type following it (a video is a reel),
 * a catch phrase plus a keyword call as the caption, plausible counts and an age of 1–90 days.
 * Failure modes: none. Side effects: advances the faker sequence.
 */
export function generateBulkInstagramMediaPost(faker: Faker): BulkInstagramMediaPost {
  const mediaType = faker.helpers.arrayElement<InstagramMediaType>([
    'image',
    'video',
    'carousel_album',
  ]);
  return {
    caption: `${faker.company.catchPhrase()} — comment SHOP for the link`,
    mediaType,
    mediaProductType: mediaType === 'video' ? 'reels' : 'feed',
    commentsCount: faker.number.int({ min: 0, max: 200 }),
    likeCount: faker.number.int({ min: 0, max: 5_000 }),
    publishedDaysAgo: faker.number.int({ min: 1, max: SEEDED_POST_MAX_AGE_DAYS }),
  };
}
