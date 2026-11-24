/**
 * Automation-run bulk seeder — gives every demo team organization's automations a few runs for its
 * contacts (`app.automation_runs`), each with its status history (`app.automation_run_events`), and
 * the comment logs of the comment runs (`app.automation_comment_logs`) — routes-final § 3.B.3,
 * AUC14: a run in every status (`running`, `waiting`, `completed`, `failed`, `cancelled`), an
 * answered comment, a skipped public reply and a failed step with Instagram's error.
 *
 * Idempotency: count-and-resume — an organization that already has a run is skipped, so a re-run
 * writes nothing twice. No reference data: runs are tenant rows only.
 */
import { and, asc, count, eq, isNull, ne } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import { automation_runs } from '@/domains/app/sub-domains/automation/automation-run/automation-run.schema.js';
import { automation_run_events } from '@/domains/app/sub-domains/automation/automation-run/automation-run-event.schema.js';
import { automation_comment_logs } from '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { MILLISECONDS_PER_DAY, MILLISECONDS_PER_HOUR } from '@/shared/constants/ttl.constants.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';

/** A seeded run before the ids every row shares. */
type SeededRunShape = Omit<
  typeof automation_runs.$inferInsert,
  'public_id' | 'organization_id' | 'automation_id' | 'contact_id'
>;

/** A digits-only Instagram id for a seeded comment or post, unique per organization and slot. */
function seededInstagramId({
  organizationId,
  slot,
}: {
  organizationId: number;
  slot: number;
}): string {
  return `6${String(organizationId).padStart(12, '0')}${String(slot).padStart(3, '0')}`;
}

/** The status history a seeded run of `status` went through (AU23). */
function statusHistory(status: string): string[] {
  switch (status) {
    case 'running':
      return ['running'];
    case 'waiting':
      return ['running', 'waiting'];
    default:
      return ['running', status];
  }
}

/** The demo runs of one organization: one per status, the open ones on distinct pairs (AU17). */
function buildSeededRuns({
  organizationId,
  now,
}: {
  organizationId: number;
  now: number;
}): SeededRunShape[] {
  const hoursAgo = (hourCount: number) => new Date(now - hourCount * MILLISECONDS_PER_HOUR);
  const daysAgo = (dayCount: number) => new Date(now - dayCount * MILLISECONDS_PER_DAY);
  const comment = (slot: number) => ({
    trigger_type: 'comment',
    trigger_instagram_media_id: seededInstagramId({ organizationId, slot: 0 }),
    trigger_instagram_comment_id: seededInstagramId({ organizationId, slot }),
    trigger_text: 'link please',
    last_instagram_event_key: `comment:${seededInstagramId({ organizationId, slot })}`,
  });
  return [
    {
      ...comment(1),
      status: 'completed',
      current_step: 'final_dm',
      started_at: daysAgo(3),
      completed_at: daysAgo(3),
    },
    {
      ...comment(2),
      status: 'waiting',
      current_step: 'comment_reply',
      waiting_for: 'opening_message_button',
      started_at: hoursAgo(2),
      waiting_since_at: hoursAgo(2),
    },
    {
      ...comment(3),
      status: 'failed',
      current_step: 'comment_reply',
      error_message: 'instagram_api:10/2534022',
      started_at: daysAgo(1),
      failed_at: daysAgo(1),
    },
    {
      trigger_type: 'dm',
      trigger_text: 'catalog',
      last_instagram_event_key: `message:seed-${organizationId}-dm`,
      status: 'waiting',
      current_step: 'email_collect',
      waiting_for: 'email',
      started_at: hoursAgo(5),
      waiting_since_at: hoursAgo(5),
    },
    {
      trigger_type: 'dm',
      trigger_text: 'catalog',
      last_instagram_event_key: `message:seed-${organizationId}-cancelled`,
      status: 'cancelled',
      current_step: 'email_collect',
      cancel_reason: 'wait_expired',
      started_at: daysAgo(10),
      cancelled_at: daysAgo(3),
    },
    {
      trigger_type: 'story_reply',
      trigger_instagram_story_id: seededInstagramId({ organizationId, slot: 9 }),
      trigger_text: 'love it',
      last_instagram_event_key: `message:seed-${organizationId}-story`,
      status: 'running',
      current_step: 'follow_check',
      started_at: hoursAgo(1),
    },
  ];
}

