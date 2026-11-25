import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { broadcasts } from '@/domains/app/sub-domains/broadcast/broadcast.schema.js';
import { segments } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.schema.js';
import { broadcast_recipients } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { instagram_attachments } from '@/domains/app/sub-domains/instagram-sending/instagram-attachment/instagram-attachment.schema.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { contact_tag_events } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.schema.js';
import { instagram_send_stops } from '@/domains/app/sub-domains/instagram-sending/instagram-send-stop.schema.js';
import { message_month_counts } from '@/domains/app/sub-domains/instagram-sending/message-month-count.schema.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { runAppTableCleanUpJob } from '@/domains/app/workers/app-table-clean-up.processor.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The hourly batch clean-up of the plain app tables against the database (feat-instagram-dm-sending
 * WC-53, WC-54, WC-62; routes-final § 7 BCC3, § 7.C BCC9; P75, P92): deleted broadcasts and
 * segments 90 days after their delete (a broadcast with its recipients; a segment only once no
 * live broadcast points at it), recipients and ended stops after 90 days, tag events after 8 days,
 * month counts after 13 months; contacts never by age (AC-18.4); each table's oldest-row gauge;
 * a second run changes nothing (BCC3, BCC9). Runs under the retention context.
 */

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

describe('runAppTableCleanUpJob (database)', () => {
  let now: Date;
  let organizationId: number;
  let channelAccountId: number;
  let contactId: number;

  function daysBefore(days: number): Date {
    return new Date(now.getTime() - days * DAY_MILLISECONDS);
  }

  /** The 1st of the month `months` back (UTC), `YYYY-MM-DD`. */
  function monthStartBefore(months: number): string {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
    return month.toISOString().slice(0, 10);
  }

  async function insertSegment(deletedAt: Date | null): Promise<number> {
    const [row] = await getOperatorDatabase()
      .insert(segments)
      .values({
        public_id: generatePublicId('segment'),
        organization_id: organizationId,
        channel_account_id: channelAccountId,
        name: 'Leads',
        conditions: { op: 'and', items: [{ field: 'tags', match: 'any', values: ['lead'] }] },
        created_at: daysBefore(200),
        updated_at: daysBefore(200),
        deleted_at: deletedAt,
      })
      .returning({ id: segments.id });
    return row!.id;
  }

  async function insertBroadcast({
    deletedAt,
    segmentId = null,
  }: {
    deletedAt: Date | null;
    segmentId?: number | null;
  }): Promise<number> {
    const [row] = await getOperatorDatabase()
      .insert(broadcasts)
      .values({
        public_id: generatePublicId('broadcast'),
        organization_id: organizationId,
        channel_account_id: channelAccountId,
        name: 'Drop',
        status: 'draft',
        mode: 'now',
        segment_id: segmentId,
        messages: [{ kind: 'text' as const, wait_minutes: 0, text: 'Hello' }],
        created_at: daysBefore(200),
        updated_at: daysBefore(200),
        deleted_at: deletedAt,
      })
      .returning({ id: broadcasts.id });
    return row!.id;
  }

  async function insertRecipient({
    broadcastId,
    createdAt,
  }: {
    broadcastId: number;
    createdAt: Date;
  }): Promise<number> {
    const contact = await insertContact({ organizationId, instagramAccountId });
    const [row] = await getOperatorDatabase()
      .insert(broadcast_recipients)
      .values({
        organization_id: organizationId,
        channel_account_id: channelAccountId,
        broadcast_id: broadcastId,
        contact_id: contact.id,
        created_at: createdAt,
        updated_at: createdAt,
      })
      .returning({ id: broadcast_recipients.id });
    return row!.id;
  }

  async function insertStop({
    startedAt,
    isEnded,
  }: {
    startedAt: Date;
    isEnded: boolean;
  }): Promise<number> {
    const [row] = await getOperatorDatabase()
      .insert(instagram_send_stops)
      .values({
        organization_id: organizationId,
        channel_account_id: channelAccountId,
        lane: 'slow',
        reason: 'too_fast',
        started_at: startedAt,
        ...(isEnded ? { ended_at: new Date(startedAt.getTime() + 60_000), ended_by: 'time' } : {}),
      })
      .returning({ id: instagram_send_stops.id });
    return row!.id;
  }

  async function insertTagEvent(createdAt: Date): Promise<number> {
    const [row] = await getOperatorDatabase()
      .insert(contact_tag_events)
      .values({
        organization_id: organizationId,
        channel_account_id: channelAccountId,
        contact_id: contactId,
        tag: 'lead',
        kind: 'added',
        source: 'owner',
        created_at: createdAt,
      })
      .returning({ id: contact_tag_events.id });
    return row!.id;
  }

  let instagramAccountId: number;

  beforeEach(async () => {
    await cleanupDatabase();
    now = new Date();
    const organization = await createTestOrganization({
      ownerUserId: (await createTestUser({ email: 'app-table-clean-up@example.com' })).id,
    });
    organizationId = organization.id;
    const account = await insertInstagramAccount({ organizationId });
    channelAccountId = account.channel_account_id;
    instagramAccountId = account.id;
    contactId = (
      await insertContact({ organizationId, instagramAccountId, created_at: daysBefore(400) })
    ).id;
  });

  async function idsOf(table: typeof broadcasts | typeof segments): Promise<number[]> {
    const rows = await getOperatorDatabase()
      .select({ id: table.id })
      .from(table)
      .where(eq(table.organization_id, organizationId))
      .orderBy(asc(table.id));
    return rows.map((row) => row.id);
  }

  it('purges deleted broadcasts and segments after 90 days — a broadcast with its recipients, a segment only once no live broadcast points at it (AC-9.13, AC-18.9)', async () => {
    await insertSegment(daysBefore(91));
    const segmentOfLiveBroadcast = await insertSegment(daysBefore(91));
    const segmentOfPurgedBroadcast = await insertSegment(daysBefore(91));
    const youngSegment = await insertSegment(daysBefore(80));
    const liveSegment = await insertSegment(null);
    const purgedBroadcast = await insertBroadcast({
      deletedAt: daysBefore(91),
      segmentId: segmentOfPurgedBroadcast,
    });
    const youngBroadcast = await insertBroadcast({ deletedAt: daysBefore(80) });
    const liveBroadcast = await insertBroadcast({
      deletedAt: null,
      segmentId: segmentOfLiveBroadcast,
    });
    const recipientOfPurged = await insertRecipient({
      broadcastId: purgedBroadcast,
      createdAt: daysBefore(10),
    });

    const reports = await runAppTableCleanUpJob({ now });

    const deletedBy = Object.fromEntries(
      reports.map((report) => [report.table, report.deletedCount]),
    );
    expect(deletedBy).toMatchObject({ 'app.broadcasts': 1, 'app.segments': 2 });
    expect(await idsOf(broadcasts)).toEqual([youngBroadcast, liveBroadcast]);
    expect(await idsOf(segments)).toEqual([segmentOfLiveBroadcast, youngSegment, liveSegment]);
    const recipients = await getOperatorDatabase()
      .select({ id: broadcast_recipients.id })
      .from(broadcast_recipients)
      .where(eq(broadcast_recipients.id, recipientOfPurged));
    expect(recipients).toEqual([]);
    // A segment a live broadcast points at is not due yet, so it does not count as behind.
    const segmentReport = reports.find((report) => report.table === 'app.segments');
    expect(segmentReport?.oldestOverdueSeconds).toBe(0);
  });

  it('deletes recipients and ended stops after 90 days, tag events after 8 days and month counts after 13 months; keeps contacts whatever their age (AC-18.4, AC-18.7)', async () => {
    const liveBroadcast = await insertBroadcast({ deletedAt: null });
    const oldRecipient = await insertRecipient({
      broadcastId: liveBroadcast,
      createdAt: daysBefore(91),
    });
    const newRecipient = await insertRecipient({
      broadcastId: liveBroadcast,
      createdAt: daysBefore(89),
    });
    const oldEndedStop = await insertStop({ startedAt: daysBefore(91), isEnded: true });
    const oldOpenStop = await insertStop({ startedAt: daysBefore(91), isEnded: false });
    const newEndedStop = await insertStop({ startedAt: daysBefore(10), isEnded: true });
    const oldTagEvent = await insertTagEvent(daysBefore(9));
    const newTagEvent = await insertTagEvent(daysBefore(7));
    await getOperatorDatabase()
      .insert(message_month_counts)
      .values([
        { organization_id: organizationId, month_start: monthStartBefore(14), slot: 0, count: 3 },
        { organization_id: organizationId, month_start: monthStartBefore(14), slot: 1, count: 4 },
        { organization_id: organizationId, month_start: monthStartBefore(12), slot: 0, count: 5 },
      ]);

    const reports = await runAppTableCleanUpJob({ now });

    expect(
      reports.map(({ table, deletedCount, stoppedBy, oldestOverdueSeconds }) => ({
        table,
        deletedCount,
        stoppedBy,
        oldestOverdueSeconds,
      })),
    ).toEqual([
      { table: 'app.broadcasts', deletedCount: 0, stoppedBy: 'done', oldestOverdueSeconds: 0 },
      { table: 'app.segments', deletedCount: 0, stoppedBy: 'done', oldestOverdueSeconds: 0 },
      {
        table: 'app.broadcast_recipients',
        deletedCount: 1,
        stoppedBy: 'done',
        oldestOverdueSeconds: 0,
      },
      {
        table: 'app.instagram_send_stops',
        deletedCount: 1,
        stoppedBy: 'done',
        oldestOverdueSeconds: 0,
      },
      {
        table: 'app.contact_tag_events',
        deletedCount: 1,
        stoppedBy: 'done',
        oldestOverdueSeconds: 0,
      },
      {
        table: 'app.message_month_counts',
        deletedCount: 2,
        stoppedBy: 'done',
        oldestOverdueSeconds: 0,
      },
    ]);
    const database = getOperatorDatabase();
    const recipientIds = (
      await database
        .select({ id: broadcast_recipients.id })
        .from(broadcast_recipients)
        .orderBy(asc(broadcast_recipients.id))
    ).map((row) => row.id);
    expect(recipientIds).toEqual([newRecipient]);
    expect(recipientIds).not.toContain(oldRecipient);
    const stopIds = (
      await database
        .select({ id: instagram_send_stops.id })
        .from(instagram_send_stops)
        .orderBy(asc(instagram_send_stops.id))
    ).map((row) => row.id);
    expect(stopIds).toEqual([oldOpenStop, newEndedStop]);
    expect(stopIds).not.toContain(oldEndedStop);
    const tagEventIds = (
      await database.select({ id: contact_tag_events.id }).from(contact_tag_events)
    ).map((row) => row.id);
    expect(tagEventIds).toEqual([newTagEvent]);
    expect(tagEventIds).not.toContain(oldTagEvent);
    const months = await database
      .select({ monthStart: message_month_counts.month_start })
      .from(message_month_counts);
    expect(months).toEqual([{ monthStart: monthStartBefore(12) }]);
    // A contact made 400 days ago is never removed by age.
    const contactRows = await database
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.id, contactId));
    expect(contactRows).toEqual([{ id: contactId }]);

    const again = await runAppTableCleanUpJob({ now });
    expect(again.every((report) => report.deletedCount === 0)).toBe(true);
  });

  it('deletes the file links a deleted automation alone names a day before its purge is due, unless a live automation of the account uses the file (WC-47, 6.C.10)', async () => {
    const onlyDueSoon = generatePublicId('upload');
    const shared = generatePublicId('upload');
    const ofYoungDelete = generatePublicId('upload');
    const unrelated = generatePublicId('upload');
    const imageSteps = (uploadIds: string[]) => ({
      messages: uploadIds.map((uploadId) => ({ kind: 'image', upload_id: uploadId })),
    });
    // Deleted 179.5 days ago: its purge is due in half a day, so its links go now.
    await insertAutomation({
      organizationId,
      channelAccountId,
      deleted_at: daysBefore(179.5),
      delete_reason: 'not_needed',
      steps: imageSteps([onlyDueSoon, shared]) as never,
    });
    await insertAutomation({
      organizationId,
      channelAccountId,
      deleted_at: daysBefore(100),
      delete_reason: 'not_needed',
      steps: imageSteps([ofYoungDelete]) as never,
    });
    await insertAutomation({
      organizationId,
      channelAccountId,
      steps: imageSteps([shared]) as never,
    });
    await getOperatorDatabase()
      .insert(instagram_attachments)
      .values(
        [onlyDueSoon, shared, ofYoungDelete, unrelated].map((uploadPublicId) => ({
          organization_id: organizationId,
          channel_account_id: channelAccountId,
          upload_public_id: uploadPublicId,
          attachment_id: `meta-${uploadPublicId}`,
        })),
      );

    await runAppTableCleanUpJob({ now });

    const left = await getOperatorDatabase()
      .select({ uploadPublicId: instagram_attachments.upload_public_id })
      .from(instagram_attachments)
      .where(eq(instagram_attachments.organization_id, organizationId));
    expect(left.map((row) => row.uploadPublicId).sort()).toEqual(
      [shared, ofYoungDelete, unrelated].sort(),
    );
  });
});
