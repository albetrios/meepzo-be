/**
 * Automation bulk seeder — gives every demo team organization's connected Instagram account a set
 * of automations (`app.automations`, feat-instagram-dm-sending routes-final § 4.A.3, AUC8): one of
 * each of the 15 ways to start, the comment ones on any post (public replies and "Reply like a
 * person" on), a specific post, a waiting and a linked "next post"; live, draft and paused ones;
 * all-time counts (`app.automation_counts`, slot 0) on the busy ones — so the list's filters, sorts
 * and totals have rows at both ends.
 *
 * Idempotency: count-and-resume — an organization that already has an automation is skipped, so a
 * re-run writes nothing twice. No reference data: automations are tenant rows only.
 */
import { and, asc, count, eq, ne } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import { automation_counts } from '@/domains/app/sub-domains/automation/automation-count.schema.js';
import type { AutomationSteps } from '@/domains/app/sub-domains/automation/automation-steps.dto.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';
import { generateBulkAutomationWords } from './automation.faker.js';

/** A row the seeder inserts, before the ids every row shares. */
type SeededAutomationShape = Omit<
  typeof automations.$inferInsert,
  'public_id' | 'organization_id' | 'channel_account_id'
> & {
  /** All-time runs started the seed writes to slot 0 of `app.automation_counts` (AU19). */
  seededRunsStarted?: number;
  /** Hello taps the seed writes beside them. */
  seededTaps?: number;
};

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

/** The steps of a seeded automation: a hello with its "next step" button and one text message. */
function seededSteps({
  openingText,
  finalText,
  tags,
  isHelloOn,
}: {
  openingText: string;
  finalText: string;
  tags: string[];
  isHelloOn: boolean;
}): AutomationSteps {
  return {
    ...(isHelloOn
      ? {
          hello: {
            on: true,
            versions: [
              { text: openingText, buttons: [{ title: 'Send it', action: 'next' as const }] },
            ],
          },
        }
      : {}),
    messages: [
      {
        kind: 'text',
        wait_minutes: 0,
        text: finalText,
        buttons: [{ title: 'Open the shop', url: 'https://shop.example.com/demo' }],
      },
    ],
    tags: { on: tags.length > 0, list: tags },
  };
}

/**
 * The demo automations of one account (feat-instagram-dm-sending AUC8): one of each of the 15 ways
 * to start — live ones that pass the go-live checks, the untested and PRO-heavy ones as drafts — a
 * paused one, and counts on the live ones.
 */
function buildSeededAutomations({
  context,
  organizationId,
  postId,
}: {
  context: SeedContext;
  organizationId: number;
  /** A seeded digits post id. */
  postId: string;
}): SeededAutomationShape[] {
  const now = Date.now();
  const days = (dayCount: number) => new Date(now + dayCount * MILLISECONDS_PER_DAY);
  const flow = (isHelloOn = true) => {
    const { keywords, tags, openingText, finalText } = generateBulkAutomationWords(context.faker);
    return { keywords, steps: seededSteps({ openingText, finalText, tags, isHelloOn }) };
  };
  return [
    {
      ...flow(),
      name: 'Comment any post for the link',
      status: 'live',
      trigger_type: 'comment',
      also_start_from: ['dm'],
      is_public_reply_enabled: true,
      public_reply_texts: ['Check your DMs!', 'Sent it to you', 'Look in your inbox'],
      is_reply_like_person_enabled: true,
      last_triggered_at: days(-1),
      seededRunsStarted: 37,
      seededTaps: 19,
    },
    {
      ...flow(),
      name: 'Price on the spring post',
      status: 'live',
      trigger_type: 'comment',
      target_scope: 'specific',
      target_instagram_media_id: postId,
      last_triggered_at: days(-3),
      seededRunsStarted: 4,
      seededTaps: 2,
    },
    {
      ...flow(),
      name: 'Next post giveaway',
      status: 'live',
      trigger_type: 'comment',
      target_scope: 'next',
      target_starts_at: days(-1),
      next_post_status: 'waiting',
    },
    {
      ...flow(),
      name: 'Last week next post',
      status: 'paused',
      trigger_type: 'comment',
      target_scope: 'next',
      target_instagram_media_id: seededInstagramId({ organizationId, slot: 1 }),
      target_starts_at: days(-10),
      next_post_status: 'linked',
      next_post_linked_at: days(-8),
      cancelled_before_at: days(-2),
      last_triggered_at: days(-7),
      seededRunsStarted: 12,
      seededTaps: 5,
    },
    ...buildOtherWaysToStart({ flow, organizationId }),
  ];
}

