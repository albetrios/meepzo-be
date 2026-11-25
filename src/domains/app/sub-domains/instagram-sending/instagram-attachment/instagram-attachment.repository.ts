import { and, eq } from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { ChannelAccountKey } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import { instagram_attachments } from './instagram-attachment.schema.js';

/** One `app.instagram_attachments` row as Drizzle reads it. */
export type InstagramAttachmentRow = typeof instagram_attachments.$inferSelect;

/** One account's file: the channel account's key and the upload's public id. */
export interface InstagramAttachmentKey extends ChannelAccountKey {
  /** `upl_…` — the upload's public id (P25). */
  uploadPublicId: string;
}

/**
 * Drizzle access to `app.instagram_attachments` (feat-instagram-dm-sending routes-final § 6.C.3,
 * SN20): the look-up of an account's file, the first write of Meta's id, the delete on "gone".
 *
 * @remarks
 * - **Algorithm:** every statement names `organization_id`, `channel_account_id` and
 *   `upload_public_id` — the unique key. The write is `ON CONFLICT DO NOTHING`, then the row that
 *   holds the key is read back, so two senders of the same file keep one Meta id.
 * - **Failure modes:** none of its own; the CHECKs refuse a malformed upload public id (23514).
 * - **Side effects:** writes `app.instagram_attachments` only.
 * - **Notes:** the deleted-automation purge of unused file links is WC-47's (automation's).
 */
export class InstagramAttachmentRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  private keyOf({ organizationId, channelAccountId, uploadPublicId }: InstagramAttachmentKey) {
    return and(
      eq(instagram_attachments.organization_id, organizationId),
      eq(instagram_attachments.channel_account_id, channelAccountId),
      eq(instagram_attachments.upload_public_id, uploadPublicId),
    );
  }

  /** The account's row for the file, or `null` when it was never uploaded (or was forgotten). */
  async findByKey(key: InstagramAttachmentKey): Promise<InstagramAttachmentRow | null> {
    const [row] = await this.db()
      .select()
      .from(instagram_attachments)
      .where(this.keyOf(key))
      .limit(1);
    return row ?? null;
  }

  /**
   * Keeps Meta's id for the file unless the account already has one — then the kept row wins and
   * is returned (one id per account and file).
   */
  async insertIfMissing({
    attachmentId,
    ...key
  }: InstagramAttachmentKey & { attachmentId: string }): Promise<InstagramAttachmentRow> {
    const [inserted] = await this.db()
      .insert(instagram_attachments)
      .values({
        organization_id: key.organizationId,
        channel_account_id: key.channelAccountId,
        upload_public_id: key.uploadPublicId,
        attachment_id: attachmentId,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted !== undefined) return inserted;
    const kept = await this.findByKey(key);
    if (kept === null)
      throw new Error('instagram attachment: the kept row vanished after a conflict');
    return kept;
  }

  /** Forgets the account's file (Meta said it is gone). Answers whether a row was deleted. */
  async deleteByKey(key: InstagramAttachmentKey): Promise<boolean> {
    const deleted = await this.db()
      .delete(instagram_attachments)
      .where(this.keyOf(key))
      .returning({ id: instagram_attachments.id });
    return deleted.length > 0;
  }
}
