/**
 * Contact bulk seeder — gives every demo team organization's connected channel account a set of
 * contacts (`app.contacts`, their `app.contact_activities` and the account's `app.contact_tag_counts`),
 * as event processing and the team leave them (routes-final § 3, CTC10): usernames (a few DM-only
 * contacts without one, so the username sort's "last" end is filled), some emails and phones with
 * their collection times, some follow checks, tags, notes, one contact whose automations are paused
 * and one opted out, and message times.
 *
 * Idempotency: each contact's Instagram user id is derived from the organization id and its index
 * (digits behind a `6`, never a real Instagram id), so a re-run hits the upsert index and every
 * insert is `ON CONFLICT DO NOTHING`. No reference data: contacts are tenant rows only.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Faker } from '@faker-js/faker';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { contact_activities } from '@/domains/app/sub-domains/contact/contact-activity.schema.js';
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
    .select({ id: channel_accounts.id })
    .from(channel_accounts)
    .where(
      and(
        eq(channel_accounts.organization_id, organization.id),
        eq(channel_accounts.channel, 'instagram'),
        ne(channel_accounts.connection_status, 'revoked'),
      ),
    )
    .orderBy(channel_accounts.id)
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
      contact: {
        public_id: generatePublicId('contact'),
        organization_id: organization.id,
        channel_account_id: account.id,
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
        note: profile.note,
        // The first contact's automations are paused by the team, the second one opted out (CTC10).
        automations_off_at: index === 0 ? lastMessageReceivedAt : null,
        opted_out_at: index === 1 ? lastMessageReceivedAt : null,
        first_seen_at: firstSeenAt,
      },
      activity: {
        last_message_received_at: lastMessageReceivedAt,
        last_direct_message_received_at: sentDirectMessage ? lastMessageReceivedAt : null,
        last_message_sent_at: sentDirectMessage ? lastMessageReceivedAt : null,
        last_comment_at: sentDirectMessage ? null : lastMessageReceivedAt,
        comment_count: sentDirectMessage ? 0 : context.faker.number.int({ min: 1, max: 5 }),
      },
    };
  });
  const inserted = await database
    .insert(contacts)
    .values(rows.map((row) => row.contact))
    .onConflictDoNothing()
    .returning({ id: contacts.id, public_id: contacts.public_id });
  if (inserted.length === 0) return 0;
  const activityByPublicId = new Map(rows.map((row) => [row.contact.public_id, row.activity]));
  await database
    .insert(contact_activities)
    .values(
      inserted.map((contact) => ({
        contact_id: contact.id,
        organization_id: organization.id,
        channel_account_id: account.id,
        ...activityByPublicId.get(contact.public_id),
        last_message_received_at:
          activityByPublicId.get(contact.public_id)?.last_message_received_at ?? now,
      })),
    )
    .onConflictDoNothing();
  // The account's tag counts recomputed from its live contacts (S7) — a re-run writes the same.
  await database.execute(sql`
    INSERT INTO app.contact_tag_counts (organization_id, channel_account_id, tag, contact_count)
    SELECT ${organization.id}, ${account.id}, tag, count(*)::integer
    FROM app.contacts, unnest(tags) AS tag
    WHERE organization_id = ${organization.id}
      AND channel_account_id = ${account.id}
      AND deleted_at IS NULL
    GROUP BY tag
    ON CONFLICT (organization_id, channel_account_id, tag)
    DO UPDATE SET contact_count = excluded.contact_count`);
  return inserted.length;
}

/**
 * Seeds the contacts of every registry organization's live Instagram account.
 *
 * @remarks
 * Parents read: `context.registry.organizations` — the tenancy seeder's bulk team organizations —
 * and each one's live `app.channel_accounts` row, which the Instagram account seeder wrote just
 * before (the app domain composes the contact contribution after it). Algorithm: per organization,
 * read its oldest live Instagram channel account (none → skip), then insert
 * `SEEDED_CONTACTS_PER_ACCOUNT` contacts with `ON CONFLICT DO NOTHING`, an activity row for each one
 * inserted, and the account's tag counts recomputed. Side effects: inserts into `app.contacts`,
 * `app.contact_activities` and `app.contact_tag_counts`. Failure modes: warns and
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
