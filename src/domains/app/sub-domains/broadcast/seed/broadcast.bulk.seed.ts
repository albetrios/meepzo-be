/**
 * Broadcast bulk seeder — gives every demo team organization's live channel account three
 * broadcasts (`app.broadcasts`, routes-final § 7.A, BCC5): a draft on its first saved segment, a
 * done one with its copy of the conditions, its recipients (`app.broadcast_recipients`, § 7.C —
 * up to 40 of the account's live contacts, mostly `sent`, some `skipped` and `failed`) and the
 * numbers they make, and a cancelled one.
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
import { broadcast_recipients } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { PUBLIC_ID_LENGTH, PUBLIC_ID_PREFIXES } from '@/shared/utils/identity/public-id.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';

/** One text message — the seeded broadcasts' message list. */
const SEEDED_MESSAGES = [
  { kind: 'text' as const, wait_minutes: 0, text: 'Our winter drop is live — 20% off today.' },
];

/** The most recipients the done broadcast gets. */
const SEEDED_RECIPIENT_LIMIT = 40;

/** A seeded recipient's status and reason by its place: every 10th skipped, every 13th failed. */
function seededRecipientResult(index: number): {
  status: 'sent' | 'skipped' | 'failed';
  reason: string | null;
} {
  if (index % 13 === 12) return { status: 'failed', reason: 'person_error' };
  if (index % 10 === 9) return { status: 'skipped', reason: 'recent_broadcast' };
  return { status: 'sent', reason: null };
}

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

/** The done broadcast's recipients: up to 40 of the account's live contacts, by place. */
async function seededRecipientRows({
  organizationId,
  channelAccountId,
  startedAt,
}: {
  organizationId: number;
  channelAccountId: number;
  startedAt: Date;
}) {
  const database = getRequestDatabase();
  const recipientContacts = await database
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.organization_id, organizationId),
        eq(contacts.channel_account_id, channelAccountId),
        isNull(contacts.deleted_at),
      ),
    )
    .orderBy(asc(contacts.id))
    .limit(SEEDED_RECIPIENT_LIMIT);
  return recipientContacts.map((contact, index) => {
    const { status, reason } = seededRecipientResult(index);
    const sentAt = status === 'sent' ? new Date(startedAt.getTime() + index * 6_000) : null;
    return {
      organization_id: organizationId,
      channel_account_id: channelAccountId,
      contact_id: contact.id,
      status,
      reason,
      sent_at: sentAt,
      replied_at: sentAt !== null && index % 4 === 0 ? new Date(sentAt.getTime() + 600_000) : null,
      created_at: startedAt,
      updated_at: startedAt,
    };
  });
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
  const startedAt = new Date(now - 3 * MILLISECONDS_PER_DAY);
  const recipientRows = await seededRecipientRows({
    organizationId: organization.id,
    channelAccountId: account.id,
    startedAt,
  });
  const countOf = (status: string) => recipientRows.filter((row) => row.status === status).length;
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
        started_at: startedAt,
        finished_at: new Date(startedAt.getTime() + 3_600_000),
        matched: recipientRows.length,
        sent: countOf('sent'),
        skipped: countOf('skipped'),
        failed: countOf('failed'),
        replies: recipientRows.filter((row) => row.replied_at !== null).length,
        taps: Math.min(4, countOf('sent')),
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
    .returning({ id: broadcasts.id, status: broadcasts.status });
  const done = inserted.find((row) => row.status === 'done');
  if (done !== undefined && recipientRows.length > 0) {
    await database
      .insert(broadcast_recipients)
      .values(recipientRows.map((row) => ({ ...row, broadcast_id: done.id })))
      .onConflictDoNothing();
  }
  return inserted.length;
}

/**
 * Seeds the broadcasts of every registry organization's live channel account.
 *
 * @remarks
 * Parents read: `context.registry.organizations`, each one's oldest live `app.channel_accounts` row,
 * its first live `app.segments` row (the segment seeder wrote it before) and up to 40 of its live
 * contacts (the contact seeder wrote them before). Algorithm: per organization, the account (none → skip), its segment (none → one-off conditions), then the three
 * broadcasts with `ON CONFLICT DO NOTHING`, then — only when the done one was new — its recipients.
 * Side effects: inserts into `app.broadcasts` and `app.broadcast_recipients`. Failure
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
