/**
 * Contact bulk seeder — gives every demo team organization's connected Instagram account a set of
 * contacts (`app.contacts`), as event processing leaves them (routes-final § 2.3): usernames (a few
 * DM-only contacts without one, so the username sort's "last" end is filled), some emails and
 * phones with their collection times, some follow checks, tags, and message times.
 *
 * Idempotency: each contact's Instagram user id is derived from the organization id and its index
 * (digits behind a `6`, never a real Instagram id), so a re-run hits the upsert index and every
 * insert is `ON CONFLICT DO NOTHING`. No reference data: contacts are tenant rows only.
 */
import { and, eq, ne } from 'drizzle-orm';
import type { Faker } from '@faker-js/faker';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';
import { generateBulkContactProfile } from './contact.faker.js';

/** How many contacts each seeded Instagram account gets. */
const SEEDED_CONTACTS_PER_ACCOUNT = 12;
/** How far back the oldest seeded contact was first seen. */
const SEEDED_FIRST_SEEN_MAX_DAYS_AGO = 60;

/** A seeded contact's Instagram user id: digits behind a leading `6`, unique per organization and index. */
function seededInstagramUserId({
  organizationId,
  index,
}: {
  organizationId: number;
  index: number;
}): string {
  return `6${String(organizationId).padStart(12, '0')}${String(index).padStart(3, '0')}`;
}

/** A moment between `from` and `to`. */
function momentBetween({ faker, from, to }: { faker: Faker; from: Date; to: Date }): Date {
  return faker.date.between({ from, to });
}

/** Seeds one organization's contacts; returns how many were written. */
async function seedContactsForOrganization({
  context,
  organization,
}: {
  context: SeedContext;
  organization: SeededOrg;
}): Promise<number> {
  const database = getRequestDatabase();
  const [account] = await database
    .select({ id: instagram_accounts.id })
    .from(instagram_accounts)
    .where(
      and(
        eq(instagram_accounts.organization_id, organization.id),
        ne(instagram_accounts.connection_status, 'revoked'),
      ),
    )
    .limit(1);
  // No live account: no event could have created a contact.
  if (account === undefined) return 0;

  const now = new Date();
  const oldest = new Date(now.getTime() - SEEDED_FIRST_SEEN_MAX_DAYS_AGO * MILLISECONDS_PER_DAY);
  const rows = Array.from({ length: SEEDED_CONTACTS_PER_ACCOUNT }, (_, index) => {
    const profile = generateBulkContactProfile(context.faker);
    const firstSeenAt = momentBetween({ faker: context.faker, from: oldest, to: now });
    const lastMessageReceivedAt = momentBetween({
      faker: context.faker,
      from: firstSeenAt,
      to: now,
    });
    const sentDirectMessage = context.faker.datatype.boolean();
    return {
      public_id: generatePublicId('contact'),
      organization_id: organization.id,
      instagram_account_id: account.id,
      instagram_user_id: seededInstagramUserId({ organizationId: organization.id, index }),
      username: profile.username,
      full_name: profile.fullName,
      profile_picture_url: profile.profilePictureUrl,
      followers_count: profile.followersCount,
      is_following_account: profile.isFollowingAccount,
      follow_checked_at: profile.isFollowingAccount === null ? null : lastMessageReceivedAt,
      email: profile.email,
      email_collected_at: profile.email === null ? null : lastMessageReceivedAt,
      phone: profile.phone,
      phone_collected_at: profile.phone === null ? null : lastMessageReceivedAt,
      tags: profile.tags,
      first_seen_at: firstSeenAt,
      last_message_received_at: lastMessageReceivedAt,
      last_direct_message_received_at: sentDirectMessage ? lastMessageReceivedAt : null,
      last_message_sent_at: sentDirectMessage ? lastMessageReceivedAt : null,
    };
  });
  const inserted = await database
    .insert(contacts)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: contacts.id });
  return inserted.length;
}

/**
 * Seeds the contacts of every registry organization's live Instagram account.
 *
 * @remarks
 * Parents read: `context.registry.organizations` — the tenancy seeder's bulk team organizations —
 * and each one's live `app.instagram_accounts` row, which the Instagram account seeder wrote just
 * before (the app domain composes the contact contribution after it). Algorithm: per organization,
 * read its live account (none → skip), then insert `SEEDED_CONTACTS_PER_ACCOUNT` contacts
 * with `ON CONFLICT DO NOTHING`. Side effects: inserts into `app.contacts`. Failure modes: warns and
 * returns early when the registry has no organizations; otherwise propagates database errors.
 */
export async function seedContactsBulk(context: SeedContext): Promise<void> {
  const organizations = context.registry.organizations;
  if (organizations.length === 0) {
    context.logger.warn('seed.bulk.contact: empty organization pool; run the tenancy seeder first');
    return;
  }

  let created = 0;
  for (const organization of organizations) {
    created += await seedContactsForOrganization({ context, organization });
  }
  context.logger.info(
    { organizations: organizations.length, created },
    'seed.bulk.contact: contacts seeded',
  );
}