/** The comment log of a seeded comment run (AU24) — its steps as the run left them. */
function seededCommentLog({
  run,
  automationName,
}: {
  run: typeof automation_runs.$inferSelect;
  automationName: string;
}): typeof automation_comment_logs.$inferInsert {
  const base = {
    public_id: generatePublicId('automationCommentLog'),
    organization_id: run.organization_id,
    automation_id: run.automation_id,
    automation_name: automationName,
    automation_run_id: run.id,
    contact_id: run.contact_id,
    instagram_media_id: run.trigger_instagram_media_id ?? '0',
    instagram_comment_id: run.trigger_instagram_comment_id ?? '0',
    comment_text: run.trigger_text,
    created_at: run.started_at,
    updated_at: run.started_at,
  };
  switch (run.status) {
    case 'completed':
      return {
        ...base,
        public_reply_status: 'sent',
        public_reply_text: 'Check your DMs!',
        public_reply_at: run.started_at,
        opening_dm_status: 'done',
        opening_dm_at: run.started_at,
        button_clicked_at: run.started_at,
        final_dm_status: 'sent',
        final_dm_at: run.completed_at,
        overall_status: 'completed',
        current_step: 'final_dm',
      };
    case 'waiting':
      return {
        ...base,
        public_reply_status: 'skipped',
        public_reply_skip_reason: 'random',
        opening_dm_status: 'waiting',
        opening_dm_at: run.started_at,
        overall_status: 'waiting',
        current_step: 'opening_dm',
        waiting_for: 'opening_message_button',
      };
    default:
      return {
        ...base,
        opening_dm_status: 'failed',
        overall_status: 'failed',
        current_step: 'opening_dm',
        failed_step: 'opening_dm',
        error_type: 'instagram_api',
        http_status: 400,
        error_code: 10,
        error_subcode: 2534022,
        error_message: 'instagram_api:10/2534022',
        error_reason: 'refused',
        error_at: run.failed_at,
      };
  }
}

/** Seeds one organization's runs, their events and comment logs; returns how many runs. */
async function seedRunsForOrganization(organization: SeededOrg): Promise<number> {
  const database = getRequestDatabase();
  const [existing] = await database
    .select({ total: count() })
    .from(automation_runs)
    .where(eq(automation_runs.organization_id, organization.id));
  if ((existing?.total ?? 0) > 0) return 0;
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
  if (account === undefined) return 0;
  const [automation] = await database
    .select({ id: automations.id, name: automations.name })
    .from(automations)
    .where(
      and(
        eq(automations.organization_id, organization.id),
        eq(automations.instagram_account_id, account.id),
        isNull(automations.deleted_at),
      ),
    )
    .orderBy(asc(automations.id))
    .limit(1);
  const contactRows = await database
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.organization_id, organization.id),
        eq(contacts.instagram_account_id, account.id),
        isNull(contacts.deleted_at),
      ),
    )
    .orderBy(asc(contacts.id))
    .limit(6);
  if (automation === undefined || contactRows.length === 0) return 0;

  // One automation, one contact per run: every open run is its own automation × contact pair.
  const shapes = buildSeededRuns({ organizationId: organization.id, now: Date.now() }).slice(
    0,
    contactRows.length,
  );
  const runs = await database
    .insert(automation_runs)
    .values(
      shapes.map((shape, index) => ({
        ...shape,
        public_id: generatePublicId('automationRun'),
        organization_id: organization.id,
        automation_id: automation.id,
        contact_id: (contactRows[index] as { id: number }).id,
      })),
    )
    .returning();
  await database.insert(automation_run_events).values(
    runs.flatMap((run) =>
      statusHistory(run.status).map((status) => ({
        organization_id: organization.id,
        automation_run_id: run.id,
        event_type: 'status_changed',
        status,
        created_at: run.started_at,
      })),
    ),
  );
  const commentRuns = runs.filter((run) => run.trigger_type === 'comment');
  if (commentRuns.length > 0) {
    await database
      .insert(automation_comment_logs)
      .values(commentRuns.map((run) => seededCommentLog({ run, automationName: automation.name })));
  }
  return runs.length;
}

/**
 * Seeds the runs of every registry organization's first automation.
 *
 * @remarks
 * Parents read: `context.registry.organizations` — the tenancy seeder's bulk team organizations —
 * each one's live `app.instagram_accounts` row, its first automation (`app.automations`) and its
 * first contacts (`app.contacts`), which the contact and automation seeders wrote just before (the
 * automation contribution composes this one after its own). Algorithm: per organization, skip when
 * it already has runs or lacks an automation or a contact; then one run per status — each on its
 * own contact, so no two open runs share an automation × contact pair (AU17) — with its status
 * events and, for the comment runs, a comment log. Side effects: inserts into the three tables.
 * Failure modes: warns and returns early when the registry has no organizations; otherwise
 * propagates database errors.
 */
export async function seedAutomationRunsBulk(context: SeedContext): Promise<void> {
  const organizations = context.registry.organizations;
  if (organizations.length === 0) {
    context.logger.warn(
      'seed.bulk.automation_run: empty organization pool; run the tenancy seeder first',
    );
    return;
  }
  let created = 0;
  for (const organization of organizations) {
    created += await seedRunsForOrganization(organization);
  }
  context.logger.info(
    { organizations: organizations.length, created },
    'seed.bulk.automation_run: automation runs seeded',
  );
}
