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
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import type { InstagramAccountKey } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import {
  metaGraphCircuitOpenError,
  instagramReconnectRequiredError,
  instagramUnavailableError,
} from '@/domains/app/sub-domains/instagram-account/instagram-account-error.util.js';
import type {
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
  InstagramMediaItemOutput,
  InstagramMediaListInput,
  InstagramMediaPage,
  InstagramMediaUpsertInput,
  InstagramStoryOutput,
} from './instagram-media.types.js';

/** What one live Instagram read needs: the account's app-scoped id and its encrypted token (IA5). */
interface InstagramLiveReadTarget {
  instagramAppUserId: string;
  encryptedAccessToken: string;
}

/** Maps a post as Instagram sent it onto the stored row's values (IA17). */
function toInstagramMediaValues({
  instagramAccount,
  mediaItem,
}: {
  instagramAccount: InstagramAccountKey;
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
    ...instagramAccount,
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
 * The Instagram media service (routes-final § 1.C): the post and story pickers, read live from
 * Instagram (routes 5–6, IA16), and the stored posts (`app.instagram_media`, IA17) that sub-domains
 * 3–4 write through it.
 *
 * @remarks
 * Algorithm:
 * - The pickers work in three steps (1.10): the live account and its encrypted token in one unit
 *   of work ({@link InstagramAccountService.findLiveAccountAccess} — the team check, the account),
 *   then — that unit closed — one Instagram call, then on a refused token the account's guarded
 *   status change in a new unit of work (IA9). Never an Instagram call inside a database context.
 * - Paging is Instagram's own cursor: `limit` passed on, `after` passed back, `next` only when
 *   Instagram has a next page; no total (IA16).
 *
 * Failure modes:
 * - `404 team_organization_required` (a personal organization), `404 instagram_not_connected`
 *   (no account, or only revoked ones), `404 instagram_reconnect_required` (the account is
 *   `expired` or `error` — no call — or Instagram refused its token), `503 instagram_unavailable`
 *   with `Retry-After` (Instagram down, failing, throttling, or its circuit open),
 *   `503 instagram_not_configured` (the app settings unset) — 1.C.9.
 *
 * Side effects:
 * - The pickers read Instagram and store nothing (1.C.10, AC-3.7); a refused token moves the
 *   account out of `connected`. {@link InstagramMediaService.upsertFromInstagram} and
 *   {@link InstagramMediaService.deleteForAccount} write `app.instagram_media`.
 *
 * Notes:
 * - The token stays ciphertext here: the Instagram client decrypts it right before its call (IA5).
 * - No read cache at launch (IA16).
 */
export class InstagramMediaService {
  constructor(
    private readonly mediaRepository: InstagramMediaRepository,
    private readonly accountService: InstagramAccountService,
  ) {}

  /**
   * One page of the account's posts and reels, live from Instagram (route 5, IA16).
   *
   * @remarks
   * Algorithm: {@link InstagramMediaService.readLivePage} over `listInstagramMedia`, each item
   * shaped as the Instagram media item. Failure modes: as the class lists. Side effects: one
   * Instagram call; a refused token marks the account broken.
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
   * One page of the account's live stories, from Instagram (route 6, IA16); each story ends 24
   * hours after it was published.
   *
   * @remarks
   * Algorithm: {@link InstagramMediaService.readLivePage} over `listInstagramStories`, each item
   * shaped as the Instagram story. Failure modes: as the class lists. Side effects: one Instagram
   * call; a refused token marks the account broken.
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
    instagramAccount,
    mediaItem,
  }: InstagramMediaUpsertInput): Promise<InstagramMediaRow | null> {
    const values = toInstagramMediaValues({ instagramAccount, mediaItem });
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
    instagramAccount,
    instagramMediaId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    instagramAccount: InstagramAccountKey;
    /** Instagram's media id — digits. */
    instagramMediaId: string;
  }): Promise<InstagramMediaRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: () =>
        this.mediaRepository.findByInstagramMediaId({ ...instagramAccount, instagramMediaId }),
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
    instagramAccount,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    instagramAccount: InstagramAccountKey;
  }): Promise<number> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.mediaRepository.deleteForAccount(instagramAccount),
    });
  }

  /**
   * IA16's three steps for one picker page: the live account and its token (database), the
   * Instagram read (no database context open), the error mapping of 1.C.9.
   */
  private async readLivePage<TItem>({
    input,
    read,
  }: {
    input: InstagramMediaListInput;
    read: (target: InstagramLiveReadTarget) => Promise<InstagramGraphPage<TItem>>;
  }): Promise<InstagramGraphPage<TItem>> {
    const { account, instagramAccount, encryptedAccessToken } =
      await this.accountService.findLiveAccountAccess({ scope: input.scope });
    if (account.connection_status !== 'connected' || encryptedAccessToken === null) {
      throw instagramReconnectRequiredError();
    }
    assertInstagramConfigured();
    try {
      return await read({
        instagramAppUserId: account.instagram_app_user_id,
        encryptedAccessToken,
      });
    } catch (error) {
      throw await this.toLiveReadRouteError({
        scope: input.scope,
        instagramAccount,
        requestId: input.requestId,
        error,
      });
    }
  }

  /**
   * A picker's Instagram failure as its route error (1.C.9): the circuit open →
   * `503 instagram_unavailable`; Instagram refusing the token → the guarded status change (IA9),
   * then `404 instagram_reconnect_required`; any other Instagram failure (down, throttling, a
   * refused request) → `503 instagram_unavailable` with `Retry-After`. Anything else passes
   * unchanged.
   */
  private async toLiveReadRouteError({
    scope,
    instagramAccount,
    requestId,
    error,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    instagramAccount: InstagramAccountKey;
    /** The picker request's id, carried into the reconnect notice job for log correlation. */
    requestId: string;
    error: unknown;
  }): Promise<unknown> {
    if (error instanceof CircuitBreakerOpenError) return metaGraphCircuitOpenError(error);
    if (!(error instanceof MetaGraphApiError)) return error;
    if (error.errorClass === 'auth') {
      await this.accountService.markConnectionBroken({
        scope,
        instagramAccount,
        connectionStatus: error.connectionStatus ?? 'error',
        requestId,
      });
      return instagramReconnectRequiredError();
    }
    return instagramUnavailableError(error.retryAfterSeconds);
  }
}
