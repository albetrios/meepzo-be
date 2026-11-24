/**
 * Instagram sending bulk seeder (feat-instagram-dm-sending § 6.A SNC12): for every not-revoked
 * Instagram channel account of a demo team organization, its four `ready` lanes (as the pick leaves
 * them, MC7), one ended `too_fast` stop in its history (SN13), this minute's `fast` count (gate 2)
 * and a month count for the organization's meter (route 64).
 *
 * Idempotency: lanes and counts are `ON CONFLICT DO NOTHING` on their keys; the stop is written only
 * when the account has no stop history yet.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { instagram_send_lanes } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.schema.js';
import { instagram_send_stops } from '@/domains/app/sub-domains/instagram-sending/instagram-send-stop.schema.js';
import { instagram_send_minute_counts } from '@/domains/app/sub-domains/instagram-sending/instagram-send-minute-count.schema.js';
import { message_month_counts } from '@/domains/app/sub-domains/instagram-sending/message-month-count.schema.js';
import {
  INSTAGRAM_SEND_LANES,
  MESSAGE_MONTH_COUNT_SLOTS,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';

/** Messages a seeded account adds to its organization's month (a meter well under every limit). */
const SEEDED_MONTH_COUNT_PER_ACCOUNT = 120;

/** Messages a seeded account sent this minute (gate 2). */
const SEEDED_MINUTE_COUNT = 3;

/** Seeds one organization's accounts; returns how many accounts got their lanes now. */
async function seedSendingForOrganization(organization: SeededOrg): Promise<number> {
  const database = getRequestDatabase();
  const accounts = await database
    .select({ id: channel_accounts.id })
    .from(channel_accounts)
    .where(
      and(
        eq(channel_accounts.organization_id, organization.id),
        eq(channel_accounts.channel, 'instagram'),
        ne(channel_accounts.connection_status, 'revoked'),
      ),
    );
  let laned = 0;
  for (const account of accounts) {
    const lanes = await database
      .insert(instagram_send_lanes)
      .values(
        INSTAGRAM_SEND_LANES.map((lane) => ({
          organization_id: organization.id,
          channel_account_id: account.id,
          lane,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: instagram_send_lanes.id });
    if (lanes.length > 0) laned += 1;
    const [history] = await database
      .select({ id: instagram_send_stops.id })
      .from(instagram_send_stops)
      .where(
        and(
          eq(instagram_send_stops.organization_id, organization.id),
          eq(instagram_send_stops.channel_account_id, account.id),
        ),
      )
      .limit(1);
    if (history === undefined) {
      await database.insert(instagram_send_stops).values({
        organization_id: organization.id,
        channel_account_id: account.id,
        lane: 'fast',
        reason: 'too_fast',
        error_code: 613,
        started_at: sql`now() - interval '2 hours'`,
        stop_until: sql`now() - interval '105 minutes'`,
        ended_at: sql`now() - interval '105 minutes'`,
        ended_by: 'time',
      });
    }
    await database
      .insert(instagram_send_minute_counts)
      .values({
        organization_id: organization.id,
        channel_account_id: account.id,
        count_group: 'fast',
        minute_start: sql`date_trunc('minute', now())`,
        count: SEEDED_MINUTE_COUNT,
      })
      .onConflictDoNothing();
    await database
      .insert(message_month_counts)
      .values({
        organization_id: organization.id,
        month_start: sql`(SELECT date_trunc('month', now() AT TIME ZONE ${organizations.timezone})::date
          FROM ${organizations} WHERE ${organizations.id} = ${organization.id})`,
        slot: account.id % MESSAGE_MONTH_COUNT_SLOTS,
        count: SEEDED_MONTH_COUNT_PER_ACCOUNT,
      })
      .onConflictDoNothing();
  }
  return laned;
}

/**
 * Seeds the sending rows of every registry organization's Instagram channel accounts.
 *
 * @remarks
 * Parents read: `context.registry.organizations` and the channel accounts the channel account
 * seeder wrote. Algorithm: per organization, per not-revoked Instagram account — the lanes, one
 * ended stop when none, the minute and month counts. Side effects: inserts into the sending
 * tables. Failure modes: warns and returns early when the registry has no organizations; otherwise
 * propagates database errors.
 */
export async function seedInstagramSendingBulk(context: SeedContext): Promise<void> {
  const organizationPool = context.registry.organizations;
  if (organizationPool.length === 0) {
    context.logger.warn(
      'seed.bulk.instagram-sending: empty organization pool; run the tenancy seeder first',
    );
    return;
  }
  let accounts = 0;
  for (const organization of organizationPool) {
    accounts += await seedSendingForOrganization(organization);
  }
  context.logger.info(
    { organizations: organizationPool.length, accounts },
    'seed.bulk.instagram-sending: lanes, stops and counts seeded',
  );
}
