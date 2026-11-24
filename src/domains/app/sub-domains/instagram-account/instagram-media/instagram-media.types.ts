import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { InstagramMediaGraphItem } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type { InstagramAccountKey } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import type {
  InstagramMediaProductType,
  InstagramMediaType,
  InstagramSingleMediaType,
} from './instagram-media.constants.js';

/** One item of a carousel (routes-final § 1.C.6). */
export interface InstagramMediaChildOutput {
  instagram_media_id: string;
  /** `image` or `video`; `null` when Instagram sends a type this API does not know. */
  media_type: InstagramSingleMediaType | null;
  media_url: string | null;
}

/**
 * The Instagram media item (routes-final § 1.C.6) — one post or reel of route 5, read live from
 * Instagram.
 *
 * @remarks
 * Snake_case wire keys; Instagram's upper-case types lowered, `timestamp` → `published_at`,
 * `children.data` → `children` (IA16). A field Instagram leaves out is `null`.
 */
export interface InstagramMediaItemOutput {
  instagram_media_id: string;
  caption: string | null;
  /** `null` when Instagram sends a type this API does not know. */
  media_type: InstagramMediaType | null;
  media_product_type: InstagramMediaProductType | null;
  media_url: string | null;
  thumbnail_url: string | null;
  permalink: string | null;
  /** ISO 8601; `null` only when Instagram sends no readable `timestamp`. */
  published_at: string | null;
  comments_count: number | null;
  like_count: number | null;
  /** A carousel's items; `null` for a single image or video. */
  children: InstagramMediaChildOutput[] | null;
}

/**
 * The Instagram story (routes-final § 1.C.6) — one live story of route 6, read live from
 * Instagram; `expires_at` is `published_at` + 24 h (IA16).
 */
export interface InstagramStoryOutput {
  instagram_story_id: string;
  media_type: InstagramSingleMediaType | null;
  media_url: string | null;
  thumbnail_url: string | null;
  permalink: string | null;
  published_at: string | null;
  expires_at: string | null;
}

/**
 * One page of a picker (routes 5–6): the items and Instagram's own cursor, passed back as `after`
 * — `null` when Instagram has no next page (IA16). No total: Instagram gives none.
 */
export interface InstagramMediaPage<TItem> {
  items: TItem[];
  /** The page size asked for — the answer's `meta.pagination.per_page`. */
  limit: number;
  nextCursor: string | null;
}

/** Input of `InstagramMediaService.listMedia` and `listStories`. */
export interface InstagramMediaListInput {
  /** The caller's organization scope (the signed `org` claim). */
  scope: OrganizationPrincipalDatabaseScope;
  /** Page size, 1–50. */
  limit: number;
  /** Instagram's `after` cursor from the previous page. */
  after: string | undefined;
  /** The request id, sent to Instagram as `X-Request-Id`. */
  requestId: string;
}

/** Input of `InstagramMediaService.upsertFromInstagram` (IA17). */
export interface InstagramMediaUpsertInput {
  /** The organization scope of the account's organization; nested in the caller's unit of work when one is open. */
  scope: OrganizationPrincipalDatabaseScope;
  /** The account the post belongs to. */
  instagramAccount: InstagramAccountKey;
  /** The post as Instagram sent it (`readInstagramMediaItem`, or a list page's item). */
  mediaItem: InstagramMediaGraphItem;
}
