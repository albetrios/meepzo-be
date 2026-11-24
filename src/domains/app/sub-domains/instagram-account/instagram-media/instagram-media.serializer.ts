import {
  type InstagramMediaChildGraphItem,
  type InstagramMediaGraphItem,
  type InstagramStoryGraphItem,
  readAnswerCount,
  readAnswerId,
  readAnswerText,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  INSTAGRAM_MEDIA_PRODUCT_TYPES,
  INSTAGRAM_MEDIA_TYPES,
  INSTAGRAM_STORY_LIFETIME_MS,
  type InstagramMediaProductType,
  type InstagramMediaType,
  type InstagramSingleMediaType,
} from './instagram-media.constants.js';
import type {
  InstagramMediaChildOutput,
  InstagramMediaItemOutput,
  InstagramStoryOutput,
} from './instagram-media.types.js';

/** `value` lowered when it is one of `allowed`, else `null`. */
function readLoweredValue<TValue extends string>({
  value,
  allowed,
}: {
  value: unknown;
  allowed: readonly TValue[];
}): TValue | null {
  if (typeof value !== 'string') return null;
  const lowered = value.toLowerCase();
  return (allowed as readonly string[]).includes(lowered) ? (lowered as TValue) : null;
}

/**
 * Instagram's `media_type` lowered (`IMAGE` → `image`, `CAROUSEL_ALBUM` → `carousel_album`, IA16);
 * `null` when it is missing or a type this API does not know yet.
 */
export function readInstagramMediaType(value: unknown): InstagramMediaType | null {
  return readLoweredValue({ value, allowed: INSTAGRAM_MEDIA_TYPES });
}

/**
 * Instagram's `media_product_type` lowered (`REELS` → `reels`, IA16); `null` when it is missing or
 * unknown.
 */
export function readInstagramMediaProductType(value: unknown): InstagramMediaProductType | null {
  return readLoweredValue({ value, allowed: INSTAGRAM_MEDIA_PRODUCT_TYPES });
}

/** A story's or a carousel child's media type — `image` or `video`, never a carousel. */
function readInstagramSingleMediaType(value: unknown): InstagramSingleMediaType | null {
  const mediaType = readInstagramMediaType(value);
  return mediaType === 'carousel_album' ? null : mediaType;
}

/**
 * Instagram's `timestamp` (`2026-11-20T10:00:00+0000`) as a `Date`; `null` when it is missing or
 * unreadable.
 */
export function readInstagramTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

/** A carousel's items (`children.data`), each with an id; `null` when there are none. */
function serializeInstagramMediaChildren(
  children: InstagramMediaGraphItem['children'],
): InstagramMediaChildOutput[] | null {
  const data: unknown = children?.data;
  if (!Array.isArray(data)) return null;
  const serialized = data.flatMap((child: InstagramMediaChildGraphItem) => {
    const instagramMediaId = readAnswerId(child?.id);
    if (instagramMediaId === null) return [];
    return [
      {
        instagram_media_id: instagramMediaId,
        media_type: readInstagramSingleMediaType(child.media_type),
        media_url: readAnswerText(child.media_url),
      },
    ];
  });
  return serialized.length > 0 ? serialized : null;
}

/**
 * Shapes one post or reel of Instagram's `/{id}/media` answer as the Instagram media item
 * (routes-final § 1.C.6): types lowered, `timestamp` → `published_at` (ISO 8601),
 * `children.data` → `children` (IA16). A field Instagram leaves out is `null`.
 */
export function serializeInstagramMediaItem(
  item: InstagramMediaGraphItem,
): InstagramMediaItemOutput {
  return {
    instagram_media_id: readAnswerId(item.id) ?? String(item.id),
    caption: readAnswerText(item.caption),
    media_type: readInstagramMediaType(item.media_type),
    media_product_type: readInstagramMediaProductType(item.media_product_type),
    media_url: readAnswerText(item.media_url),
    thumbnail_url: readAnswerText(item.thumbnail_url),
    permalink: readAnswerText(item.permalink),
    published_at: readInstagramTimestamp(item.timestamp)?.toISOString() ?? null,
    comments_count: readAnswerCount(item.comments_count),
    like_count: readAnswerCount(item.like_count),
    children: serializeInstagramMediaChildren(item.children),
  };
}

/**
 * Shapes one story of Instagram's `/{id}/stories` answer as the Instagram story (routes-final
 * § 1.C.6): `expires_at` is `published_at` + 24 h — Instagram sends none (IA16).
 */
export function serializeInstagramStory(item: InstagramStoryGraphItem): InstagramStoryOutput {
  const publishedAt = readInstagramTimestamp(item.timestamp);
  return {
    instagram_story_id: readAnswerId(item.id) ?? String(item.id),
    media_type: readInstagramSingleMediaType(item.media_type),
    media_url: readAnswerText(item.media_url),
    thumbnail_url: readAnswerText(item.thumbnail_url),
    permalink: readAnswerText(item.permalink),
    published_at: publishedAt?.toISOString() ?? null,
    expires_at:
      publishedAt === null
        ? null
        : new Date(publishedAt.getTime() + INSTAGRAM_STORY_LIFETIME_MS).toISOString(),
  };
}
