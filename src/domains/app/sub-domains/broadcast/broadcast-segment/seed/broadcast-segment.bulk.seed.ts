/**
 * Segment bulk seeder — gives every demo team organization's live channel account three saved
 * segments (`app.segments`, routes-final § 7.B, BCC5): one tag condition, one group of two levels,
 * and one deleted segment so the purge (R50) has a row to find.
 *
 * Idempotency: each segment's public id is derived from the organization id and its index (zeros
 * and digits, never a generated id), so a re-run hits the unique public id and every insert is
 * `ON CONFLICT DO NOTHING`. No reference data: segments are tenant rows only.
 */
import { and, eq, ne } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { segments } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.schema.js';
import type { SegmentConditions } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';
import { PUBLIC_ID_LENGTH, PUBLIC_ID_PREFIXES } from '@/shared/utils/identity/public-id.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';

/** The seeded segments of one account: name, conditions and whether it is deleted. */
const SEEDED_SEGMENTS: readonly {
  name: string;
  conditions: SegmentConditions;
  isDeleted: boolean;
}[] = [
  {
    name: 'VIPs',
    conditions: { op: 'and', items: [{ field: 'tags', match: 'any', values: ['vip'] }] },
    isDeleted: false,
  },
  {
    name: 'Engaged this week with an email or phone',
    conditions: {
      op: 'and',
      items: [
        { field: 'active', last_message_within_days: 7 },
        {
          op: 'or',
          items: [
            { field: 'details', has: 'email' },
            { field: 'details', has: 'phone' },
          ],
        },
      ],
    },
    isDeleted: false,
  },
  {
    name: 'Old giveaway list',
    conditions: { op: 'and', items: [{ field: 'tags', match: 'all', values: ['giveaway'] }] },
    isDeleted: true,
  },
];

/** A seeded segment's public id: digits from the organization id and the index. */
function seededSegmentPublicId({
  organizationId,
  index,
}: {
  organizationId: number;
  index: number;
}): string {
  const core = `${String(organizationId)}${String(index).padStart(3, '0')}`;
  return `${PUBLIC_ID_PREFIXES.segment}_${core.padStart(PUBLIC_ID_LENGTH, '0')}`;
}

/** Seeds one organization's segments; returns how many were written. */
async function seedSegmentsForOrganization(organization: SeededOrg): Promise<number> {
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
  const deletedAt = new Date(Date.now() - 10 * MILLISECONDS_PER_DAY);
  const inserted = await database
    .insert(segments)
    .values(
      SEEDED_SEGMENTS.map((segment, index) => ({
        public_id: seededSegmentPublicId({ organizationId: organization.id, index }),
        organization_id: organization.id,
        channel_account_id: account.id,
        channel: account.channel,
        name: segment.name,
        conditions: segment.conditions,
        deleted_at: segment.isDeleted ? deletedAt : null,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: segments.id });
  return inserted.length;
}

/**
 * Seeds the segments of every registry organization's live channel account.
 *
 * @remarks
 * Parents read: `context.registry.organizations` and each one's oldest live `app.channel_accounts`
 * row (the channel account seeder wrote it before). Algorithm: per organization, the account (none
 * → skip), then the three segments with `ON CONFLICT DO NOTHING`. Side effects: inserts into
 * `app.segments`. Failure modes: warns and returns early when the registry has no organizations;
 * otherwise propagates database errors.
 */
export async function seedSegmentsBulk(context: SeedContext): Promise<void> {
  const organizations = context.registry.organizations;
  if (organizations.length === 0) {
    context.logger.warn('seed.bulk.segment: empty organization pool; run the tenancy seeder first');
    return;
  }
  let created = 0;
  for (const organization of organizations) {
    created += await seedSegmentsForOrganization(organization);
  }
  context.logger.info(
    { organizations: organizations.length, created },
    'seed.bulk.segment: segments seeded',
  );
}
