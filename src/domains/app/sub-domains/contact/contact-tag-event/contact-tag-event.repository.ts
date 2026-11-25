import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import {
  type BatchDeleteResult,
  deleteInBatchesByCondition,
  readOldestOverdueSeconds,
} from '@/infrastructure/database/utils/batch-delete.util.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import type { ContactTagChangeEvent } from '@/domains/app/sub-domains/contact/contact.types.js';
import { contact_tag_events } from './contact-tag-event.schema.js';
import type { ContactTagEventHandOverTarget } from './contact-tag-event.types.js';

/** One `app.contact_tag_events` row as Drizzle reads it. */
export type ContactTagEventRow = typeof contact_tag_events.$inferSelect;

/**
 * Drizzle access to `app.contact_tag_events` (routes-final § 3.B.3, CT16): inserted in the tag
 * change's unit of work, deleted by the contact's erase.
 *
 * @remarks
 * - **Algorithm:** every statement names `organization_id`; inserts are one multi-row statement.
 * - **Failure modes:** a contact or account of another organization breaks the composite key
 *   (23503); a tag outside 1–50 trimmed characters, or with a comma, breaks
 *   `chk_contact_tag_events_tag` (23514) — the callers normalise tags first.
 * - **Side effects:** writes `app.contact_tag_events` only.
 * - **Notes:** the tag step binds a job handle ({@link createWorkerContactTagEventRepository}); the
 *   pick-up (R47), intake (R38) and the clean-up (R50) add their own reads and writes.
 */
export class ContactTagEventRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /**
   * Appends one row per tag change; `isQueued` stamps `queued_at` with the commit's time (the
   * hand-over runs right after it). Nothing to append is a no-op.
   */
  async insertMany({
    events,
    isQueued,
  }: {
    events: readonly ContactTagChangeEvent[];
    isQueued: boolean;
  }): Promise<Pick<ContactTagEventRow, 'id' | 'organization_id' | 'contact_id'>[]> {
    if (events.length === 0) return [];
    return this.db()
      .insert(contact_tag_events)
      .values(
        events.map((event) => ({
          organization_id: event.organizationId,
          channel_account_id: event.channelAccountId,
          contact_id: event.contactId,
          tag: event.tag,
          kind: event.kind,
          source: event.source,
          source_automation_id: event.sourceAutomationId,
          chain_number: event.chainNumber,
          queued_at: isQueued ? sql`now()` : null,
        })),
      )
      .returning({
        id: contact_tag_events.id,
        organization_id: contact_tag_events.organization_id,
        contact_id: contact_tag_events.contact_id,
      });
  }

  /**
   * The organization's public id and the public ids of the live contacts among `contactIds` — what
   * the hand-over names (public ids only, K8); `null` when none is live.
   */
  async findHandOverTarget({
    organizationId,
    contactIds,
  }: {
    organizationId: number;
    contactIds: readonly number[];
  }): Promise<ContactTagEventHandOverTarget | null> {
    if (contactIds.length === 0) return null;
    const rows = await this.db()
      .select({
        organization_public_id: organizations.public_id,
        contact_public_id: contacts.public_id,
      })
      .from(contacts)
      .innerJoin(organizations, eq(organizations.id, contacts.organization_id))
      .where(
        and(
          eq(contacts.organization_id, organizationId),
          inArray(contacts.id, [...contactIds]),
          isNull(contacts.deleted_at),
        ),
      )
      .orderBy(asc(contacts.id));
    const [first] = rows;
    if (first === undefined) return null;
    return {
      organizationPublicId: first.organization_public_id,
      contactPublicIds: rows.map((row) => row.contact_public_id),
    };
  }

  /** Deletes every tag event of one contact (her erase, CT11); answers how many went. */
  async deleteForContact({
    organizationId,
    contactId,
  }: {
    organizationId: number;
    contactId: number;
  }): Promise<number> {
    const deleted = await this.db()
      .delete(contact_tag_events)
      .where(
        and(
          eq(contact_tag_events.organization_id, organizationId),
          eq(contact_tag_events.contact_id, contactId),
        ),
      )
      .returning({ id: contact_tag_events.id });
    return deleted.length;
  }

  /** One contact's tag events, oldest first (tests and intake's pass). */
  async listForContact({
    organizationId,
    contactId,
  }: {
    organizationId: number;
    contactId: number;
  }): Promise<ContactTagEventRow[]> {
    return this.db()
      .select()
      .from(contact_tag_events)
      .where(
        and(
          eq(contact_tag_events.organization_id, organizationId),
          eq(contact_tag_events.contact_id, contactId),
        ),
      )
      .orderBy(asc(contact_tag_events.created_at), asc(contact_tag_events.id));
  }

  /**
   * The tag events' clean-up (WC-54): deletes events made before `cutoff`, done or not (a pick-up
   * looks back 24 hours only), at most `maxBatches` batches in this unit of work
   * (`idx_contact_tag_events_created`). Needs the retention context
   * ({@link createRetentionContactTagEventRepository}).
   */
  async deleteCreatedBefore({
    cutoff,
    maxBatches,
  }: {
    cutoff: Date;
    maxBatches: number;
  }): Promise<BatchDeleteResult> {
    return deleteInBatchesByCondition({
      databaseHandle: this.db(),
      table: contact_tag_events,
      idColumn: contact_tag_events.id,
      whereCondition: sql`${contact_tag_events.created_at} < ${cutoff.toISOString()}::timestamptz`,
      maxBatches,
      logContext: 'contact-tag-event-retention',
      tableLabel: 'app.contact_tag_events',
    });
  }

  /** Seconds the oldest event made before `cutoff` is past it — the clean-up's gauge (P92). */
  async readCreatedOverdueSeconds(cutoff: Date): Promise<number> {
    return readOldestOverdueSeconds({
      databaseHandle: this.db(),
      table: contact_tag_events,
      column: contact_tag_events.created_at,
      cutoff,
      whereCondition: sql`${contact_tag_events.created_at} < ${cutoff.toISOString()}::timestamptz`,
    });
  }
}

/**
 * {@link ContactTagEventRepository} bound to a job's organization handle
 * (`runOrganizationScopedWorkerJob`) — the tag step's commit and the bulk job's pieces.
 */
export function createWorkerContactTagEventRepository(
  databaseHandle: WorkerDatabaseHandle,
): ContactTagEventRepository {
  assertWorkerDatabaseContext(['organization']);
  return new ContactTagEventRepository(databaseHandle);
}

/**
 * {@link ContactTagEventRepository} bound to a retention handle (`runGlobalRetentionWorkerJob`) — the tag events' 8-day clean-up (WC-54), which only
 * deletes (the policy's sweep arm is in `USING`).
 */
export function createRetentionContactTagEventRepository(
  databaseHandle: WorkerDatabaseHandle,
): ContactTagEventRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new ContactTagEventRepository(databaseHandle);
}
