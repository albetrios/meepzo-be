import { insertChannelConnection } from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import { and, eq } from 'drizzle-orm';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

/** `GET /app/contacts` (route 9). */
export const CONTACTS_PATH = testApiPath('/app/contacts');

/** `DELETE /app/contacts/{contact_id}` (route 10). */
export function contactPath(contactPublicId: string): string {
  return `${CONTACTS_PATH}/${contactPublicId}`;
}

/** One `app.contacts` row as the fixtures write and read it. */
export type ContactFixtureRow = typeof contacts.$inferSelect;

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
}): Promise<{ id: number; public_id: string }> {
  const instagramUserId = nextInstagramUserId();
  const connection = await insertChannelConnection({ organizationId });
  const [account] = await getOperatorDatabase()
    .insert(instagram_accounts)
    .values({
      public_id: generatePublicId('instagramAccount'),
      organization_id: organizationId,
      channel_connection_id: connection.id,
      instagram_user_id: instagramUserId,
      instagram_app_user_id: instagramUserId,
      username: `acme.shop.${instagramUserId.slice(-6)}`,
      connection_status: connectionStatus,
      disconnected_at: connectionStatus === 'revoked' ? new Date() : null,
    })
    .returning({ id: instagram_accounts.id, public_id: instagram_accounts.public_id });
  if (account === undefined) throw new Error('instagram account fixture insert returned no row');
  return account;
}

/**
 * Inserts one live contact through the operator; every column may be overridden (the times default
 * to now, the Instagram user id to a fresh one).
 */
export async function insertContact({
  organizationId,
  instagramAccountId,
  ...overrides
}: {
  organizationId: number;
  instagramAccountId: number;
} & Partial<
  Omit<ContactFixtureRow, 'id' | 'organization_id' | 'instagram_account_id'>
>): Promise<ContactFixtureRow> {
  const now = new Date();
  const [contact] = await getOperatorDatabase()
    .insert(contacts)
    .values({
      public_id: generatePublicId('contact'),
      organization_id: organizationId,
      instagram_account_id: instagramAccountId,
      instagram_user_id: nextInstagramUserId(),
      first_seen_at: now,
      last_message_received_at: now,
      ...overrides,
    })
    .returning();
  if (contact === undefined) throw new Error('contact fixture insert returned no row');
  return contact;
}

/** One contact row by its internal id, read as the operator (erased rows included). */
export async function readContactRow(contactId: number): Promise<ContactFixtureRow | undefined> {
  const [contact] = await getOperatorDatabase()
    .select()
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  return contact;
}

/** Every contact row of one account, oldest first, read as the operator. */
export async function readAccountContactRows({
  organizationId,
  instagramAccountId,
}: {
  organizationId: number;
  instagramAccountId: number;
}): Promise<ContactFixtureRow[]> {
  return getOperatorDatabase()
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.organization_id, organizationId),
        eq(contacts.instagram_account_id, instagramAccountId),
      ),
    )
    .orderBy(contacts.id);
}
