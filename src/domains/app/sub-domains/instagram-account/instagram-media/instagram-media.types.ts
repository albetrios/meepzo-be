import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { InstagramMediaGraphItem } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type { ChannelAccountKey } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import type { ChannelConnectionKey } from '@/domains/app/sub-domains/channel-connection/channel-connection.repository.js';
import type {
  InstagramMediaKind,
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
 * The Instagram media item (routes-final § 2.C.6) — one post or reel of route 13, read live from
 * Meta.
 *
 * @remarks
 * Snake_case wire keys; Meta's upper-case types lowered, `timestamp` → `published_at`,
 * `children.data` → `children` (IA16); `kind` from the product type and `media_url` never empty when
 * Meta gives a thumbnail or link (IA15). A field Meta leaves out is `null`.
 */
export interface InstagramMediaItemOutput {
  instagram_media_id: string;
  /** `post` · `reel` · `ad_post`, from `media_product_type` (IA15). */
  kind: InstagramMediaKind;
  caption: string | null;
  /** `null` when Instagram sends a type this API does not know. */
  media_type: InstagramMediaType | null;
  media_product_type: InstagramMediaProductType | null;
  /** Meta's `media_url`, else `thumbnail_url`, else `permalink` (plan:L811); `null` only when all three are missing. */
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
 * The Instagram story (routes-final § 2.C.6) — one live story of route 14, read live from
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
 * One page of a picker (routes 13–14): the items and Instagram's own cursor, passed back as `after`
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
  /** The account's one id, `cha_…` (route 13–14's `{channel_account_id}`, P47). */
  channelAccountPublicId: string;
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
  /** The channel account the post belongs to (P47). */
  channelAccount: ChannelAccountKey;
  /** The post as Instagram sent it (`readInstagramMediaItem`, or a list page's item). */
  mediaItem: InstagramMediaGraphItem;
}

/** A stored post of one channel account, by its Instagram media id — the key the watch and the Live end take. */
export interface InstagramStoredMediaTarget {
  /** The organization scope of the account's organization; nested in the caller's unit of work when one is open. */
  scope: OrganizationPrincipalDatabaseScope;
  /** The channel account the post belongs to (P47). */
  channelAccount: ChannelAccountKey;
  /** Instagram's media id — digits. */
  instagramMediaId: string;
}

/**
 * The connection's break on Meta's code 190 (routes-final § 1 MC11) as routes 13–14 call it —
 * `ChannelConnectionService.markConnectionBroken`'s shape (ROUTE row R4).
 *
 * @remarks
 * Notes: the connection's guarded `connected → error`, then every `connected` account of it →
 * `error` with one reconnect notice each; `false` when another caller already broke it. Until R4's
 * connection service is wired here, the app container passes an adapter over the channel account's
 * `markAccountsOfConnectionBroken` (the accounts' half of MC11).
 */
export interface InstagramMediaConnectionBreakPort {
  markConnectionBroken(input: {
    scope: OrganizationPrincipalDatabaseScope;
    channelConnection: ChannelConnectionKey;
    /** Meta's class, code, subcode and HTTP status — never its text. */
    lastCheckError: string;
    /** The caller's request id, carried into the notice jobs. */
    requestId: string;
  }): Promise<boolean>;
}
