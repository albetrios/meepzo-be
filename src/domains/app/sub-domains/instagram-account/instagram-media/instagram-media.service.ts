import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { CircuitBreakerOpenError } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  type InstagramGraphPage,
  type InstagramMediaGraphItem,
  assertInstagramConfigured,
  listInstagramMedia,
  listInstagramStories,
  readAnswerCount,
  readAnswerId,
  readAnswerText,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  MetaGraphApiError,
  buildMetaGraphMalformedAnswerError,
  describeMetaGraphError,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { isMetaTokenRefused } from '@/domains/app/sub-domains/channel-connection/channel-connection-error.util.js';
import type { ChannelAccountKey } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { InstagramAccountReadAccess } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import {
  metaGraphCircuitOpenError,
  instagramReconnectRequiredError,
  instagramUnavailableError,
} from '@/domains/app/sub-domains/instagram-account/instagram-account-error.util.js';
import type {
  InstagramMediaCommentWatchValues,
  InstagramMediaRepository,
  InstagramMediaRow,
  InstagramMediaValues,
} from './instagram-media.repository.js';
import {
  readInstagramMediaProductType,
  readInstagramMediaType,
  readInstagramTimestamp,
  serializeInstagramMediaItem,
  serializeInstagramStory,
} from './instagram-media.serializer.js';
import type {
  InstagramMediaConnectionBreakPort,
  InstagramMediaItemOutput,
  InstagramMediaListInput,
  InstagramMediaPage,
  InstagramMediaUpsertInput,
  InstagramStoredMediaTarget,
  InstagramStoryOutput,
} from './instagram-media.types.js';

/** What one live Meta read needs: the account's Instagram user id and its connection's encrypted token. */
interface InstagramLiveReadTarget {
  instagramUserId: string;
  encryptedAccessToken: string;
}

/** Maps a post as Instagram sent it onto the stored row's values (IA17). */
function toInstagramMediaValues({
  channelAccount,
  mediaItem,
}: {
  channelAccount: ChannelAccountKey;
  mediaItem: InstagramMediaGraphItem;
}): InstagramMediaValues {
  const instagramMediaId = readAnswerId(mediaItem.id);
  if (instagramMediaId === null) {
    throw buildMetaGraphMalformedAnswerError({ operation: 'the media read', missing: 'id' });
  }
  const publishedAt = readInstagramTimestamp(mediaItem.timestamp);
  if (publishedAt === null) {
    throw buildMetaGraphMalformedAnswerError({ operation: 'the media read', missing: 'timestamp' });
  }
  const graphData = mediaItem as unknown as Record<string, unknown>;
  const isCommentEnabled = graphData.is_comment_enabled;
  return {
    ...channelAccount,
    instagramMediaId,
    shortcode: readAnswerText(graphData.shortcode),
    mediaType: readInstagramMediaType(mediaItem.media_type),
    mediaProductType: readInstagramMediaProductType(mediaItem.media_product_type),
    caption: readAnswerText(mediaItem.caption),
    mediaUrl: readAnswerText(mediaItem.media_url),
    thumbnailUrl: readAnswerText(mediaItem.thumbnail_url),
    permalink: readAnswerText(mediaItem.permalink),
    publishedAt,
    commentsCount: readAnswerCount(mediaItem.comments_count) ?? 0,
    likeCount: readAnswerCount(mediaItem.like_count) ?? 0,
    isCommentEnabled: typeof isCommentEnabled === 'boolean' ? isCommentEnabled : undefined,
    graphData: { ...graphData },
  };
}

/**
 * The Instagram media service (routes-final § 2.C): the post and story pickers of one named
 * account, read live from Meta through sub-domain 1's client with the connection's token (routes
 * 13–14, IA15), and the stored posts (`app.instagram_media`, IA17) with their missed-comment watch
 * and a Live's end (D40), which sub-domains 4–6 write through it.
 *
 * @remarks
 * Algorithm:
 * - The pickers work in three steps (2.10): the named account, its connection's status and token in
 *   one unit of work ({@link InstagramAccountService.findAccountReadAccess} — the team check, the
 *   account), then — that unit closed — one Meta call, then on Meta's code 190 the connection's break
 *   (MC11, through {@link InstagramMediaConnectionBreakPort}) in a new unit of work. Never a Meta
 *   call inside a database context.
 * - Paging is Meta's own cursor: `limit` passed on, `after` passed back, `next` only when Meta has a
 *   next page; no total.
 *
 * Failure modes:
 * - `404 team_organization_required` (a personal organization), `404 channel_account_not_found`
 *   (another organization's, a revoked or a non-Instagram account), `404 instagram_reconnect_required`
 *   (the account or its connection is `error` — no call — or Meta refused the token or a
 *   permission), `503 instagram_unavailable` with `Retry-After` (Meta down, failing, throttling, or
 *   its circuit open), `503 instagram_not_configured` (the app settings unset) — 2.C.9.
 *
 * Side effects:
 * - The pickers read Meta and store nothing (2.C.10, AC-4.3); a refused token breaks the connection
 *   and its accounts. {@link InstagramMediaService.upsertFromInstagram},
 *   {@link InstagramMediaService.updateCommentWatch}, {@link InstagramMediaService.recordLiveEnded}
 *   and {@link InstagramMediaService.deleteForAccount} write `app.instagram_media`.
 *
 * Notes:
 * - The token stays ciphertext here: the Meta client decrypts it right before its call.
 * - No read cache (IA16).
 */
