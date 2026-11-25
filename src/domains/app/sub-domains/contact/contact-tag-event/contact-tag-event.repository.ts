import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import type { ContactTagChangeEvent } from '@/domains/app/sub-domains/contact/contact.types.js';
import { contact_tag_events } from './contact-tag-event.schema.js';
import type { ContactTagEventHandOverTarget } from './contact-tag-event.types.js';

/** One undone tag event as tag intake reads it (WH15): the row's fields and two public ids. */
export interface ContactTagEventIntakeRow {
  id: number;
  contact_id: number;
  /** `con_…` of her contact. */
  contact_public_id: string;
  channel_account_id: number;
  /** `cha_…` — the run engine's account. */
  channel_account_public_id: string;
  tag: string;
  kind: string;
  source_automation_id: number | null;
  chain_number: number;
  created_at: Date;
}

/** One contact the pick-up hands to intake (WC-27): her organization's and her public ids. */
export interface ContactTagEventPickupRow {
  organization_id: number;
  organization_public_id: string;
  contact_id: number;
  contact_public_id: string;
}

/** The rows of a raw `execute` — postgres-js answers an array, node-postgres `{ rows }`. */
function rowsOf<Row>(result: unknown): Row[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Row[];
}

/**
 * Which undone events the pick-up hands over (WC-27): not handed over a minute after they were
 * written, or handed over an hour ago and still undone while under a day old.
 */
function pickupCondition(now: Date) {
  const at = now.toISOString();
  return sql`e.done_at IS NULL
    AND e.created_at < ${at}::timestamptz - interval '1 minute'
    AND (e.queued_at IS NULL
      OR (e.queued_at < ${at}::timestamptz - interval '1 hour'
        AND e.created_at > ${at}::timestamptz - interval '24 hours'))`;
}

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

  /**
   * The pick-up's read across organizations (WC-27, `idx_contact_tag_events_pickup`, the retention
   * arm): up to `limit` live contacts after `afterContactId` holding events to hand over, by id.
   */
  async listPickupContacts({
    now,
    afterContactId,
    limit,
  }: {
    now: Date;
    afterContactId: number;
    limit: number;
  }): Promise<ContactTagEventPickupRow[]> {
    return rowsOf<ContactTagEventPickupRow>(
      await this.db().execute(sql`
        SELECT e.organization_id, o.public_id AS organization_public_id, e.contact_id,
          c.public_id AS contact_public_id
        FROM app.contact_tag_events e
        JOIN app.contacts c ON c.organization_id = e.organization_id AND c.id = e.contact_id
        JOIN tenancy.organizations o ON o.id = e.organization_id
        WHERE ${pickupCondition(now)} AND c.deleted_at IS NULL AND o.deleted_at IS NULL
          AND e.contact_id > ${afterContactId}
        GROUP BY e.organization_id, o.public_id, e.contact_id, c.public_id
        ORDER BY e.contact_id
        LIMIT ${limit}`),
    );
  }

  /**
   * Stamps `queued_at` now on the contacts' events the pick-up hands over (WC-27), in the
   * organization's own scope; answers how many rows.
   */
  async markPickedUp({
    organizationId,
    contactIds,
    now,
  }: {
    organizationId: number;
    contactIds: readonly number[];
    now: Date;
  }): Promise<number> {
    if (contactIds.length === 0) return 0;
    const rows = rowsOf<{ id: number }>(
      await this.db().execute(sql`
        UPDATE app.contact_tag_events e SET queued_at = now()
        WHERE e.organization_id = ${organizationId}
          AND e.contact_id IN (${sql.join(
            contactIds.map((id) => sql`${id}`),
            sql`, `,
          )})
          AND ${pickupCondition(now)}
        RETURNING e.id`),
    );
    return rows.length;
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

  /**
   * The undone tag events of the named live contacts (`done_at` empty), oldest first, at most
   * `limit` — tag intake's read (WH15, WC-4), with each row's contact and account public ids.
   */
  async listUndoneForContacts({
    organizationId,
    contactPublicIds,
    limit,
  }: {
    organizationId: number;
    contactPublicIds: readonly string[];
    limit: number;
  }): Promise<ContactTagEventIntakeRow[]> {
    if (contactPublicIds.length === 0) return [];
    return this.db()
      .select({
        id: contact_tag_events.id,
        contact_id: contact_tag_events.contact_id,
        contact_public_id: contacts.public_id,
        channel_account_id: contact_tag_events.channel_account_id,
        channel_account_public_id: channel_accounts.public_id,
        tag: contact_tag_events.tag,
        kind: contact_tag_events.kind,
        source_automation_id: contact_tag_events.source_automation_id,
        chain_number: contact_tag_events.chain_number,
        created_at: contact_tag_events.created_at,
      })
      .from(contact_tag_events)
      .innerJoin(
        contacts,
        and(
          eq(contacts.organization_id, contact_tag_events.organization_id),
          eq(contacts.id, contact_tag_events.contact_id),
        ),
      )
      .innerJoin(
        channel_accounts,
        and(
          eq(channel_accounts.organization_id, contact_tag_events.organization_id),
          eq(channel_accounts.id, contact_tag_events.channel_account_id),
        ),
      )
      .where(
        and(
          eq(contact_tag_events.organization_id, organizationId),
          inArray(contacts.public_id, [...contactPublicIds]),
          isNull(contacts.deleted_at),
          isNull(contact_tag_events.done_at),
        ),
      )
      .orderBy(asc(contact_tag_events.created_at), asc(contact_tag_events.id))
      .limit(limit);
  }

  /**
   * Marks one tag event done while it is not (WH15 — tag intake's first statement); `false` when
   * another run did it already.
   */
  async markDone({
    organizationId,
    tagEventId,
  }: {
    organizationId: number;
    tagEventId: number;
  }): Promise<boolean> {
    const rows = await this.db()
      .update(contact_tag_events)
      .set({ done_at: sql`now()` })
      .where(
        and(
          eq(contact_tag_events.organization_id, organizationId),
          eq(contact_tag_events.id, tagEventId),
          isNull(contact_tag_events.done_at),
        ),
      )
      .returning({ id: contact_tag_events.id });
    return rows.length > 0;
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
}

/**
 * {@link ContactTagEventRepository} bound to a retention handle (`runGlobalRetentionWorkerJob`) —
 * the pick-up's read across organizations (WC-27).
 */
export function createRetentionContactTagEventRepository(
  databaseHandle: WorkerDatabaseHandle,
): ContactTagEventRepository {
  assertWorkerDatabaseContext(['global_retention_cleanup']);
  return new ContactTagEventRepository(databaseHandle);
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
