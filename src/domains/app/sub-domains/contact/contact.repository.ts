import {
  and,
  arrayContains,
  eq,
  getTableColumns,
  gte,
  isNotNull,
  isNull,
  lt,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { countWithCap } from '@/infrastructure/database/utils/capped-count.util.js';
import {
  databaseNowTimestamp,
  databaseUpdatedAtTimestamp,
} from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import {
  type CursorTimestampRow,
  cursorTimestampSelection,
} from '@/shared/utils/http/pagination.util.js';
import {
  buildSearchCondition,
  finishKeysetPage,
  resolveKeysetSort,
} from '@/shared/utils/http/list-query.util.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { contactHadRunOfAutomation } from '@/domains/app/sub-domains/automation/automation-run/automation-run.schema.js';
import { contacts } from './contact.schema.js';
import type { ContactRepositoryListQuery } from './contact.types.js';

/** `updated_at` for every change of a contact — never before the row's `created_at`. */
const contactUpdatedAtTimestamp = databaseUpdatedAtTimestamp(contacts.created_at);

/**
 * The automation filter (CT5): contacts that had a run of the automation; an unknown automation
 * (`null`) matches nothing; no filter (`undefined`) adds no condition.
 */
function automationFilterCondition(automationId: number | null | undefined): SQL | undefined {
  if (automationId === undefined) return undefined;
  if (automationId === null) return sql`false`;
  return contactHadRunOfAutomation(automationId);
}

/** One `app.contacts` row as Drizzle reads it. */
export type ContactRow = typeof contacts.$inferSelect;

/** A contact list row: the contact, its Instagram account's public id and the cursor timestamp. */
export type ContactListRow = ContactRow &
  CursorTimestampRow & {
    /** `iga_…` of the contact's account (CT13). */
    instagram_account_public_id: string;
  };

/** One page of the contact list as the repository returns it. */
export interface ContactListPage {
  items: ContactListRow[];
  total: number | null;
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}

/** The two keys every single-contact statement names: its organization and its internal id. */
export interface ContactKey {
  /** `tenancy.organizations.id`. */
  organizationId: number;
  /** `app.contacts.id`. */
  contactId: number;
}

/** What one processed event writes onto its contact (`recordContactInteraction`, 2.10). */
export interface ContactInteractionValues {
  organizationId: number;
  instagramAccountId: number;
  instagramUserId: string;
  /** Set when given; an event without one never blanks the stored username. */
  username: string | null;
  occurredAt: Date;
  /** `true` on a DM, story reply or button click — they also move `last_direct_message_received_at`. */
  isDirectMessage: boolean;
}

/** The profile columns one profile read or follow check sets; `undefined` leaves a column as is. */
export interface ContactProfileValues {
  username?: string;
  full_name?: string | null;
  profile_picture_url?: string | null;
  followers_count?: number | null;
  is_following_account?: boolean;
  follow_checked_at?: Date;
}

/**
 * The list's search expression — username, full name and email in one string. It is
 * `idx_contacts_search_trgm`'s expression verbatim, so the trigram index serves `q` (CT4).
 */
const CONTACT_SEARCH_EXPRESSION = sql`(coalesce(${contacts.username}, '') || ' ' || coalesce(${contacts.full_name}, '') || ' ' || coalesce(${contacts.email}, ''))`;

/** The live-contact guard every write carries: an erased contact is never changed (CT2). */
const LIVE_CONTACT = isNull(contacts.deleted_at);

/**
 * Drizzle access to `app.contacts` (routes-final § 2.3, CTC2): the list (route 9), the erase
 * (route 10) and the writes event processing makes through the contact service.
 *
 * @remarks
 * - **Algorithm:** every statement names `organization_id`, and a single-contact statement the
 *   internal `id` too, so tenant isolation does not rest on RLS alone. Every write carries
 *   `deleted_at IS NULL` — an erased contact is never changed — and returns the changed row, or
 *   `null` when there was none. The interaction upsert keys on the unique
 *   `(organization_id, instagram_account_id, instagram_user_id)` index (CT13); `xmax = 0` tells an
 *   insert from an update.
 * - **Failure modes:** a value that breaks a `chk_contacts_*` CHECK throws Postgres 23514 — the
 *   service normalises every value first.
 * - **Side effects:** reads `app.instagram_accounts` for the account's public id and
 *   `app.automation_runs` for the automation filter (`contactHadRunOfAutomation`, CT5) — join-only
 *   uses of sub-domains 1 and 3's schemas, inside the same domain; writes `app.contacts` only.
 * - **Notes:** HTTP paths run inside the caller's `withAppDatabaseContext`; event processing binds
 *   its job's handle through {@link createWorkerContactRepository}.
 */
export class ContactRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /**
   * One page of the organization's live contacts (route 9, CT4, CT6): the filters, `q` over the
   * trigram expression, the keyset sort (the two times as timestamp keysets, `username` as a
   * nulls-last text keyset — CQ2) and, on the first page, the capped total.
   */
  async list({
    organizationId,
    query,
  }: {
    organizationId: number;
    query: ContactRepositoryListQuery;
  }): Promise<ContactListPage> {
    const where = and(
      eq(contacts.organization_id, organizationId),
      LIVE_CONTACT,
      ...this.listFilterConditions({ organizationId, query }),
    );
    const sortColumn = {
      last_message_received_at: contacts.last_message_received_at,
      first_seen_at: contacts.first_seen_at,
      username: contacts.username,
    }[query.sort];
    const { orderBy, cursorCondition, sortValueFor, filterFingerprint } =
      resolveKeysetSort<ContactListRow>({
        columns: {
          last_message_received_at: {
            column: contacts.last_message_received_at,
            kind: 'created_at',
          },
          first_seen_at: { column: contacts.first_seen_at, kind: 'created_at' },
          username: {
            column: contacts.username,
            kind: 'text',
            nulls: 'last',
            getSortValue: (row) => row.username,
          },
        },
        idColumn: contacts.id,
        defaultSort: 'last_message_received_at',
        sort: query.sort,
        order: query.order,
        q: query.q,
        filters: {
          tags: query.tags,
          has_email: query.hasEmail ?? null,
          has_phone: query.hasPhone ?? null,
          is_following_account: query.isFollowingAccount ?? null,
          first_seen_from: query.firstSeenFrom?.toISOString() ?? null,
          first_seen_to: query.firstSeenTo?.toISOString() ?? null,
          instagram_account_id: query.instagramAccountPublicId ?? null,
          automation_id: query.automationPublicId ?? null,
        },
        after: query.after,
      });
    const rows = (await this.db()
      .select({
        ...getTableColumns(contacts),
        instagram_account_public_id: instagram_accounts.public_id,
        // The time sorts keyset on their own column; the username sort on created_at (unused).
        cursor_created_at: cursorTimestampSelection(
          query.sort === 'username' ? contacts.created_at : sortColumn,
        ),
      })
      .from(contacts)
      .innerJoin(
        instagram_accounts,
        and(
          eq(instagram_accounts.organization_id, contacts.organization_id),
          eq(instagram_accounts.id, contacts.instagram_account_id),
        ),
      )
      .where(and(where, cursorCondition))
      .orderBy(...orderBy)
      .limit(query.limit + 1)) as ContactListRow[];
    const page = finishKeysetPage({
      rows,
      args: { limit: query.limit, sortValueFor, filterFingerprint },
    });
    const total =
      query.after === undefined
        ? await countWithCap({ database: this.db(), table: contacts, where })
        : null;
    return { ...page, total };
  }

  /** The list's filters (CT4, CT5, CT13) as conditions; an absent filter adds none. */
  private listFilterConditions({
    organizationId,
    query,
  }: {
    organizationId: number;
    query: ContactRepositoryListQuery;
  }): (SQL | undefined)[] {
    const presence = (column: typeof contacts.email | typeof contacts.phone, wanted?: boolean) => {
      if (wanted === undefined) return undefined;
      return wanted ? isNotNull(column) : isNull(column);
    };
    return [
      query.tags.length === 0 ? undefined : arrayContains(contacts.tags, [...query.tags]),
      presence(contacts.email, query.hasEmail),
      presence(contacts.phone, query.hasPhone),
      // Never checked (null) matches neither value.
      query.isFollowingAccount === undefined
        ? undefined
        : eq(contacts.is_following_account, query.isFollowingAccount),
      query.firstSeenFrom === undefined
        ? undefined
        : gte(contacts.first_seen_at, query.firstSeenFrom),
      query.firstSeenTo === undefined ? undefined : lt(contacts.first_seen_at, query.firstSeenTo),
      // An unknown account id resolves to NULL, so the page is empty (CT13).
      query.instagramAccountPublicId === undefined
        ? undefined
        : eq(
            contacts.instagram_account_id,
            sql`(SELECT ${instagram_accounts.id} FROM ${instagram_accounts}
              WHERE ${instagram_accounts.organization_id} = ${organizationId}
                AND ${instagram_accounts.public_id} = ${query.instagramAccountPublicId})`,
          ),
      automationFilterCondition(query.automationId),
      buildSearchCondition({ columns: [CONTACT_SEARCH_EXPRESSION], q: query.q, everyWord: true }),
    ];
  }

  /**
   * The organization's live contact with this public id, locked for the erase (route 10, CT8) —
   * `FOR UPDATE`, so a racing write waits and then finds it erased. `null` when absent, another
   * organization's or already erased.
   */
  async lockLiveByPublicId({
    organizationId,
    contactPublicId,
  }: {
    organizationId: number;
    contactPublicId: string;
  }): Promise<ContactRow | null> {
    const rows = await this.db()
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.organization_id, organizationId),
          eq(contacts.public_id, contactPublicId),
          LIVE_CONTACT,
        ),
      )
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /**
   * Erases the contact in place (route 10, D22, CT7): `deleted_at` set and every personal column
   * cleared — Instagram user id, username, full name, picture, followers, the follow status, email
   * and phone with their times, tags. Returns the erased row, or `null` when it was already erased.
   */
  async erase({ organizationId, contactId }: ContactKey): Promise<ContactRow | null> {
    const rows = await this.db()
      .update(contacts)
      .set({
        instagram_user_id: null,
        username: null,
        full_name: null,
        profile_picture_url: null,
        followers_count: null,
        is_following_account: null,
        follow_checked_at: null,
        email: null,
        email_collected_at: null,
        phone: null,
        phone_collected_at: null,
        tags: [],
        deleted_at: databaseNowTimestamp,
        updated_at: contactUpdatedAtTimestamp,
      })
      .where(
        and(eq(contacts.organization_id, organizationId), eq(contacts.id, contactId), LIVE_CONTACT),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** The organization's live contact with this internal id, or `null` once erased (`findLiveContact`). */
  async findLiveById({ organizationId, contactId }: ContactKey): Promise<ContactRow | null> {
    const rows = await this.db()
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.organization_id, organizationId), eq(contacts.id, contactId), LIVE_CONTACT),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The organization's live contact with this internal id, locked `FOR KEY SHARE` until the unit
   * ends (`lockLiveContact`): the erase's `FOR UPDATE` ({@link lockLiveByPublicId}) waits for it and
   * then clears what the unit wrote; a unit that meets an erase waits and gets `null`. Two units of
   * one contact never block each other.
   */
  async lockLiveById({ organizationId, contactId }: ContactKey): Promise<ContactRow | null> {
    const rows = await this.db()
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.organization_id, organizationId), eq(contacts.id, contactId), LIVE_CONTACT),
      )
      .limit(1)
      .for('key share');
    return rows[0] ?? null;
  }

  /**
   * Creates the contact of one processed event, or touches the live one (`recordContactInteraction`,
   * CT13): a new contact gets `first_seen_at` = `last_message_received_at` = the event's time; an
   * existing one keeps its username unless the event carries one, and its message times move
   * forward only (`greatest`). A DM, story reply or button click also moves
   * `last_direct_message_received_at`. An erased row holds a `NULL` Instagram user id, so it never
   * matches — the same person's next event creates a fresh contact (CT9).
   */
  async upsertInteraction(
    values: ContactInteractionValues,
  ): Promise<{ contact: ContactRow; isInserted: boolean }> {
    const directMessageAt = values.isDirectMessage ? values.occurredAt : null;
    const rows = await runInsertWithPublicIdentifierRetry({
      insert: () =>
        this.db()
          .insert(contacts)
          .values({
            public_id: generatePublicId('contact'),
            organization_id: values.organizationId,
            instagram_account_id: values.instagramAccountId,
            instagram_user_id: values.instagramUserId,
            username: values.username,
            first_seen_at: values.occurredAt,
            last_message_received_at: values.occurredAt,
            last_direct_message_received_at: directMessageAt,
          })
          .onConflictDoUpdate({
            target: [
              contacts.organization_id,
              contacts.instagram_account_id,
              contacts.instagram_user_id,
            ],
            set: {
              username: sql`coalesce(excluded.username, ${contacts.username})`,
              // greatest() skips a NULL, so a comment (no DM time) keeps the stored one.
              last_message_received_at: sql`greatest(${contacts.last_message_received_at}, excluded.last_message_received_at)`,
              last_direct_message_received_at: sql`greatest(${contacts.last_direct_message_received_at}, excluded.last_direct_message_received_at)`,
              updated_at: contactUpdatedAtTimestamp,
            },
          })
          .returning({
            ...getTableColumns(contacts),
            // A row the statement inserted has no deleting transaction yet.
            is_inserted: sql<boolean>`(xmax = 0)`,
          }),
    });
    const row = rows[0];
    if (row === undefined) {
      throw new Error('contact upsert returned no row');
    }
    const { is_inserted: isInserted, ...contact } = row;
    return { contact, isInserted };
  }

  /** Sets the given profile columns on a live contact (`recordContactProfile`); `null` once erased. */
  async updateProfile({
    organizationId,
    contactId,
    values,
  }: ContactKey & { values: ContactProfileValues }): Promise<ContactRow | null> {
    return this.updateLive({ organizationId, contactId, values });
  }

  /** Saves a collected email and its time on a live contact (`recordContactEmail`); `null` once erased. */
  async recordEmail({
    organizationId,
    contactId,
    email,
    collectedAt,
  }: ContactKey & { email: string; collectedAt: Date }): Promise<ContactRow | null> {
    return this.updateLive({
      organizationId,
      contactId,
      values: { email, email_collected_at: collectedAt },
    });
  }

  /** Saves a collected phone and its time on a live contact (`recordContactPhone`); `null` once erased. */
  async recordPhone({
    organizationId,
    contactId,
    phone,
    collectedAt,
  }: ContactKey & { phone: string; collectedAt: Date }): Promise<ContactRow | null> {
    return this.updateLive({
      organizationId,
      contactId,
      values: { phone, phone_collected_at: collectedAt },
    });
  }

  /** Replaces a live contact's tags (`addContactTags` — the service merged them); `null` once erased. */
  async replaceTags({
    organizationId,
    contactId,
    tags,
  }: ContactKey & { tags: readonly string[] }): Promise<ContactRow | null> {
    return this.updateLive({ organizationId, contactId, values: { tags: [...tags] } });
  }

  /**
   * Moves `last_message_sent_at` forward to `sentAt` (`recordContactMessageSent`, `greatest`);
   * `null` once erased.
   */
  async recordMessageSent({
    organizationId,
    contactId,
    sentAt,
  }: ContactKey & { sentAt: Date }): Promise<ContactRow | null> {
    return this.updateLive({
      organizationId,
      contactId,
      values: {
        last_message_sent_at: sql`greatest(${contacts.last_message_sent_at}, ${sentAt.toISOString()}::timestamptz)`,
      },
    });
  }

  /** One guarded update of a live contact, stamping `updated_at`; `null` when it is erased or absent. */
  private async updateLive({
    organizationId,
    contactId,
    values,
  }: ContactKey & { values: PgUpdateSetSource<typeof contacts> }): Promise<ContactRow | null> {
    const rows = await this.db()
      .update(contacts)
      .set({ ...values, updated_at: contactUpdatedAtTimestamp })
      .where(
        and(eq(contacts.organization_id, organizationId), eq(contacts.id, contactId), LIVE_CONTACT),
      )
      .returning();
    return rows[0] ?? null;
  }
}

/**
 * {@link ContactRepository} bound to a job's organization handle (`runOrganizationScopedWorkerJob`)
 * — event processing (sub-domain 4) and the run engine (sub-domain 3) through the contact
 * service's operations (CT2).
 */
export function createWorkerContactRepository(
  databaseHandle: WorkerDatabaseHandle,
): ContactRepository {
  assertWorkerDatabaseContext(['organization']);
  return new ContactRepository(databaseHandle);
}