export class InstagramMediaService {
  constructor(
    private readonly mediaRepository: InstagramMediaRepository,
    private readonly accountService: Pick<InstagramAccountService, 'findAccountReadAccess'>,
    private readonly connectionBreakPort: InstagramMediaConnectionBreakPort,
  ) {}

  /**
   * One page of the named account's posts and reels, live from Meta (route 13, IA15).
   *
   * @remarks
   * Algorithm: {@link InstagramMediaService.readLivePage} over `listInstagramMedia`, each item
   * shaped as the Instagram media item (`kind`, the picture fallback). Failure modes: as the class
   * lists. Side effects: one Meta call; a refused token breaks the connection.
   */
  async listMedia(
    input: InstagramMediaListInput,
  ): Promise<InstagramMediaPage<InstagramMediaItemOutput>> {
    const page = await this.readLivePage({
      input,
      read: (target) =>
        listInstagramMedia({
          ...target,
          limit: input.limit,
          after: input.after,
          requestId: input.requestId,
        }),
    });
    return {
      items: page.items.map(serializeInstagramMediaItem),
      limit: input.limit,
      nextCursor: page.nextCursor,
    };
  }

  /**
   * One page of the named account's live stories, from Meta (route 14, IA15); each story ends 24
   * hours after it was published.
   *
   * @remarks
   * Algorithm: {@link InstagramMediaService.readLivePage} over `listInstagramStories`, each item
   * shaped as the Instagram story. Failure modes: as the class lists. Side effects: one Meta call;
   * a refused token breaks the connection.
   */
  async listStories(
    input: InstagramMediaListInput,
  ): Promise<InstagramMediaPage<InstagramStoryOutput>> {
    const page = await this.readLivePage({
      input,
      read: (target) =>
        listInstagramStories({
          ...target,
          limit: input.limit,
          after: input.after,
          requestId: input.requestId,
        }),
    });
    return {
      items: page.items.map(serializeInstagramStory),
      limit: input.limit,
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Stores a post as Instagram sent it, or refreshes the stored one (IA17) — the one write of
   * `app.instagram_media`, for event processing (a comment on a post not stored yet, sub-domain 4)
   * and "next post" linking (sub-domain 3).
   *
   * @remarks
   * Algorithm: map the Instagram object (types lowered, `timestamp` → `published_at`, missing
   * counts → 0, the object kept as `graph_data`), then one insert-or-refresh by
   * `(organization_id, instagram_media_id)` in the account's organization scope — joining the
   * caller's unit of work when one is open. A media id already stored under another of the
   * organization's accounts is left untouched and answers `null`, so two accounts' posts never mix
   * (AC-3.8). Failure modes: an object without an id or a readable `timestamp` throws an `outage`
   * `MetaGraphApiError` (Instagram misbehaving) before any write; a scope of another organization
   * than the account's fails the composite key or the policy's `WITH CHECK`. Side effects: writes
   * one `app.instagram_media` row. No Instagram call — the caller read the post first
   * (`readInstagramMediaItem`), outside any database context.
   */
  async upsertFromInstagram({
    scope,
    channelAccount,
    mediaItem,
  }: InstagramMediaUpsertInput): Promise<InstagramMediaRow | null> {
    const values = toInstagramMediaValues({ channelAccount, mediaItem });
    return withAppDatabaseContext({
      scope,
      callback: () => this.mediaRepository.upsertForAccount(values),
    });
  }

  /**
   * The account's stored post with this Instagram media id, or `null` when it is not stored yet —
   * event processing reads a commented post from Instagram the first time only (WH13).
   *
   * @remarks
   * Algorithm: one read keyed by the account and the media id, in the account's organization scope
   * (joining the caller's unit of work when one is open). Failure modes: none of its own. Side
   * effects: none — never Instagram.
   */
  async findStoredMedia({
    scope,
    channelAccount,
    instagramMediaId,
  }: InstagramStoredMediaTarget): Promise<InstagramMediaRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: () =>
        this.mediaRepository.findByInstagramMediaId({ ...channelAccount, instagramMediaId }),
    });
  }

  /**
   * The missed-comment watch's write on a stored post (D40, IA17): when it read the comments, when it
   * reads next (`null` stops the watch) and the newest comment it saw — for the missed-comment look
   * (WC-26, sub-domain 5) and whoever starts or stops watching a post (sub-domain 4).
   *
   * @remarks
   * Algorithm: one update keyed by the account and the media id, in the account's organization
   * scope (joining the caller's unit when one is open); a field left `undefined` keeps its value and
   * `last_comment_at` never moves back. Failure modes: none of its own — `null` when the post is not
   * stored for this account. Side effects: writes one `app.instagram_media` row. Never Meta.
   */
  async updateCommentWatch({
    scope,
    channelAccount,
    instagramMediaId,
    watch,
  }: InstagramStoredMediaTarget & {
    watch: InstagramMediaCommentWatchValues;
  }): Promise<InstagramMediaRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: () =>
        this.mediaRepository.updateCommentWatch({ ...channelAccount, instagramMediaId, watch }),
    });
  }

  /**
   * The account's watched posts the missed-comment look reads next (WC-26, sub-domain 5): the due
   * ones (or, for the full pass after an outage, every watched one), a Live left out, read longest
   * ago first, at most `limit`.
   *
   * @remarks
   * Algorithm: one read in the account's organization scope. Failure modes: none of its own. Side
   * effects: none. Never Meta.
   */
  async listWatchedPosts({
    scope,
    channelAccount,
    isDueOnly,
    limit,
  }: Omit<InstagramStoredMediaTarget, 'instagramMediaId'> & {
    isDueOnly: boolean;
    limit: number;
  }): Promise<InstagramMediaRow[]> {
    return withAppDatabaseContext({
      scope,
      callback: () =>
        this.mediaRepository.listWatchedPosts({ ...channelAccount, isDueOnly, limit }),
    });
  }

  /**
   * Records that a Live ended (D40, IA17) — the Live check (WC-16, sub-domain 6) — so its waiting
   * private replies expire without a call.
   *
   * @remarks
   * Algorithm: one update keyed by the account and the media id, in the account's organization
   * scope; the first end time stays. Failure modes: none of its own — `null` when the Live is not
   * stored for this account. Side effects: writes one `app.instagram_media` row. Never Meta.
   */
  async recordLiveEnded({
    scope,
    channelAccount,
    instagramMediaId,
    endedAt,
  }: InstagramStoredMediaTarget & {
    /** When the Live ended — Meta's "Live ended" answer, or the check that no longer sees it. */
    endedAt: Date;
  }): Promise<InstagramMediaRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: () =>
        this.mediaRepository.recordLiveEnded({ ...channelAccount, instagramMediaId, endedAt }),
    });
  }

  /**
   * Deletes every stored post of the account — Meta's data deletion (IA20, IQ4), revoked accounts
   * included. Returns how many were deleted.
   *
   * @remarks
   * Algorithm: one delete keyed by the account, in its organization scope — joining the caller's
   * transaction (route 8's erase) when one is open. Failure modes: none of its own. Side effects:
   * deletes `app.instagram_media` rows; automations, runs and comment logs keep naming the post by
   * its Instagram media id (IA17).
   */
  async deleteForAccount({
    scope,
    channelAccount,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccount: ChannelAccountKey;
  }): Promise<number> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.mediaRepository.deleteForAccount(channelAccount),
    });
  }

  /**
   * IA15's three steps for one picker page: the named account, its connection and token
   * (database), the Meta read (no database context open), the error mapping of 2.C.9.
   */
  private async readLivePage<TItem>({
    input,
    read,
  }: {
    input: InstagramMediaListInput;
    read: (target: InstagramLiveReadTarget) => Promise<InstagramGraphPage<TItem>>;
  }): Promise<InstagramGraphPage<TItem>> {
    const access = await this.accountService.findAccountReadAccess({
      scope: input.scope,
      channelAccountPublicId: input.channelAccountPublicId,
    });
    if (
      access.account.connection_status !== 'connected' ||
      access.connectionStatus !== 'connected' ||
      access.encryptedAccessToken === null
    ) {
      throw instagramReconnectRequiredError();
    }
    assertInstagramConfigured();
    try {
      return await read({
        instagramUserId: access.account.instagram_user_id,
        encryptedAccessToken: access.encryptedAccessToken,
      });
    } catch (error) {
      throw await this.toLiveReadRouteError({
        scope: input.scope,
        access,
        requestId: input.requestId,
        error,
      });
    }
  }

  /**
   * A picker's Meta failure as its route error (2.C.9): the circuit open →
   * `503 instagram_unavailable`; Meta refusing the token (code 190) → the connection's break (MC11),
   * then `404 instagram_reconnect_required`; a refused permission → `404 instagram_reconnect_required`
   * without a break; any other Meta failure (down, throttling, a refused request) →
   * `503 instagram_unavailable` with `Retry-After`. Anything else passes unchanged.
   */
  private async toLiveReadRouteError({
    scope,
    access,
    requestId,
    error,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    access: InstagramAccountReadAccess;
    /** The picker request's id, carried into the reconnect notice jobs for log correlation. */
    requestId: string;
    error: unknown;
  }): Promise<unknown> {
    if (error instanceof CircuitBreakerOpenError) return metaGraphCircuitOpenError(error);
    if (!(error instanceof MetaGraphApiError)) return error;
    if (error.errorClass !== 'auth') return instagramUnavailableError(error.retryAfterSeconds);
    if (isMetaTokenRefused(error)) {
      await this.connectionBreakPort.markConnectionBroken({
        scope,
        channelConnection: access.channelConnection,
        lastCheckError: describeMetaGraphError(error),
        requestId,
      });
    }
    return instagramReconnectRequiredError();
  }
}
