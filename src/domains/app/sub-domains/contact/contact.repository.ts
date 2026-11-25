import {
  and,
  arrayContains,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
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
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import {
  automation_runs,
  contactHadRunOfAutomation,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run.schema.js';
import { CONTACT_SEARCH_STATEMENT_TIMEOUT_MS } from './contact.constants.js';
import { contacts } from './contact.schema.js';
import { contact_activities } from './contact-activity.schema.js';
import { contact_tag_counts } from './contact-tag-count.schema.js';
import type { ContactBulkActionFilter, ContactRepositoryListQuery } from './contact.types.js';

/** `updated_at` for every change of a contact — never before the row's `created_at`. */
const contactUpdatedAtTimestamp = databaseUpdatedAtTimestamp(contacts.created_at);

/** The contact's activity row (1:1, S5): every read of a live contact joins it. */
const CONTACT_ACTIVITY_JOIN = and(
  eq(contact_activities.organization_id, contacts.organization_id),
  eq(contact_activities.contact_id, contacts.id),
);

/** The activity columns a {@link ContactRow} carries beside the contact's own. */
const CONTACT_ACTIVITY_COLUMNS = {
  last_message_received_at: contact_activities.last_message_received_at,
  last_direct_message_received_at: contact_activities.last_direct_message_received_at,
  last_message_sent_at: contact_activities.last_message_sent_at,
  last_opening_message_at: contact_activities.last_opening_message_at,
  first_message_at: contact_activities.first_message_at,
  last_comment_at: contact_activities.last_comment_at,
  comment_count: contact_activities.comment_count,
  last_story_activity_at: contact_activities.last_story_activity_at,
  last_broadcast_at: contact_activities.last_broadcast_at,
};

/** A live contact's columns: its own and its activity row's (S5). */
const CONTACT_ROW_COLUMNS = { ...getTableColumns(contacts), ...CONTACT_ACTIVITY_COLUMNS };

/** Her first run's automation, read with the contact (a deleted one too — its row stays until purged). */
const FIRST_AUTOMATION_JOIN = and(
  eq(automations.organization_id, contacts.organization_id),
  eq(automations.id, contacts.first_automation_id),
);

/** The contact's account (for its public id). */
const CONTACT_CHANNEL_ACCOUNT_JOIN = and(
  eq(channel_accounts.organization_id, contacts.organization_id),
  eq(channel_accounts.id, contacts.channel_account_id),
);

/** One `app.contacts` row alone, as Drizzle reads it. */
export type ContactRecord = typeof contacts.$inferSelect;

/** One `app.contact_activities` row, as Drizzle reads it. */
export type ContactActivityRecord = typeof contact_activities.$inferSelect;

/** A live contact as every read returns it: the contact row and its activity row's times (S5). */
export type ContactRow = ContactRecord &
  Omit<ContactActivityRecord, 'id' | 'contact_id' | 'organization_id' | 'channel_account_id'>;

/** A contact as the routes show it: the row, its account's and first automation's public ids. */
export type ContactViewRow = ContactRow & {
  /** `cha_…` of the contact's account. */
  channel_account_public_id: string;
  /** `aut_…` of her first run's automation, or `null`. */
  first_automation_public_id: string | null;
};

/** A contact list row: the view row and the cursor timestamp. */
export type ContactListRow = ContactViewRow & CursorTimestampRow;

/** The detail's extra reads (CT13). */
export type ContactDetailRow = ContactViewRow & {
  first_automation_name: string | null;
  open_run_count: number;
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
  channelAccountId: number;
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

/** One tag count change: `delta` contacts more (positive) or fewer (negative) hold `tag`. */
export interface ContactTagCountDelta {
  tag: string;
  delta: number;
}

/**
 * The list's search expression — username, full name, email and phone in one string. It is
 * `idx_contacts_search_trgm`'s expression verbatim (led by the account, S6), so the trigram index
 * serves `q` (CT12).
 */
const CONTACT_SEARCH_EXPRESSION = sql`(coalesce(${contacts.username}, '') || ' ' || coalesce(${contacts.full_name}, '') || ' ' || coalesce(${contacts.email}, '') || ' ' || coalesce(${contacts.phone}, ''))`;

/** The live-contact guard every write carries: an erased contact is never changed (CT2). */
const LIVE_CONTACT = isNull(contacts.deleted_at);

/** An internal-id filter: `undefined` adds nothing; `null` (unknown public id) matches nothing. */
function internalIdFilter(
  value: number | null | undefined,
  condition: (id: number) => SQL | undefined,
): SQL | undefined {
  if (value === undefined) return undefined;
  if (value === null) return sql`false`;
  return condition(value);
}

/** A yes/no filter on a nullable time: `true` = set, `false` = empty, `undefined` = no filter. */
function presenceFilter(column: AnyNullableColumn, wanted: boolean | undefined): SQL | undefined {
  if (wanted === undefined) return undefined;
  return wanted ? isNotNull(column) : isNull(column);
}

/** The nullable contact columns {@link presenceFilter} reads. */
type AnyNullableColumn =
  | typeof contacts.email
  | typeof contacts.phone
  | typeof contacts.opted_out_at
  | typeof contacts.automations_off_at;

/**
 * Drizzle access to `app.contacts`, its 1:1 `app.contact_activities` and the per-account
 * `app.contact_tag_counts` (routes-final § 3, 3.A.3; scale review S5–S7): the list (route 18), the
 * detail (19), the owner's changes (20), the bulk selection count (21), the tag list (22), the erase
 * (23) and the writes event processing and the run engine make through the contact service.
 *
 * @remarks
 * - **Algorithm:** every statement names `organization_id`, and a single-contact statement the
 *   internal `id` too, so tenant isolation does not rest on RLS alone. Every read of a live contact
 *   inner-joins its activity row (deleted by the erase, so the join reads live contacts only); every
 *   contact write carries `deleted_at IS NULL` and returns the changed row, or `null` when there was
 *   none. The interaction upsert keys on the unique `(organization_id, channel_account_id,
 *   instagram_user_id)` index (CT18); `xmax = 0` tells an insert from an update; the contact row is
 *   rewritten only when the username changes — the times go to the activity row (S5).
 * - **Failure modes:** a value that breaks a CHECK throws Postgres 23514 — the service normalises
 *   every value first. A search page over {@link CONTACT_SEARCH_STATEMENT_TIMEOUT_MS} is cancelled
 *   (57014, S6).
 * - **Side effects:** reads `app.channel_accounts` (the account's public id), `app.automations` (her
 *   first automation) and `app.automation_runs` (the automation filter, the open-run count) —
 *   join-only uses inside the app domain; writes the three contact tables only.
 * - **Notes:** HTTP paths run inside the caller's `withAppDatabaseContext`; event processing binds
 *   its job's handle through {@link createWorkerContactRepository}.
 */
export class ContactRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /**
   * The organization's channel account with this public id (any status — a revoked account's
   * contacts stay), or `null`: routes 18, 21 and 22 name it (CT2).
   */
  async findChannelAccountId({
    organizationId,
    channelAccountPublicId,
  }: {
    organizationId: number;
    channelAccountPublicId: string;
  }): Promise<number | null> {
    const rows = await this.db()
      .select({ id: channel_accounts.id })
      .from(channel_accounts)
      .where(
        and(
          eq(channel_accounts.organization_id, organizationId),
          eq(channel_accounts.public_id, channelAccountPublicId),
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * One page of one account's live contacts (route 18, CT2, CT12): the filters, `q` over the trigram
   * expression under its own statement timeout (S6), the keyset sort (`last_message_received_at` on
   * the activity row's index, `first_seen_at` and `username` on the contact's) and, on the first page,
   * the capped total.
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
      eq(contacts.channel_account_id, query.channelAccountId),
      LIVE_CONTACT,
      ...this.filterConditions(query),
    );
    const sortColumn = {
      last_message_received_at: contact_activities.last_message_received_at,
      first_seen_at: contacts.first_seen_at,
      username: contacts.username,
    }[query.sort];
    const { orderBy, cursorCondition, sortValueFor, filterFingerprint } =
      resolveKeysetSort<ContactListRow>({
        columns: {
          last_message_received_at: {
            column: contact_activities.last_message_received_at,
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
        idColumn:
          query.sort === 'last_message_received_at' ? contact_activities.contact_id : contacts.id,
        defaultSort: 'last_message_received_at',
        sort: query.sort,
        order: query.order,
        q: query.q,
        filters: {
          channel_account_id: query.channelAccountId,
          ...this.filterFingerprintParts(query),
        },
        after: query.after,
      });
    if (query.q !== undefined) {
      await this.db().execute(
        sql`SET LOCAL statement_timeout = ${sql.raw(String(CONTACT_SEARCH_STATEMENT_TIMEOUT_MS))}`,
      );
    }
    const rows = (await this.db()
      .select({
        ...CONTACT_ROW_COLUMNS,
        channel_account_public_id: channel_accounts.public_id,
        first_automation_public_id: automations.public_id,
        // The time sorts keyset on their own column; the username sort on created_at (unused).
        cursor_created_at: cursorTimestampSelection(
          query.sort === 'username' ? contacts.created_at : sortColumn,
        ),
      })
      .from(contacts)
      .innerJoin(contact_activities, CONTACT_ACTIVITY_JOIN)
      .innerJoin(channel_accounts, CONTACT_CHANNEL_ACCOUNT_JOIN)
      .leftJoin(automations, FIRST_AUTOMATION_JOIN)
      .where(
        and(
          where,
          // The activity row's copy of the account, so its sort index reads one account (S5).
          eq(contact_activities.organization_id, organizationId),
          eq(contact_activities.channel_account_id, query.channelAccountId),
          cursorCondition,
        ),
      )
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

  /** The filters' values for the cursor fingerprint (a cursor never crosses filter sets). */
  private filterFingerprintParts(query: ContactBulkActionFilter): Record<string, unknown> {
    return {
      tags: query.tags,
      has_email: query.hasEmail ?? null,
      has_phone: query.hasPhone ?? null,
      is_following_account: query.isFollowingAccount ?? null,
      first_seen_from: query.firstSeenFrom?.toISOString() ?? null,
      first_seen_to: query.firstSeenTo?.toISOString() ?? null,
      automation_id: query.automationPublicId ?? null,
      is_opted_out: query.isOptedOut ?? null,
      is_automations_paused: query.isAutomationsPaused ?? null,
      came_in_via: query.cameInVia,
      first_automation_id: query.firstAutomationPublicId ?? null,
    };
  }

  /** The list's (and the bulk filter's) conditions over the contact row; an absent filter adds none. */
  private filterConditions(
    query: ContactBulkActionFilter & {
      automationId: number | null | undefined;
      firstAutomationId: number | null | undefined;
    },
  ): (SQL | undefined)[] {
    return [
      query.tags.length === 0 ? undefined : arrayContains(contacts.tags, [...query.tags]),
      presenceFilter(contacts.email, query.hasEmail),
      presenceFilter(contacts.phone, query.hasPhone),
      // Never checked (null) matches neither value.
      query.isFollowingAccount === undefined
        ? undefined
        : eq(contacts.is_following_account, query.isFollowingAccount),
      query.firstSeenFrom === undefined
        ? undefined
        : gte(contacts.first_seen_at, query.firstSeenFrom),
      query.firstSeenTo === undefined ? undefined : lt(contacts.first_seen_at, query.firstSeenTo),
      presenceFilter(contacts.opted_out_at, query.isOptedOut),
      presenceFilter(contacts.automations_off_at, query.isAutomationsPaused),
      query.cameInVia.length === 0
        ? undefined
        : inArray(contacts.came_in_via, [...query.cameInVia]),
      internalIdFilter(query.firstAutomationId, (id) => eq(contacts.first_automation_id, id)),
      internalIdFilter(query.automationId, contactHadRunOfAutomation),
      buildSearchCondition({ columns: [CONTACT_SEARCH_EXPRESSION], q: query.q, everyWord: true }),
    ];
  }

  /**
   * How many live contacts of one account a bulk action selects (route 21, CT7), counted up to
   * `cap`: the named ids (`con_…`), or every match of the filter.
   */
  async countBulkSelection({
    organizationId,
    channelAccountId,
    contactPublicIds,
    filter,
    cap,
  }: {
    organizationId: number;
    channelAccountId: number;
    contactPublicIds: readonly string[] | null;
    filter:
      | (ContactBulkActionFilter & {
          automationId: number | null | undefined;
          firstAutomationId: number | null | undefined;
        })
      | null;
    cap: number;
  }): Promise<number> {
    const where = and(
      eq(contacts.organization_id, organizationId),
      eq(contacts.channel_account_id, channelAccountId),
      LIVE_CONTACT,
      contactPublicIds === null ? undefined : inArray(contacts.public_id, [...contactPublicIds]),
      ...(filter === null ? [] : this.filterConditions(filter)),
    );
    return countWithCap({ database: this.db(), table: contacts, where, cap });
  }

  /**
   * The organization's live contact's internal id and channel by public id (routes 24–26), or `null`
   * when absent, another organization's or erased.
   */
  async findLiveKeyByPublicId({
    organizationId,
    contactPublicId,
  }: {
    organizationId: number;
    contactPublicId: string;
  }): Promise<{ id: number; channel: string } | null> {
    const [row] = await this.db()
      .select({ id: contacts.id, channel: contacts.channel })
      .from(contacts)
      .where(
        and(
          eq(contacts.organization_id, organizationId),
          eq(contacts.public_id, contactPublicId),
          LIVE_CONTACT,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The organization's live contact with this public id as the routes show it (route 19, CT13): the
   * view row, her first automation's name and how many of her runs are open. `null` when absent,
   * another organization's or erased.
   */
  async findDetailByPublicId({
    organizationId,
    contactPublicId,
  }: {
    organizationId: number;
    contactPublicId: string;
  }): Promise<ContactDetailRow | null> {
    const openRunCount = this.db()
      .select({ value: count() })
      .from(automation_runs)
      .where(
        and(
          eq(automation_runs.organization_id, contacts.organization_id),
          eq(automation_runs.contact_id, contacts.id),
          inArray(automation_runs.status, ['running', 'waiting']),
        ),
      );
    const rows = await this.db()
      .select({
        ...CONTACT_ROW_COLUMNS,
        channel_account_public_id: channel_accounts.public_id,
        first_automation_public_id: automations.public_id,
        first_automation_name: automations.name,
        open_run_count: sql<number>`(${openRunCount})::integer`,
      })
      .from(contacts)
      .innerJoin(contact_activities, CONTACT_ACTIVITY_JOIN)
      .innerJoin(channel_accounts, CONTACT_CHANNEL_ACCOUNT_JOIN)
      .leftJoin(automations, FIRST_AUTOMATION_JOIN)
      .where(
        and(
          eq(contacts.organization_id, organizationId),
          eq(contacts.public_id, contactPublicId),
          LIVE_CONTACT,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The organization's live contact with this public id, locked for a change: `FOR UPDATE` for the
   * erase (route 23, so a racing write waits and then finds it erased), `FOR NO KEY UPDATE` for the
   * owner's change (route 20 — it waits for an erase but never for the run engine's `KEY SHARE`).
   * `null` when absent, another organization's or already erased.
   */
  async lockLiveByPublicId({
    organizationId,
    contactPublicId,
    strength = 'update',
  }: {
    organizationId: number;
    contactPublicId: string;
    strength?: 'update' | 'no key update';
  }): Promise<ContactRow | null> {
    // The lock names `app.contacts` alone (Postgres refuses a schema-qualified `FOR … OF`), then the
    // locked row is read with its activity row.
    const locked = await this.db()
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.organization_id, organizationId),
          eq(contacts.public_id, contactPublicId),
          LIVE_CONTACT,
        ),
      )
      .limit(1)
      .for(strength);
    const contactId = locked[0]?.id;
    return contactId === undefined ? null : this.findLiveById({ organizationId, contactId });
  }

  /**
   * Erases the contact in place (route 23, CT11): `deleted_at` set and every personal column cleared
   * — the provider id, username, full name, picture, followers, the follow status, email and phone
   * with their times, tags, the note, the opt-out, the pause and the came-in ref — and her activity
   * row deleted (her activity is personal data too). `first_automation_id`, `came_in_via` and
   * `channel` stay. Returns the erased row, or `null` when it was already erased.
   */
  async erase({ organizationId, contactId }: ContactKey): Promise<ContactRecord | null> {
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
        note: null,
        opted_out_at: null,
        automations_off_at: null,
        automations_off_by_user_id: null,
        came_in_ref: null,
        deleted_at: databaseNowTimestamp,
        updated_at: contactUpdatedAtTimestamp,
      })
      .where(
        and(eq(contacts.organization_id, organizationId), eq(contacts.id, contactId), LIVE_CONTACT),
      )
      .returning();
    const erased = rows[0] ?? null;
    if (erased !== null) {
      await this.db()
        .delete(contact_activities)
        .where(
          and(
            eq(contact_activities.organization_id, organizationId),
            eq(contact_activities.contact_id, contactId),
          ),
        );
    }
    return erased;
  }

  /** The organization's live contact with this internal id, or `null` once erased (`findLiveContact`). */
  async findLiveById({ organizationId, contactId }: ContactKey): Promise<ContactRow | null> {
    const rows = await this.db()
      .select(CONTACT_ROW_COLUMNS)
      .from(contacts)
      .innerJoin(contact_activities, CONTACT_ACTIVITY_JOIN)
      .where(
        and(eq(contacts.organization_id, organizationId), eq(contacts.id, contactId), LIVE_CONTACT),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The organization's live contact with this internal id, its contact row locked `FOR KEY SHARE`
   * until the unit ends (`lockLiveContact`): the erase's `FOR UPDATE` waits for it and then clears
   * what the unit wrote; a unit that meets an erase waits and gets `null`. Two units of one contact
   * never block each other, nor does the owner's `NO KEY UPDATE`.
   */
  async lockLiveById({ organizationId, contactId }: ContactKey): Promise<ContactRow | null> {
    const locked = await this.db()
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(eq(contacts.organization_id, organizationId), eq(contacts.id, contactId), LIVE_CONTACT),
      )
      .limit(1)
      .for('key share');
    return locked.length === 0 ? null : this.findLiveById({ organizationId, contactId });
  }

  /**
   * Takes her contact row `FOR NO KEY UPDATE SKIP LOCKED` until the unit ends (the fast claim, plan
   * §30.2 step 2): two fast claims of one person never run side by side, while the event units'
   * `FOR KEY SHARE` is never blocked. Answers `false` when another unit holds it (or she is gone).
   */
  async lockForFastSend({ organizationId, contactId }: ContactKey): Promise<boolean> {
    const locked = await this.db()
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(eq(contacts.organization_id, organizationId), eq(contacts.id, contactId), LIVE_CONTACT),
      )
      .limit(1)
      .for('no key update', { skipLocked: true });
    return locked.length > 0;
  }

  /**
   * Creates the contact of one processed event, or touches the live one (`recordContactInteraction`,
   * CT18, S5): the contact row is inserted, or updated only when the event carries a new username;
   * then its activity row is inserted (a new contact: first-seen = last-message = the event's time)
   * or its times moved forward (`greatest`). A DM, story reply or button click also moves
   * `last_direct_message_received_at`. An erased row holds a `NULL` provider id, so it never matches
   * — the same person's next event creates a fresh contact (CT9).
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
            channel_account_id: values.channelAccountId,
            instagram_user_id: values.instagramUserId,
            username: values.username,
            first_seen_at: values.occurredAt,
          })
          .onConflictDoUpdate({
            target: [
              contacts.organization_id,
              contacts.channel_account_id,
              contacts.instagram_user_id,
            ],
            set: {
              username: sql`coalesce(excluded.username, ${contacts.username})`,
              updated_at: sql`CASE WHEN excluded.username IS NOT NULL AND excluded.username IS DISTINCT FROM ${contacts.username} THEN ${contactUpdatedAtTimestamp} ELSE ${contacts.updated_at} END`,
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
    const activities = await this.db()
      .insert(contact_activities)
      .values({
        contact_id: contact.id,
        organization_id: values.organizationId,
        channel_account_id: values.channelAccountId,
        last_message_received_at: values.occurredAt,
        last_direct_message_received_at: directMessageAt,
      })
      .onConflictDoUpdate({
        target: [contact_activities.organization_id, contact_activities.contact_id],
        set: {
          // greatest() skips a NULL, so a comment (no DM time) keeps the stored one.
          last_message_received_at: sql`greatest(${contact_activities.last_message_received_at}, excluded.last_message_received_at)`,
          last_direct_message_received_at: sql`greatest(${contact_activities.last_direct_message_received_at}, excluded.last_direct_message_received_at)`,
        },
      })
      .returning();
    const activity = activities[0];
    if (activity === undefined) {
      throw new Error('contact activity upsert returned no row');
    }
    return { contact: mergeContactRow({ contact, activity }), isInserted };
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

  /** Replaces a live contact's tags (the service merged them); `null` once erased. */
  async replaceTags({
    organizationId,
    contactId,
    tags,
  }: ContactKey & { tags: readonly string[] }): Promise<ContactRow | null> {
    return this.updateLive({ organizationId, contactId, values: { tags: [...tags] } });
  }

  /**
   * The owner's change of one live contact (route 20, the bulk job, CT5): the note, the tags and the
   * pause columns given; `null` once erased.
   */
  async updateOwnerFields({
    organizationId,
    contactId,
    values,
  }: ContactKey & {
    values: Pick<
      PgUpdateSetSource<typeof contacts>,
      'note' | 'tags' | 'automations_off_at' | 'automations_off_by_user_id'
    >;
  }): Promise<ContactRow | null> {
    return this.updateLive({ organizationId, contactId, values });
  }

  /**
   * Sets (`at`) or clears (`null`) her opt-out on a live contact (CT6); `null` once erased. Setting
   * keeps an earlier opt-out time (`coalesce`).
   */
  async setOptedOut({
    organizationId,
    contactId,
    at,
  }: ContactKey & { at: Date | null }): Promise<ContactRow | null> {
    return this.updateLive({
      organizationId,
      contactId,
      values: {
        opted_out_at:
          at === null
            ? null
            : sql`coalesce(${contacts.opted_out_at}, ${at.toISOString()}::timestamptz)`,
      },
    });
  }

  /**
   * Sets the "via" columns of her first run once (`recordContactFirstRun`, CT3): a contact that has
   * one keeps it; `null` once erased.
   */
  async recordFirstRun({
    organizationId,
    contactId,
    automationId,
    cameInVia,
    cameInRef,
  }: ContactKey & {
    automationId: number;
    cameInVia: string;
    cameInRef: string | null;
  }): Promise<ContactRow | null> {
    await this.db()
      .update(contacts)
      .set({
        first_automation_id: automationId,
        came_in_via: cameInVia,
        came_in_ref: cameInRef,
        updated_at: contactUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(contacts.organization_id, organizationId),
          eq(contacts.id, contactId),
          LIVE_CONTACT,
          isNull(contacts.came_in_via),
        ),
      );
    return this.findLiveById({ organizationId, contactId });
  }

  /**
   * One activity of a live contact on its activity row (S5, 3.A.10): each time moves forward only
   * (`greatest`), `first_message_at` is set once, a comment also adds one to `comment_count`.
   * `null` once erased (an erased contact has no activity row).
   */
  async recordActivity({
    organizationId,
    contactId,
    change,
  }: ContactKey & { change: ContactActivityChange }): Promise<ContactRow | null> {
    const rows = await this.db()
      .update(contact_activities)
      .set(activityChangeValues(change))
      .where(
        and(
          eq(contact_activities.organization_id, organizationId),
          eq(contact_activities.contact_id, contactId),
        ),
      )
      .returning({ contact_id: contact_activities.contact_id });
    if (rows.length === 0) return null;
    return this.findLiveById({ organizationId, contactId });
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
    return this.recordActivity({
      organizationId,
      contactId,
      change: { kind: 'message_sent', at: sentAt },
    });
  }

  /**
   * Moves the account's tag counts by the given deltas in the caller's unit (S7): increments upsert,
   * decrements stop at 0, and rows left at 0 are deleted. Tags are applied in A→Z order, so two
   * commits that touch the same tags lock their rows in the same order.
   */
  async applyTagCountDeltas({
    organizationId,
    channelAccountId,
    deltas,
  }: {
    organizationId: number;
    channelAccountId: number;
    deltas: readonly ContactTagCountDelta[];
  }): Promise<void> {
    const sorted = deltas.filter((entry) => entry.delta !== 0).sort(compareTagDeltas);
    const increments = sorted.filter((entry) => entry.delta > 0);
    const decrements = sorted.filter((entry) => entry.delta < 0);
    if (increments.length > 0) {
      await this.db()
        .insert(contact_tag_counts)
        .values(
          increments.map((entry) => ({
            organization_id: organizationId,
            channel_account_id: channelAccountId,
            tag: entry.tag,
            contact_count: entry.delta,
          })),
        )
        .onConflictDoUpdate({
          target: [
            contact_tag_counts.organization_id,
            contact_tag_counts.channel_account_id,
            contact_tag_counts.tag,
          ],
          set: {
            contact_count: sql`${contact_tag_counts.contact_count} + excluded.contact_count`,
          },
        });
    }
    for (const entry of decrements) {
      await this.db()
        .update(contact_tag_counts)
        .set({
          contact_count: sql`greatest(${contact_tag_counts.contact_count} + ${entry.delta}, 0)`,
        })
        .where(
          and(
            eq(contact_tag_counts.organization_id, organizationId),
            eq(contact_tag_counts.channel_account_id, channelAccountId),
            eq(contact_tag_counts.tag, entry.tag),
          ),
        );
    }
    if (decrements.length > 0) {
      await this.db()
        .delete(contact_tag_counts)
        .where(
          and(
            eq(contact_tag_counts.organization_id, organizationId),
            eq(contact_tag_counts.channel_account_id, channelAccountId),
            inArray(
              contact_tag_counts.tag,
              decrements.map((entry) => entry.tag),
            ),
            eq(contact_tag_counts.contact_count, 0),
          ),
        );
    }
  }

  /** One account's tags with their live-contact counts, most first then A→Z (route 22, S7). */
  async listTagCounts({
    organizationId,
    channelAccountId,
    limit,
  }: {
    organizationId: number;
    channelAccountId: number;
    limit: number;
  }): Promise<{ tag: string; contact_count: number }[]> {
    return this.db()
      .select({ tag: contact_tag_counts.tag, contact_count: contact_tag_counts.contact_count })
      .from(contact_tag_counts)
      .where(
        and(
          eq(contact_tag_counts.organization_id, organizationId),
          eq(contact_tag_counts.channel_account_id, channelAccountId),
        ),
      )
      .orderBy(desc(contact_tag_counts.contact_count), asc(contact_tag_counts.tag))
      .limit(limit);
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
      .returning({ id: contacts.id });
    if (rows.length === 0) return null;
    return this.findLiveById({ organizationId, contactId });
  }
}

/** One activity of a contact (3.A.10): what happened and Instagram's (or our send's) time. */
export interface ContactActivityChange {
  kind: 'comment' | 'story' | 'first_message' | 'opening_message' | 'broadcast' | 'message_sent';
  at: Date;
}

/** Orders two tag deltas by tag, in code-unit order. */
function compareTagDeltas(left: ContactTagCountDelta, right: ContactTagCountDelta): number {
  if (left.tag < right.tag) return -1;
  if (left.tag > right.tag) return 1;
  return 0;
}

/** The activity-row values one {@link ContactActivityChange} sets. */
function activityChangeValues(
  change: ContactActivityChange,
): PgUpdateSetSource<typeof contact_activities> {
  const at = sql`${change.at.toISOString()}::timestamptz`;
  switch (change.kind) {
    case 'comment':
      return {
        last_comment_at: sql`greatest(${contact_activities.last_comment_at}, ${at})`,
        comment_count: sql`${contact_activities.comment_count} + 1`,
      };
    case 'story':
      return {
        last_story_activity_at: sql`greatest(${contact_activities.last_story_activity_at}, ${at})`,
      };
    case 'first_message':
      return { first_message_at: sql`coalesce(${contact_activities.first_message_at}, ${at})` };
    case 'opening_message':
      return {
        last_opening_message_at: sql`greatest(${contact_activities.last_opening_message_at}, ${at})`,
      };
    case 'broadcast':
      return { last_broadcast_at: sql`greatest(${contact_activities.last_broadcast_at}, ${at})` };
    case 'message_sent':
      return {
        last_message_sent_at: sql`greatest(${contact_activities.last_message_sent_at}, ${at})`,
      };
  }
}

/** A contact row and its activity row as one {@link ContactRow}. */
function mergeContactRow({
  contact,
  activity,
}: {
  contact: ContactRecord;
  activity: ContactActivityRecord;
}): ContactRow {
  const {
    id: _activityId,
    contact_id: _contactId,
    organization_id: _organizationId,
    channel_account_id: _channelAccountId,
    ...times
  } = activity;
  return { ...contact, ...times };
}

/**
 * {@link ContactRepository} bound to a job's organization handle (`runOrganizationScopedWorkerJob`)
 * — event processing and the run engine through the contact service's operations (CT1).
 */
export function createWorkerContactRepository(
  databaseHandle: WorkerDatabaseHandle,
): ContactRepository {
  assertWorkerDatabaseContext(['organization']);
  return new ContactRepository(databaseHandle);
}
