/**
 * Broadcast bulk seeder — gives every demo team organization's live channel account three
 * broadcasts (`app.broadcasts`, routes-final § 7.A, BCC5): a draft on its first saved segment, a
 * done one with its copy of the conditions and its numbers, and a cancelled one.
 *
 * Idempotency: each broadcast's public id is derived from the organization id and its index (zeros
 * and digits, never a generated id), so a re-run hits the unique public id and every insert is
 * `ON CONFLICT DO NOTHING`. No reference data: broadcasts are tenant rows only.
 */
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { segments } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.schema.js';
import { broadcasts } from '@/domains/app/sub-domains/broadcast/broadcast.schema.js';
import { PUBLIC_ID_LENGTH, PUBLIC_ID_PREFIXES } from '@/shared/utils/identity/public-id.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';

/** One text message — the seeded broadcasts' message list. */
const SEEDED_MESSAGES = [
  { kind: 'text' as const, wait_minutes: 0, text: 'Our winter drop is live — 20% off today.' },
];

/** A seeded broadcast's public id: digits from the organization id and the index. */
function seededBroadcastPublicId({
  organizationId,
  index,
}: {
  organizationId: number;
  index: number;
}): string {
  const core = `${String(organizationId)}${String(index).padStart(3, '0')}`;
  return `${PUBLIC_ID_PREFIXES.broadcast}_${core.padStart(PUBLIC_ID_LENGTH, '0')}`;
}

/** Seeds one organization's broadcasts; returns how many were written. */
async function seedBroadcastsForOrganization(organization: SeededOrg): Promise<number> {
  const database = getRequestDatabase();
  const [account] = await database
    .select({ id: channel_accounts.id, channel: channel_accounts.channel })
    .from(channel_accounts)
    .where(
      and(
        eq(channel_accounts.organization_id, organization.id),
        ne(channel_accounts.connection_status, 'revoked'),
      ),
    )
    .orderBy(channel_accounts.id)
    .limit(1);
  if (account === undefined) return 0;
  const [segment] = await database
    .select({ id: segments.id, conditions: segments.conditions })
    .from(segments)
    .where(
      and(
        eq(segments.organization_id, organization.id),
        eq(segments.channel_account_id, account.id),
        isNull(segments.deleted_at),
      ),
    )
    .orderBy(asc(segments.id))
    .limit(1);
  const conditions = segment?.conditions ?? {
    op: 'and' as const,
    items: [{ field: 'details' as const, has: 'email' as const }],
  };
  const now = Date.now();
  const base = {
    organization_id: organization.id,
    channel_account_id: account.id,
    channel: account.channel,
    messages: SEEDED_MESSAGES,
  };
  const inserted = await database
    .insert(broadcasts)
    .values([
      {
        ...base,
        public_id: seededBroadcastPublicId({ organizationId: organization.id, index: 0 }),
        name: 'Winter drop (draft)',
        segment_id: segment?.id ?? null,
        conditions: segment === undefined ? conditions : null,
      },
      {
        ...base,
        public_id: seededBroadcastPublicId({ organizationId: organization.id, index: 1 }),
        name: 'Black Friday',
        status: 'done',
        mode: 'now',
        segment_id: segment?.id ?? null,
        conditions,
        started_at: new Date(now - 3 * MILLISECONDS_PER_DAY),
        finished_at: new Date(now - 3 * MILLISECONDS_PER_DAY + 3_600_000),
        matched: 40,
        sent: 36,
        skipped: 3,
        failed: 1,
        replies: 9,
        taps: 4,
      },
      {
        ...base,
        public_id: seededBroadcastPublicId({ organizationId: organization.id, index: 2 }),
        name: 'Restock alert',
        status: 'cancelled',
        mode: 'scheduled',
        conditions,
        scheduled_at: new Date(now + 2 * MILLISECONDS_PER_DAY),
        cancelled_at: new Date(now - MILLISECONDS_PER_DAY),
        cancel_reason: 'owner',
      },
    ])
    .onConflictDoNothing()
    .returning({ id: broadcasts.id });
  return inserted.length;
}

/**
 * Seeds the broadcasts of every registry organization's live channel account.
 *
 * @remarks
 * Parents read: `context.registry.organizations`, each one's oldest live `app.channel_accounts` row
 * and its first live `app.segments` row (the segment seeder wrote it before). Algorithm: per
 * organization, the account (none → skip), its segment (none → one-off conditions), then the three
 * broadcasts with `ON CONFLICT DO NOTHING`. Side effects: inserts into `app.broadcasts`. Failure
 * modes: warns and returns early when the registry has no organizations; otherwise propagates
 * database errors.
 */
export async function seedBroadcastsBulk(context: SeedContext): Promise<void> {
  const organizations = context.registry.organizations;
  if (organizations.length === 0) {
    context.logger.warn(
      'seed.bulk.broadcast: empty organization pool; run the tenancy seeder first',
    );
    return;
  }
  let created = 0;
  for (const organization of organizations) {
    created += await seedBroadcastsForOrganization(organization);
  }
  context.logger.info(
    { organizations: organizations.length, created },
    'seed.bulk.broadcast: broadcasts seeded',
  );
}
