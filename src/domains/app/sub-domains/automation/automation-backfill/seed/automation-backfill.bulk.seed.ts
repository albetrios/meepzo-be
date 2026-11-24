/**
 * Automation-backfill bulk seeder — gives every demo team organization's live comment automations
 * past-comments reads (`app.automation_backfills`, routes-final § 4.C.3) in every status: a `done`
 * read with its numbers and an older `failed` · `meta_error` one on the first, a `reading` one on the
 * second (its open read), a `queued` one on the third — so routes 29 (`open_backfill`) and 39 show
 * each state.
 *
 * Idempotency: count-and-resume — an organization that already has a read is skipped, so a re-run
 * writes nothing twice. No reference data: reads are tenant rows only.
 */
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import { automation_backfills } from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { MILLISECONDS_PER_DAY, MILLISECONDS_PER_HOUR } from '@/shared/constants/ttl.constants.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';

/** A seeded read before the ids every row shares. */
type SeededBackfillShape = Omit<
  typeof automation_backfills.$inferInsert,
  'public_id' | 'organization_id' | 'channel_account_id' | 'automation_id'
>;

/** The reads of the organization's first three live comment automations, by position. */
function buildSeededBackfills({
  now,
  requestedByUserId,
}: {
  now: number;
  requestedByUserId: number;
}): SeededBackfillShape[][] {
  const at = (millisecondsAgo: number) => new Date(now - millisecondsAgo);
  return [
    [
      {
        days: 7,
        status: 'failed',
        fail_reason: 'meta_error',
        last_error: 'meta_error_code:2',
        posts_read: 4,
        found: 120,
        matched: 31,
        queued_count: 30,
        requested_by_user_id: requestedByUserId,
        created_at: at(3 * MILLISECONDS_PER_DAY),
        started_at: at(3 * MILLISECONDS_PER_DAY),
        done_at: at(3 * MILLISECONDS_PER_DAY - MILLISECONDS_PER_HOUR),
        updated_at: at(3 * MILLISECONDS_PER_DAY - MILLISECONDS_PER_HOUR),
      },
      {
        days: 3,
        status: 'done',
        posts_read: 12,
        found: 340,
        matched: 87,
        queued_count: 85,
        requested_by_user_id: requestedByUserId,
        created_at: at(MILLISECONDS_PER_DAY),
        started_at: at(MILLISECONDS_PER_DAY),
        done_at: at(MILLISECONDS_PER_DAY - MILLISECONDS_PER_HOUR),
        updated_at: at(MILLISECONDS_PER_DAY - MILLISECONDS_PER_HOUR),
      },
    ],
    [
      {
        days: 2,
        status: 'reading',
        posts_read: 3,
        found: 56,
        matched: 9,
        queued_count: 9,
        requested_by_user_id: requestedByUserId,
        created_at: at(MILLISECONDS_PER_HOUR),
        started_at: at(MILLISECONDS_PER_HOUR),
        updated_at: at(MILLISECONDS_PER_HOUR / 2),
      },
    ],
    [{ days: 1, status: 'queued', requested_by_user_id: requestedByUserId }],
  ];
}

/** Seeds one organization's reads; returns how many were written. */
async function seedBackfillsForOrganization({
  organization,
}: {
  organization: SeededOrg;
}): Promise<number> {
  const database = getRequestDatabase();
  const [existing] = await database
    .select({ total: count() })
    .from(automation_backfills)
    .where(eq(automation_backfills.organization_id, organization.id));
  if ((existing?.total ?? 0) > 0) return 0;

  const liveCommentAutomations = await database
    .select({ id: automations.id, channelAccountId: automations.channel_account_id })
    .from(automations)
    .where(
      and(
        eq(automations.organization_id, organization.id),
        eq(automations.status, 'live'),
        eq(automations.trigger_type, 'comment'),
        isNull(automations.deleted_at),
      ),
    )
    .orderBy(asc(automations.id))
    .limit(3);
  const shapes = buildSeededBackfills({
    now: Date.now(),
    requestedByUserId: organization.ownerUserId,
  });
  const rows = liveCommentAutomations.flatMap((automation, index) =>
    (shapes[index] ?? []).map((shape) => ({
      ...shape,
      public_id: generatePublicId('automationBackfill'),
      organization_id: organization.id,
      channel_account_id: automation.channelAccountId,
      automation_id: automation.id,
    })),
  );
  if (rows.length === 0) return 0;
  await database.insert(automation_backfills).values(rows);
  return rows.length;
}

/**
 * Seeds the past-comments reads of every registry organization's live comment automations.
 *
 * @remarks
 * Parents read: `context.registry.organizations` and each one's automations, which the automation
 * seeder wrote just before (the automation contribution composes this one after it). Algorithm: per
 * organization, skip when it already has a read, else write the reads of its first three live
 * comment automations. Side effects: inserts into `app.automation_backfills`. Failure modes: warns
 * and returns early when the registry has no organizations; otherwise propagates database errors.
 */
export async function seedAutomationBackfillsBulk(context: SeedContext): Promise<void> {
  const organizations = context.registry.organizations;
  if (organizations.length === 0) {
    context.logger.warn(
      'seed.bulk.automation_backfill: empty organization pool; run the tenancy seeder first',
    );
    return;
  }
  let created = 0;
  for (const organization of organizations) {
    created += await seedBackfillsForOrganization({ organization });
  }
  context.logger.info(
    { organizations: organizations.length, created },
    'seed.bulk.automation_backfill: past-comments reads seeded',
  );
}
