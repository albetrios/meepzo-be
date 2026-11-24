import { insertChannelAccount } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { and, eq, getTableColumns } from 'drizzle-orm';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { contact_activities } from '@/domains/app/sub-domains/contact/contact-activity.schema.js';
import type { ContactRow } from '@/domains/app/sub-domains/contact/contact.repository.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

/** `GET /app/contacts` (route 18). */
export const CONTACTS_PATH = testApiPath('/app/contacts');

/** `POST /app/contacts/bulk-actions` (route 21). */
export const CONTACT_BULK_ACTIONS_PATH = testApiPath('/app/contacts/bulk-actions');

/** `GET /app/contact-tags` (route 22). */
export const CONTACT_TAGS_PATH = testApiPath('/app/contact-tags');

/** `GET`, `PATCH`, `DELETE /app/contacts/{contact_id}` (routes 19, 20, 23). */
export function contactPath(contactPublicId: string): string {
  return `${CONTACTS_PATH}/${contactPublicId}`;
}

/**
 * One contact as the fixtures write and read it: its `app.contacts` row and its activity row's
 * times (S5) — an erased contact has no activity row, so `readContactRow` gives `null` times then.
 */
export type ContactFixtureRow = ContactRow;

/** The activity columns {@link insertContact} writes to `app.contact_activities`. */
const ACTIVITY_KEYS = [
  'last_message_received_at',
  'last_direct_message_received_at',
  'last_message_sent_at',
  'last_opening_message_at',
  'first_message_at',
  'last_comment_at',
  'comment_count',
  'last_story_activity_at',
  'last_broadcast_at',
] as const;

/** The activity columns a contact read selects (left-joined: `null` for an erased contact). */
const ACTIVITY_SELECTION = Object.fromEntries(
  ACTIVITY_KEYS.map((key) => [key, contact_activities[key]]),
) as { [Key in (typeof ACTIVITY_KEYS)[number]]: (typeof contact_activities)[Key] };

/** The channel account an Instagram account extends (contacts are keyed by it since R10). */
export async function channelAccountIdOfInstagramAccount(
  instagramAccountId: number,
): Promise<number> {
  const [row] = await getOperatorDatabase()
    .select({ channel_account_id: instagram_accounts.channel_account_id })
    .from(instagram_accounts)
    .where(eq(instagram_accounts.id, instagramAccountId))
    .limit(1);
  if (row === undefined) throw new Error('instagram account fixture not found');
  return row.channel_account_id;
}

let instagramIdentifierSequence = 0;

/** A fresh digit-only Instagram id (unique per call). */
export function nextInstagramUserId(): string {
  instagramIdentifierSequence += 1;
  return `1784${`${Date.now()}${instagramIdentifierSequence}`.slice(-12).padStart(12, '0')}`;
}

/**
 * Inserts a connected Instagram account for an organization through the operator, with its own
 * channel connection and token (P111), as a pick leaves it (the settings are not needed by the
 * contact routes).
 */
export async function insertInstagramAccount({
  organizationId,
  connectionStatus = 'connected',
}: {
  organizationId: number;
  connectionStatus?: 'connected' | 'revoked';
}): Promise<{ id: number; public_id: string; channel_account_id: number }> {
  const instagramUserId = nextInstagramUserId();
  const channelAccount = await insertChannelAccount({
    organizationId,
    providerAccountId: instagramUserId,
    connectionStatus,
  });
  const [account] = await getOperatorDatabase()
    .insert(instagram_accounts)
    .values({
      organization_id: organizationId,
      channel_account_id: channelAccount.id,
      instagram_user_id: instagramUserId,
      username: `acme.shop.${instagramUserId.slice(-6)}`,
    })
    .returning({ id: instagram_accounts.id });
  if (account === undefined) throw new Error('instagram account fixture insert returned no row');
  // The account's one id is its channel account's (`cha_…`, P47, R6).
  return {
    id: account.id,
    public_id: channelAccount.public_id,
    channel_account_id: channelAccount.id,
  };
}

