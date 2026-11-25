import { and, desc, eq, sql } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import {
  databaseNowTimestamp,
  databaseUpdatedAtTimestamp,
} from '@/shared/utils/infrastructure/database-timestamp.util.js';
import type { ChannelAccountKey } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import type { InstagramMediaProductType, InstagramMediaType } from './instagram-media.constants.js';
import { instagram_media } from './instagram-media.schema.js';

/** `updated_at` for every change of a stored post — never before the row's `created_at`. */
const mediaUpdatedAtTimestamp = databaseUpdatedAtTimestamp(instagram_media.created_at);

/** One `app.instagram_media` row as Drizzle reads it. */
export type InstagramMediaRow = typeof instagram_media.$inferSelect;

/**
 * What a stored post holds (routes-final § 1.C.3), already mapped from Instagram's answer: the
 * account it belongs to, Instagram's ids, the lowered types, the counts and the object as read.
 */
export interface InstagramMediaValues extends ChannelAccountKey {
  /** Instagram's media id — digits. */
  instagramMediaId: string;
  shortcode: string | null;
  mediaType: InstagramMediaType | null;
  mediaProductType: InstagramMediaProductType | null;
  caption: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  publishedAt: Date;
  commentsCount: number;
  likeCount: number;
  /** `undefined` when Instagram did not say: a new row takes the default (`true`), a stored row keeps its value. */
  isCommentEnabled: boolean | undefined;
  /** The Instagram object as read — a JSON object. */
  graphData: Record<string, unknown>;
}

/**
 * The watch fields one {@link InstagramMediaRepository.updateCommentWatch} writes; `undefined` keeps
 * a field as it is.
 */
export interface InstagramMediaCommentWatchValues {
  /** When the watch read the post's comments now. */
  commentsCheckedAt?: Date | undefined;
  /** When it reads them next; `null` stops the watch. */
  commentsNextCheckAt?: Date | null | undefined;
  /** The newest comment it saw; never moves the stored time back. */
  lastCommentAt?: Date | undefined;
}

/** The one stored post of an account, by its Instagram media id — every statement names the organization. */
function storedMediaWhere({
  organizationId,
  channelAccountId,
  instagramMediaId,
}: ChannelAccountKey & { instagramMediaId: string }) {
  return and(
    eq(instagram_media.organization_id, organizationId),
    eq(instagram_media.channel_account_id, channelAccountId),
    eq(instagram_media.instagram_media_id, instagramMediaId),
  );
}

/**
 * Drizzle access to `app.instagram_media` (routes-final § 2.C.3, IAC10): the insert-or-refresh of a
 * stored post (IA17), the read of one stored post (event processing, WH13), the missed-comment watch
 * and a Live's end (D40), and the erase of an account's posts (IA20).
 *
 * @remarks
 * - **Algorithm:** every statement names `organization_id`, so tenant isolation does not rest on
 *   RLS alone. The upsert keys on the unique `(organization_id, instagram_media_id)` index and
 *   refreshes a stored row only when it belongs to the same account — a post stored under another
 *   of the organization's accounts is left as it is, so two accounts' posts never mix (IA17).
 * - **Failure modes:** a value the table's CHECKs refuse (a non-digit media id, an unknown type)
 *   throws Postgres 23514; an account of another organization fails the composite key (23503).
 * - **Side effects:** writes `app.instagram_media` only.
 * - **Notes:** written only through `InstagramMediaService` (1.C.10), never by another
 *   sub-domain's repository. HTTP paths run inside the caller's `withAppDatabaseContext`; workers
 *   bind a handle through {@link createWorkerInstagramMediaRepository}.
 */