/** The demo automations of the other 14 ways to start: the untested and PRO-heavy ones as drafts. */
function buildOtherWaysToStart({
  flow,
  organizationId,
}: {
  flow: () => Pick<SeededAutomationShape, 'keywords' | 'steps'>;
  organizationId: number;
}): SeededAutomationShape[] {
  return [
    { ...flow(), name: 'Live comment link', status: 'draft', trigger_type: 'live_comment' },
    { ...flow(), name: 'Story replies', status: 'live', trigger_type: 'story_reply', keywords: [] },
    {
      ...flow(),
      name: 'Story mentions',
      status: 'live',
      trigger_type: 'story_mention',
      keywords: [],
    },
    {
      ...flow(),
      name: 'Story reposts',
      status: 'draft',
      trigger_type: 'story_repost',
      keywords: [],
    },
    {
      ...flow(),
      name: 'DM keyword for the catalog',
      status: 'live',
      trigger_type: 'dm_keyword',
      keywords: ['catalog'],
      last_triggered_at: new Date(Date.now() - 2 * MILLISECONDS_PER_DAY),
      seededRunsStarted: 21,
      seededTaps: 14,
    },
    {
      ...flow(),
      name: 'Welcome first message',
      status: 'live',
      trigger_type: 'first_message',
      keywords: [],
    },
    {
      ...flow(),
      name: 'Shared post reply',
      status: 'draft',
      trigger_type: 'shared_post',
      keywords: [],
    },
    {
      ...flow(),
      name: 'Starter questions',
      status: 'draft',
      trigger_type: 'starter_question',
      keywords: [],
      starter_questions: ['How do I join?', 'What does it cost?'],
    },
    {
      ...flow(),
      name: 'Event QR code',
      status: 'live',
      trigger_type: 'ref_link',
      keywords: [],
      ref_code: `event-${organizationId}`,
    },
    {
      ...flow(),
      name: 'Nobody else answered',
      status: 'draft',
      trigger_type: 'default_reply',
      keywords: [],
      default_reply_mode: 'once_a_day',
    },
    {
      ...flow(),
      name: 'Ad comment info',
      status: 'draft',
      trigger_type: 'ad_comment',
      ad_id: seededInstagramId({ organizationId, slot: 3 }),
    },
    {
      ...flow(),
      name: 'Ad send message',
      status: 'draft',
      trigger_type: 'ad_message',
      keywords: [],
      ad_id: seededInstagramId({ organizationId, slot: 4 }),
    },
    {
      ...flow(),
      name: 'VIP tag added',
      status: 'draft',
      trigger_type: 'tag_added',
      keywords: [],
      trigger_tag: 'vip',
    },
    {
      ...flow(),
      name: 'Waitlist tag removed',
      status: 'draft',
      trigger_type: 'tag_removed',
      keywords: [],
      trigger_tag: 'waitlist',
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
    .select({ channelAccountId: channel_accounts.id })
    .from(channel_accounts)
    .where(
      and(
        eq(channel_accounts.organization_id, organization.id),
        ne(channel_accounts.connection_status, 'revoked'),
      ),
    )
    .orderBy(asc(channel_accounts.id))
    .limit(1);
  // No live account: an automation is created on the connected account only (AU27).
  if (account === undefined) return 0;

  const [existing] = await database
    .select({ total: count() })
    .from(automations)
    .where(eq(automations.organization_id, organization.id));
  if ((existing?.total ?? 0) > 0) return 0;

  const rows = buildSeededAutomations({
    context,
    organizationId: organization.id,
    postId: seededInstagramId({ organizationId: organization.id, slot: 0 }),
  });
  const inserted = await database
    .insert(automations)
    .values(
      rows.map(({ seededRunsStarted: _runs, seededTaps: _taps, ...row }) => ({
        ...row,
        public_id: generatePublicId('automation'),
        organization_id: organization.id,
        channel_account_id: account.channelAccountId,
        created_by_user_id: organization.ownerUserId,
        updated_by_user_id: organization.ownerUserId,
      })),
    )
    .returning({ id: automations.id });
  const countRows = inserted.flatMap((automation, index) => {
    const seeded = rows[index];
    if (seeded?.seededRunsStarted === undefined) return [];
    return [
      {
        organization_id: organization.id,
        automation_id: automation.id,
        slot: 0,
        runs_started: seeded.seededRunsStarted,
        taps: seeded.seededTaps ?? 0,
        runs_by_version: { 'hello.1': seeded.seededRunsStarted },
        taps_by_version: { 'hello.1': seeded.seededTaps ?? 0 },
      },
    ];
  });
  if (countRows.length > 0) await database.insert(automation_counts).values(countRows);
  return inserted.length;
}

/**
 * Seeds the automations of every registry organization's live Instagram account.
 *
 * @remarks
 * Parents read: `context.registry.organizations` — the tenancy seeder's bulk team organizations —
 * each one's first not-revoked channel account,
 * which the Instagram account seeder wrote just before (the app domain composes this contribution
 * after it). Algorithm: per organization, read its live account (none → skip), skip when it already
 * has automations, then insert the demo set and its counts. Side effects: inserts into
 * `app.automations` and `app.automation_counts`. Failure
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