/**
 * Inserts one live contact and its activity row (S5) through the operator; every column may be
 * overridden (the times default to now, the Instagram user id to a fresh one). The contact is keyed
 * by the channel account `instagramAccountId` extends.
 */
export async function insertContact({
  organizationId,
  instagramAccountId,
  ...overrides
}: {
  organizationId: number;
  instagramAccountId: number;
} & Partial<
  Omit<ContactFixtureRow, 'id' | 'organization_id' | 'channel_account_id'>
>): Promise<ContactFixtureRow> {
  const now = new Date();
  const channelAccountId = await channelAccountIdOfInstagramAccount(instagramAccountId);
  const activityOverrides: Record<string, unknown> = {};
  const contactOverrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if ((ACTIVITY_KEYS as readonly string[]).includes(key)) activityOverrides[key] = value;
    else contactOverrides[key] = value;
  }
  const database = getOperatorDatabase();
  const [contact] = await database
    .insert(contacts)
    .values({
      public_id: generatePublicId('contact'),
      organization_id: organizationId,
      channel_account_id: channelAccountId,
      instagram_user_id: nextInstagramUserId(),
      first_seen_at: now,
      ...(contactOverrides as Partial<typeof contacts.$inferInsert>),
    })
    .returning();
  if (contact === undefined) throw new Error('contact fixture insert returned no row');
  if (contact.deleted_at === null) {
    await database.insert(contact_activities).values({
      contact_id: contact.id,
      organization_id: organizationId,
      channel_account_id: channelAccountId,
      last_message_received_at: now,
      ...(activityOverrides as Partial<typeof contact_activities.$inferInsert>),
    });
  }
  const row = await readContactRow(contact.id);
  if (row === undefined) throw new Error('contact fixture read returned no row');
  return row;
}

/** One contact by its internal id, read as the operator (erased rows included, their times `null`). */
export async function readContactRow(contactId: number): Promise<ContactFixtureRow | undefined> {
  const [contact] = await getOperatorDatabase()
    .select({ ...getTableColumns(contacts), ...ACTIVITY_SELECTION })
    .from(contacts)
    .leftJoin(
      contact_activities,
      and(
        eq(contact_activities.organization_id, contacts.organization_id),
        eq(contact_activities.contact_id, contacts.id),
      ),
    )
    .where(eq(contacts.id, contactId))
    .limit(1);
  return contact as ContactFixtureRow | undefined;
}

/** Updates one contact's activity row as the operator (S5) — a test ages her times this way. */
export async function updateContactActivity({
  contactId,
  values,
}: {
  contactId: number;
  values: Partial<typeof contact_activities.$inferInsert>;
}): Promise<void> {
  await getOperatorDatabase()
    .update(contact_activities)
    .set(values)
    .where(eq(contact_activities.contact_id, contactId));
}

/** Every contact row of one account, oldest first, read as the operator. */
export async function readAccountContactRows({
  organizationId,
  instagramAccountId,
}: {
  organizationId: number;
  instagramAccountId: number;
}): Promise<ContactFixtureRow[]> {
  const [account] = await getOperatorDatabase()
    .select({ channel_account_id: instagram_accounts.channel_account_id })
    .from(instagram_accounts)
    .where(eq(instagram_accounts.id, instagramAccountId))
    .limit(1);
  // The organization (and its accounts) may be gone already: then it has no contacts either.
  if (account === undefined) return [];
  const channelAccountId = account.channel_account_id;
  const rows = await getOperatorDatabase()
    .select({ ...getTableColumns(contacts), ...ACTIVITY_SELECTION })
    .from(contacts)
    .leftJoin(
      contact_activities,
      and(
        eq(contact_activities.organization_id, contacts.organization_id),
        eq(contact_activities.contact_id, contacts.id),
      ),
    )
    .where(
      and(
        eq(contacts.organization_id, organizationId),
        eq(contacts.channel_account_id, channelAccountId),
      ),
    )
    .orderBy(contacts.id);
  return rows as ContactFixtureRow[];
}