export class InstagramMediaRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /**
   * Inserts the post, or refreshes the stored row of the same Instagram media id when it belongs to
   * the same account (`synced_at` and `updated_at` move to now). Returns the written row, or `null`
   * when the media id is stored under another of the organization's accounts — that row is not
   * touched.
   */
  async upsertForAccount(values: InstagramMediaValues): Promise<InstagramMediaRow | null> {
    const columns = {
      shortcode: values.shortcode,
      media_type: values.mediaType,
      media_product_type: values.mediaProductType,
      caption: values.caption,
      media_url: values.mediaUrl,
      thumbnail_url: values.thumbnailUrl,
      permalink: values.permalink,
      published_at: values.publishedAt,
      comments_count: values.commentsCount,
      like_count: values.likeCount,
      graph_data: values.graphData,
      ...(values.isCommentEnabled === undefined
        ? {}
        : { is_comment_enabled: values.isCommentEnabled }),
    };
    const rows = await this.db()
      .insert(instagram_media)
      .values({
        organization_id: values.organizationId,
        channel_account_id: values.channelAccountId,
        instagram_media_id: values.instagramMediaId,
        ...columns,
      })
      .onConflictDoUpdate({
        target: [instagram_media.organization_id, instagram_media.instagram_media_id],
        set: { ...columns, synced_at: databaseNowTimestamp, updated_at: mediaUpdatedAtTimestamp },
        setWhere: eq(instagram_media.channel_account_id, values.channelAccountId),
      })
      .returning();
    return rows[0] ?? null;
  }

  /**
   * The account's stored post with this Instagram media id, or `null` — event processing reads it
   * from Instagram only when it is not stored yet (WH13).
   */
  async findByInstagramMediaId({
    organizationId,
    channelAccountId,
    instagramMediaId,
  }: ChannelAccountKey & { instagramMediaId: string }): Promise<InstagramMediaRow | null> {
    const rows = await this.db()
      .select()
      .from(instagram_media)
      .where(storedMediaWhere({ organizationId, channelAccountId, instagramMediaId }))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The account's newest stored post's Instagram media id, or `null` — a `post` message of
   * `newest` sends it (plan §18.5 "the newest post at send time", sub-domain 6's lanes).
   */
  async findNewestInstagramMediaId({
    organizationId,
    channelAccountId,
  }: ChannelAccountKey): Promise<string | null> {
    const rows = await this.db()
      .select({ instagramMediaId: instagram_media.instagram_media_id })
      .from(instagram_media)
      .where(
        and(
          eq(instagram_media.organization_id, organizationId),
          eq(instagram_media.channel_account_id, channelAccountId),
        ),
      )
      .orderBy(desc(instagram_media.published_at))
      .limit(1);
    return rows[0]?.instagramMediaId ?? null;
  }

  /**
   * The missed-comment watch's write (D40): any of `comments_checked_at`, `comments_next_check_at`
   * (`null` stops the watch) and `last_comment_at` on the account's stored post — a field left
   * `undefined` keeps its value; `last_comment_at` never moves back. Returns the row, or `null`
   * when the post is not stored for this account.
   */
  async updateCommentWatch({
    organizationId,
    channelAccountId,
    instagramMediaId,
    watch,
  }: ChannelAccountKey & {
    instagramMediaId: string;
    watch: InstagramMediaCommentWatchValues;
  }): Promise<InstagramMediaRow | null> {
    const rows = await this.db()
      .update(instagram_media)
      .set({
        ...(watch.commentsCheckedAt === undefined
          ? {}
          : { comments_checked_at: watch.commentsCheckedAt }),
        ...(watch.commentsNextCheckAt === undefined
          ? {}
          : { comments_next_check_at: watch.commentsNextCheckAt }),
        ...(watch.lastCommentAt === undefined
          ? {}
          : {
              last_comment_at: sql`GREATEST(${instagram_media.last_comment_at}, ${watch.lastCommentAt.toISOString()}::timestamptz)`,
            }),
        updated_at: mediaUpdatedAtTimestamp,
      })
      .where(storedMediaWhere({ organizationId, channelAccountId, instagramMediaId }))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Records a Live's end once (D40): `live_ended_at` set when it is empty — a later call keeps the
   * first time. Returns the row as it now stands, or `null` when the post is not stored for this
   * account.
   */
  async recordLiveEnded({
    organizationId,
    channelAccountId,
    instagramMediaId,
    endedAt,
  }: ChannelAccountKey & {
    instagramMediaId: string;
    endedAt: Date;
  }): Promise<InstagramMediaRow | null> {
    const rows = await this.db()
      .update(instagram_media)
      .set({
        live_ended_at: sql`COALESCE(${instagram_media.live_ended_at}, ${endedAt.toISOString()}::timestamptz)`,
        updated_at: mediaUpdatedAtTimestamp,
      })
      .where(storedMediaWhere({ organizationId, channelAccountId, instagramMediaId }))
      .returning();
    return rows[0] ?? null;
  }

  /** Deletes every stored post of the account (Meta's data deletion, IA20); returns how many. */
  async deleteForAccount({ organizationId, channelAccountId }: ChannelAccountKey): Promise<number> {
    const rows = await this.db()
      .delete(instagram_media)
      .where(
        and(
          eq(instagram_media.organization_id, organizationId),
          eq(instagram_media.channel_account_id, channelAccountId),
        ),
      )
      .returning({ id: instagram_media.id });
    return rows.length;
  }
}

/**
 * {@link InstagramMediaRepository} bound to a job's organization handle (a job-minted organization
 * scope, or `runOrganizationScopedWorkerJob`) — event processing stores the post a comment arrived
 * on, and "next post" linking the post it linked (IA17).
 */
export function createWorkerInstagramMediaRepository(
  databaseHandle: WorkerDatabaseHandle,
): InstagramMediaRepository {
  assertWorkerDatabaseContext(['organization']);
  return new InstagramMediaRepository(databaseHandle);
}
