import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';

/**
 * Every `media_type` of a post, reel or story (routes-final § 1.C.3, 1.C.6) — Instagram's upper
 * case lowered (`CAROUSEL_ALBUM` → `carousel_album`). Mirrors `chk_instagram_media_media_type`.
 */
export const INSTAGRAM_MEDIA_TYPES = ['image', 'video', 'carousel_album'] as const;

/** One value of {@link INSTAGRAM_MEDIA_TYPES}. */
export type InstagramMediaType = (typeof INSTAGRAM_MEDIA_TYPES)[number];

/**
 * The media types a story or a carousel child can carry — a story is never a carousel (§ 1.C.6).
 */
export type InstagramSingleMediaType = Exclude<InstagramMediaType, 'carousel_album'>;

/**
 * Every `media_product_type` (routes-final § 1.C.3, 1.C.6) — where the media appears, lowered
 * (`REELS` → `reels`, IA16). Mirrors `chk_instagram_media_media_product_type`.
 */
export const INSTAGRAM_MEDIA_PRODUCT_TYPES = ['feed', 'reels', 'story', 'ad'] as const;

/** One value of {@link INSTAGRAM_MEDIA_PRODUCT_TYPES}. */
export type InstagramMediaProductType = (typeof INSTAGRAM_MEDIA_PRODUCT_TYPES)[number];

/**
 * The post and story pickers' page size (routes 5–6, § 1.C.8): Instagram's own `limit`, 1–50,
 * default 25 — tighter than the platform's list maximum, since each page is one Instagram call.
 */
export const INSTAGRAM_MEDIA_PAGE_SIZE = { default: 25, maximum: 50 } as const;

/** The longest Instagram `after` cursor the pickers pass back (§ 1.C.8). */
export const INSTAGRAM_MEDIA_CURSOR_MAX_LENGTH = 1000;

/** How long a story stays live after it is published — its `expires_at` (IA16). */
export const INSTAGRAM_STORY_LIFETIME_MS = MILLISECONDS_PER_DAY;
