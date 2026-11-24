/**
 * Automation bulk seeder — gives every demo team organization's connected Instagram account a set
 * of automations (`app.automations`) across every trigger and target scope (routes-final § 3.A.3,
 * AUC9): a comment automation on any post (public replies on), one on a specific post, three
 * "next post" ones (waiting, linked, expired), a DM automation collecting emails, and story-reply
 * automations on any and on a specific story — some live, some inactive, some with counters, so the
 * list's filters and sorts have rows at both ends.
 *
 * Idempotency: count-and-resume — an organization that already has an automation is skipped, so a
 * re-run writes nothing twice. No reference data: automations are tenant rows only.
 */
import { and, asc, count, eq, ne } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { instagram_media } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.schema.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';
import { generateBulkAutomationWords } from './automation.faker.js';

/** A row the seeder inserts, before the ids every row shares. */
type SeededAutomationShape = Omit<
  typeof automations.$inferInsert,
  'public_id' | 'organization_id' | 'instagram_account_id'
>;

/** A digits-only Instagram id for a seeded target, unique per organization and slot. */
function seededInstagramId({
  organizationId,
  slot,
}: {
  organizationId: number;
  slot: number;
}): string {
  return `7${String(organizationId).padStart(12, '0')}${String(slot).padStart(3, '0')}`;
}

/** The demo automations of one account: every trigger and scope, live and inactive. */
function buildSeededAutomations({
  context,
  organizationId,
  postId,
}: {
  context: SeedContext;
  organizationId: number;
  /** A stored post of the account, or a seeded digits id. */
  postId: string;
}): SeededAutomationShape[] {
  const now = Date.now();
  const days = (dayCount: number) => new Date(now + dayCount * MILLISECONDS_PER_DAY);
  const words = () => generateBulkAutomationWords(context.faker);
  const commentFlow = () => {
    const { keywords, tags, openingText, finalText } = words();
    return {
      trigger_type: 'comment',
      keywords,
      tags,
      opening_message: { text: openingText, button_title: 'Send it' },
      final_message: {
        text: finalText,
        links: [{ title: 'Open the shop', url: 'https://shop.example.com/demo' }],
      },
    };
  };
  return [
    {
      ...commentFlow(),
      name: 'Comment any post for the link',
      status: 'live',
      is_public_reply_enabled: true,
      public_reply_texts: ['Check your DMs!', 'Sent it to you'],
      completed_run_count: 37,
      last_triggered_at: days(-1),
    },
    {
      ...commentFlow(),
      name: 'Price on the spring post',
      status: 'live',
      target_scope: 'specific',
      target_instagram_media_id: postId,
      is_follow_required: true,
      follow_request_message: {
        text: 'Follow us first, then tap the button.',
        following_button_title: "I'm following",
        profile_button_title: 'Open profile',
      },
      completed_run_count: 4,
      last_triggered_at: days(-3),
    },
    {
      ...commentFlow(),
      name: 'Next post giveaway',
      status: 'live',
      target_scope: 'next',
      next_post_starts_at: days(0),
      next_post_ends_at: days(7),
      next_post_status: 'waiting',
    },
    {
      ...commentFlow(),
      name: 'Last week next post',
      status: 'live',
      target_scope: 'next',
      target_instagram_media_id: seededInstagramId({ organizationId, slot: 1 }),
      next_post_starts_at: days(-10),
      next_post_ends_at: days(-3),
      next_post_status: 'linked',
      next_post_linked_at: days(-8),
      completed_run_count: 12,
      last_triggered_at: days(-7),
    },
    {
      ...commentFlow(),
      name: 'Old next post window',
      status: 'inactive',
      target_scope: 'next',
      next_post_starts_at: days(-30),
      next_post_ends_at: days(-20),
      next_post_status: 'expired',
    },
    {
      tags: words().tags,
      name: 'DM keyword for the catalog',
      status: 'live',
      trigger_type: 'dm',
      keywords: ['catalog'],
      opening_message: { text: 'Hi! One moment, getting the catalog.', button_title: null },
      is_email_collection_enabled: true,
      final_message: { text: 'Here is the catalog.', links: [] },
      completed_run_count: 21,
      last_triggered_at: days(-2),
    },
    {
      name: 'Story replies',
      status: 'inactive',
      trigger_type: 'story_reply',
      keywords: [],
      tags: ['story'],
      is_opening_message_enabled: false,
      final_message: { text: 'Thanks for replying to our story!', links: [] },
    },
    {
      name: 'Story launch reply',
      status: 'live',
      trigger_type: 'story_reply',
      target_scope: 'specific',
      target_instagram_story_id: seededInstagramId({ organizationId, slot: 2 }),
      keywords: ['launch'],
      tags: [],
      opening_message: { text: 'Glad you like it!', button_title: null },
      final_message: { text: 'The launch page is live.', links: [] },
    },
  ];
}

/** Seeds one organization's automations; returns how many were written. */
async function seedAutomationsForOrganization({
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
    .innerJoin(
      channel_accounts,
      and(
        eq(channel_accounts.organization_id, instagram_accounts.organization_id),
        eq(channel_accounts.id, instagram_accounts.channel_account_id),
      ),
    )
    .where(
      and(
        eq(instagram_accounts.organization_id, organization.id),
        ne(channel_accounts.connection_status, 'revoked'),
      ),
    )
    .limit(1);
  // No live account: an automation is created on the connected account only (AU27).
  if (account === undefined) return 0;

  const [existing] = await database
    .select({ total: count() })
    .from(automations)
    .where(eq(automations.organization_id, organization.id));
  if ((existing?.total ?? 0) > 0) return 0;

  const [post] = await database
    .select({ instagram_media_id: instagram_media.instagram_media_id })
    .from(instagram_media)
    .where(
      and(
        eq(instagram_media.organization_id, organization.id),
        eq(instagram_media.instagram_account_id, account.id),
      ),
    )
    .orderBy(asc(instagram_media.id))
    .limit(1);
  const rows = buildSeededAutomations({
    context,
    organizationId: organization.id,
    postId:
      post?.instagram_media_id ?? seededInstagramId({ organizationId: organization.id, slot: 0 }),
  }).map((row) => ({
    ...row,
    public_id: generatePublicId('automation'),
    organization_id: organization.id,
    instagram_account_id: account.id,
    created_by_user_id: organization.ownerUserId,
    updated_by_user_id: organization.ownerUserId,
  }));
  const inserted = await database
    .insert(automations)
    .values(rows)
    .returning({ id: automations.id });
  return inserted.length;
}

/**
 * Seeds the automations of every registry organization's live Instagram account.
 *
 * @remarks
 * Parents read: `context.registry.organizations` — the tenancy seeder's bulk team organizations —
 * each one's live `app.instagram_accounts` row and its first stored post (`app.instagram_media`),
 * which the Instagram account seeder wrote just before (the app domain composes this contribution
 * after it). Algorithm: per organization, read its live account (none → skip), skip when it already
 * has automations, then insert the demo set. Side effects: inserts into `app.automations`. Failure
 * modes: warns and returns early when the registry has no organizations; otherwise propagates
 * database errors.
 */
export async function seedAutomationsBulk(context: SeedContext): Promise<void> {
  const organizations = context.registry.organizations;
  if (organizations.length === 0) {
    context.logger.warn(
      'seed.bulk.automation: empty organization pool; run the tenancy seeder first',
    );
    return;
  }

  let created = 0;
  for (const organization of organizations) {
    created += await seedAutomationsForOrganization({ context, organization });
  }
  context.logger.info(
    { organizations: organizations.length, created },
    'seed.bulk.automation: automations seeded',
  );
}
