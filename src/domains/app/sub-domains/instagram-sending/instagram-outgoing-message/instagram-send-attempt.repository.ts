import { and, desc, eq, gte, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { InstagramSendLane } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import type { InstagramSendAttemptCountGroup } from './instagram-outgoing-message.constants.js';
import { instagram_send_attempts } from './instagram-send-attempt.schema.js';

/** One `app.instagram_send_attempts` row as Drizzle reads it. */
export type InstagramSendAttemptRow = typeof instagram_send_attempts.$inferSelect;

/** An attempt's key: its id and its split key. */
export interface InstagramSendAttemptKey {
  organizationId: number;
  id: number;
  startedAt: Date;
}

/**
 * Drizzle access to `app.instagram_send_attempts` (feat-instagram-dm-sending routes-final § 6.B.3,
 * SN19): one insert in the claim's commit, one update by the result save.
 *
 * @remarks
 * - **Algorithm:** insert, then finish the open attempt once (`result_group IS NULL` guards a
 *   repeat); every query names `organization_id` and the split key.
 * - **Failure modes:** the CHECKs refuse an unknown lane or count group (23514).
 * - **Side effects:** writes `app.instagram_send_attempts` only.
 */
export class InstagramSendAttemptRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** Starts one call's row now (the claim's commit); answers its key. */
  async start({
    organizationId,
    channelAccountId,
    messageId,
    automationId,
    contactId,
    lane,
    countGroup,
  }: {
    organizationId: number;
    channelAccountId: number;
    /** `app.instagram_outgoing_messages.id`. */
    messageId: number;
    automationId: number | null;
    contactId: number;
    lane: InstagramSendLane;
    countGroup: InstagramSendAttemptCountGroup;
  }): Promise<InstagramSendAttemptKey> {
    const [row] = await this.db()
      .insert(instagram_send_attempts)
      .values({
        organization_id: organizationId,
        channel_account_id: channelAccountId,
        instagram_message_id: messageId,
        automation_id: automationId,
        contact_id: contactId,
        lane,
        count_group: countGroup,
        started_at: sql`date_trunc('milliseconds', now())`,
      })
      .returning({
        id: instagram_send_attempts.id,
        started_at: instagram_send_attempts.started_at,
      });
    return { organizationId, id: row!.id, startedAt: row!.started_at };
  }

  /** Finishes an open attempt with Meta's answer (the result save); answers whether it changed. */
  async finish({
    key,
    resultGroup,
    httpStatus,
    errorCode,
    errorSubcode,
    durationMilliseconds,
  }: {
    key: InstagramSendAttemptKey;
    resultGroup: string;
    httpStatus: number | null;
    errorCode: number | null;
    errorSubcode: number | null;
    durationMilliseconds: number | null;
  }): Promise<boolean> {
    const finished = await this.db()
      .update(instagram_send_attempts)
      .set({
        result_group: resultGroup,
        http_status: httpStatus,
        error_code: errorCode,
        error_subcode: errorSubcode,
        duration_milliseconds: durationMilliseconds,
      })
      .where(
        and(
          eq(instagram_send_attempts.organization_id, key.organizationId),
          eq(instagram_send_attempts.id, key.id),
          eq(instagram_send_attempts.started_at, key.startedAt),
          isNull(instagram_send_attempts.result_group),
        ),
      )
      .returning({ id: instagram_send_attempts.id });
    return finished.length > 0;
  }

  /**
   * The account's last finished attempts, newest first ("in a row" — plan §33.2 rule 6, §33.5):
   * result group, contact and count group only.
   */
  async listLastResults({
    organizationId,
    channelAccountId,
    limit,
  }: {
    organizationId: number;
    channelAccountId: number;
    limit: number;
  }): Promise<{ resultGroup: string; contactId: number; countGroup: string }[]> {
    const rows = await this.db()
      .select({
        resultGroup: instagram_send_attempts.result_group,
        contactId: instagram_send_attempts.contact_id,
        countGroup: instagram_send_attempts.count_group,
      })
      .from(instagram_send_attempts)
      .where(
        and(
          eq(instagram_send_attempts.organization_id, organizationId),
          eq(instagram_send_attempts.channel_account_id, channelAccountId),
          isNotNull(instagram_send_attempts.result_group),
        ),
      )
      .orderBy(desc(instagram_send_attempts.started_at), desc(instagram_send_attempts.id))
      .limit(limit);
    return rows.map((row) => ({
      resultGroup: row.resultGroup ?? '',
      contactId: row.contactId,
      countGroup: row.countGroup,
    }));
  }
  /**
   * The result groups of one automation's last finished sends of a text, newest first — the "5 in a
   * row" of a refused text (plan §33.1, §33.2 rule 6; `idx_instagram_send_attempts_automation`):
   * follow checks and hides (count group `none`) carry no text and are left out.
   */
  async listLastAutomationResultGroups({
    organizationId,
    automationId,
    limit,
  }: {
    organizationId: number;
    automationId: number;
    limit: number;
  }): Promise<string[]> {
    const rows = await this.db()
      .select({ resultGroup: instagram_send_attempts.result_group })
      .from(instagram_send_attempts)
      .where(
        and(
          eq(instagram_send_attempts.organization_id, organizationId),
          eq(instagram_send_attempts.automation_id, automationId),
          isNotNull(instagram_send_attempts.result_group),
          ne(instagram_send_attempts.count_group, 'none'),
        ),
      )
      .orderBy(desc(instagram_send_attempts.started_at), desc(instagram_send_attempts.id))
      .limit(limit);
    return rows.map((row) => row.resultGroup ?? '');
  }

  /**
   * The account's finished attempts since a time (the account test's turns, plan §33.4: every
   * attempt after a stop's end is one of its tests while the stop holds).
   */
  async countFinishedSince({
    organizationId,
    channelAccountId,
    since,
  }: {
    organizationId: number;
    channelAccountId: number;
    since: Date;
  }): Promise<number> {
    const [row] = await this.db()
      .select({ count: sql<number>`count(*)::int` })
      .from(instagram_send_attempts)
      .where(
        and(
          eq(instagram_send_attempts.organization_id, organizationId),
          eq(instagram_send_attempts.channel_account_id, channelAccountId),
          gte(instagram_send_attempts.started_at, since),
          isNotNull(instagram_send_attempts.result_group),
        ),
      );
    return Number(row?.count ?? 0);
  }
}
