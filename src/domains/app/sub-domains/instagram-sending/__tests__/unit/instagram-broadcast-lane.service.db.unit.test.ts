import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { META_GRAPH_BASE_URL } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { broadcasts } from '@/domains/app/sub-domains/broadcast/broadcast.schema.js';
import { broadcast_recipients } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.schema.js';
import { BroadcastRecipientService } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.service.js';
import { parseBroadcastButtonPayload } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient-button-payload.util.js';
import {
  type ContactFixtureRow,
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { createWorkerContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import { readInstagramMessages } from '@/domains/app/sub-domains/instagram-sending/instagram-message/__tests__/factories/instagram-message.factory.js';
import {
  insertLanes,
  setMonthCount,
} from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import {
  buildLaneHarness,
  type LaneHarness,
  type LaneHarnessAccount,
  readLaneRow,
} from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-lane-harness.factory.js';
import { InstagramBroadcastLaneRules } from '@/domains/app/sub-domains/instagram-sending/instagram-broadcast-lane.service.js';
import { InstagramSendComposeService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-compose.service.js';
import { INSTAGRAM_BROADCAST_TURN_PRIORITY } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase, operatorQuery } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HOUR = 3_600_000;

/**
 * The broadcast lane's rules in the real send core (feat-instagram-dm-sending routes-final § 6.10
 * WC-8, § 6.A.10; plan §30.14, §11.7; P3, D68; ROUTE row R45 — AC-9.10, AC-9.5's lane half): the
 * broadcast message built by the real audience piece (R23) and sent as a normal DM, her window
 * closing soonest first, one per box of the broadcast hour limit, each one DM in the month, the
 * checks again just before each send, her `last_broadcast_at`, message 2 after a `sent` 1, the
 * month limit holding the lane, too fast twice as long. Meta via nock only.
 */
describe('InstagramBroadcastLaneRules (database)', () => {
  let organization: { id: number; public_id: string };
  let account: LaneHarnessAccount;
  let harness: LaneHarness;
  let recipients: BroadcastRecipientService;

  const igUserId = () => `1784${account.channel_account_id}`;
  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id });

  /** A contact tagged `lead` whose chat opened `hoursAgo` hours ago. */
  function lead(
    hoursAgo: number,
    overrides: Partial<ContactFixtureRow> = {},
  ): Promise<ContactFixtureRow> {
    return insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      full_name: 'Riya',
      tags: ['lead'],
      last_direct_message_received_at: new Date(Date.now() - hoursAgo * HOUR),
      ...overrides,
    });
  }

  /** A `sending` broadcast to tag `lead` with `messageCount` text messages (message 2 after 0 min). */
  async function insertBroadcast({ messageCount = 1 }: { messageCount?: number } = {}) {
    const [row] = await getOperatorDatabase()
      .insert(broadcasts)
      .values({
        public_id: generatePublicId('broadcast'),
        organization_id: organization.id,
        channel_account_id: account.channel_account_id,
        name: 'Drop',
        status: 'sending',
        mode: 'now',
        conditions: { op: 'and', items: [{ field: 'tags', match: 'any', values: ['lead'] }] },
        messages: Array.from({ length: messageCount }, (_, index) => ({
          kind: 'quick_replies' as const,
          wait_minutes: 0,
          text: `Hi {name}, drop ${index + 1}`,
          replies: ['Yes'],
        })),
        started_at: new Date(),
      })
      .returning();
    return row!;
  }

  /** The real audience piece (R23): a waiting recipient and message 1 per open chat. */
  async function buildAudience(broadcastPublicId: string): Promise<void> {
    await withAppDatabaseContext({
      scope: scope(),
      callback: (databaseHandle) =>
        recipients.buildAudiencePiece({ databaseHandle, broadcastPublicId, afterContactId: 0 }),
    });
  }

  async function readRecipients(broadcastId: number) {
    return getOperatorDatabase()
      .select()
      .from(broadcast_recipients)
      .where(
        and(
          eq(broadcast_recipients.organization_id, organization.id),
          eq(broadcast_recipients.broadcast_id, broadcastId),
        ),
      )
      .orderBy(broadcast_recipients.contact_id);
  }

  async function readNumbers(broadcastId: number) {
    const [row] = await getOperatorDatabase()
      .select()
      .from(broadcasts)
      .where(eq(broadcasts.id, broadcastId));
    return row!;
  }

  async function monthUsed(): Promise<number> {
    const [row] = await operatorQuery<Array<{ used: number }>>`
      SELECT COALESCE(sum(count), 0)::int AS used FROM app.message_month_counts
      WHERE organization_id = ${organization.id}`;
    return row?.used ?? 0;
  }

  async function lastBroadcastAt(contactId: number): Promise<Date | null> {
    const [row] = await operatorQuery<Array<{ last_broadcast_at: Date | null }>>`
      SELECT last_broadcast_at FROM app.contact_activities
      WHERE organization_id = ${organization.id} AND contact_id = ${contactId}`;
    return row?.last_broadcast_at ?? null;
  }

  /** Frees the broadcast lane's box (the next turn is due now). */
  async function freeTheBox(): Promise<void> {
    await operatorQuery`
      UPDATE app.instagram_send_lanes SET next_run_at = NULL, last_sent_at = NULL
      WHERE channel_account_id = ${account.channel_account_id} AND lane = 'broadcast'`;
  }

  function metaSends(answers: Array<{ status: number; body: object }>, bodies: unknown[] = []) {
    let interceptor = nock(META_GRAPH_BASE_URL);
    for (const answer of answers) {
      interceptor = interceptor
        .post(`/v27.0/${igUserId()}/messages`, (body) => {
          bodies.push(body);
          return true;
        })
        .query(true)
        .reply(answer.status, answer.body);
    }
    return interceptor;
  }

  beforeEach(async () => {
    await cleanupDatabase();
    nock.cleanAll();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    await insertLanes({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
    });
    harness = buildLaneHarness({
      organization,
      account,
      laneRules: (messageService) => ({
        broadcast: new InstagramBroadcastLaneRules({
          messageService,
          composeService: new InstagramSendComposeService(),
          random: () => 0,
        }),
      }),
      messageServiceOptions: {
        recordBroadcastMessageResult: (input) => recipients.recordMessageResult(input),
        recordContactBroadcastSent: ({ databaseHandle, organizationId, contactId, sentAt }) =>
          createWorkerContactRepository(databaseHandle).recordActivity({
            organizationId,
            contactId,
            change: { kind: 'broadcast', at: sentAt },
          }),
      },
    });
    recipients = new BroadcastRecipientService({
      sendingPorts: { instagram: harness.messageService },
    });
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('sends her window closing soonest first as a normal DM with the broadcast payload, one DM in the month, then message 2 (AC-9.10)', async () => {
    const later = await lead(1);
    const soonest = await lead(20);
    const broadcast = await insertBroadcast({ messageCount: 2 });
    await buildAudience(broadcast.public_id);
    const bodies: Array<Record<string, unknown>> = [];
    metaSends([{ status: 200, body: { recipient_id: '1', message_id: 'mid.first' } }], bodies);

    await harness.turn('broadcast');

    expect(bodies).toHaveLength(1);
    const sent = bodies[0]!;
    // A normal DM to her Instagram id inside her window — no comment, no message tag.
    expect(sent.recipient).toEqual({ id: soonest.instagram_user_id });
    expect(sent).not.toHaveProperty('tag');
    const message = sent.message as { text: string; quick_replies: Array<{ payload: string }> };
    expect(message.text).toBe('Hi Riya, drop 1');
    const payload = parseBroadcastButtonPayload(message.quick_replies[0]!.payload);
    expect(payload?.broadcastPublicId).toBe(broadcast.public_id);
    const messages = await readInstagramMessages(organization.id);
    const first = messages.find(
      (row) => row.contact_id === soonest.id && row.message_number === 1,
    )!;
    expect(first).toMatchObject({ status: 'sent', lane: 'broadcast', channel: 'direct' });
    expect(payload?.messagePublicId).toBe(first.public_id);
    expect(
      messages.find((row) => row.contact_id === later.id && row.message_number === 1)?.status,
    ).toBe('waiting');
    // Each broadcast message counts one DM in the month (AC-9.10).
    expect(await monthUsed()).toBe(1);
    // The result save: her recipient `sent`, the broadcast's `sent`, her `last_broadcast_at`,
    // and her message 2 waiting in this lane.
    const [, soonestRecipient] = await readRecipients(broadcast.id);
    expect(soonestRecipient).toMatchObject({ contact_id: soonest.id, status: 'sent' });
    expect((await readNumbers(broadcast.id)).sent).toBe(1);
    expect(await lastBroadcastAt(soonest.id)).not.toBeNull();
    expect(
      messages.find((row) => row.contact_id === soonest.id && row.message_number === 2),
    ).toMatchObject({ status: 'waiting', lane: 'broadcast' });
    // The next turn is the next box of the broadcast hour limit (600 → 6 s), at least 1.5 s on.
    const row = await readLaneRow({ organizationId: organization.id, account, lane: 'broadcast' });
    const untilNext = row.next_run_at!.getTime() - Date.now();
    expect(untilNext).toBeGreaterThan(1000);
    expect(untilNext).toBeLessThanOrEqual(12_500);
    expect(harness.enqueued).toContainEqual(expect.objectContaining({ lane: 'broadcast' }));
    expect(INSTAGRAM_BROADCAST_TURN_PRIORITY).toBe(10);
  });

  it('waits for its box second, and stays within the broadcast hour limit (AC-9.10)', async () => {
    await operatorQuery`
      INSERT INTO app.instagram_account_settings (organization_id, channel_account_id, broadcast_hour_limit)
      VALUES (${organization.id}, ${account.channel_account_id}, 1)`;
    await lead(1);
    await lead(2);
    const broadcast = await insertBroadcast();
    await buildAudience(broadcast.public_id);
    metaSends([{ status: 200, body: { recipient_id: '1', message_id: 'mid.one' } }]);

    await harness.turn('broadcast');
    // One an hour: the next box is an hour on, and a turn before it sends nothing.
    const row = await readLaneRow({ organizationId: organization.id, account, lane: 'broadcast' });
    expect(row.next_run_at!.getTime() - Date.now()).toBeGreaterThan(HOUR - 60_000);
    await harness.turn('broadcast');
    expect(
      (await readInstagramMessages(organization.id)).filter((m) => m.status === 'sent'),
    ).toHaveLength(1);

    // The box forced open: gate 2 of the `broadcast` group still holds the hour limit.
    await freeTheBox();
    await harness.turn('broadcast');
    const statuses = (await readInstagramMessages(organization.id)).map((m) => m.status).sort();
    expect(statuses).toEqual(['sent', 'waiting']);
    expect(
      (await readLaneRow({ organizationId: organization.id, account, lane: 'broadcast' }))
        .wait_reason,
    ).toBe('hour_limit');
    expect(nock.isDone()).toBe(true);
  });

  it('checks again just before each send: closed window, a recent broadcast, opted out, a cancelled broadcast (AC-9.5)', async () => {
    const closing = await lead(23.5);
    const recent = await lead(2, { last_broadcast_at: new Date(Date.now() - 2 * HOUR) });
    const optedOut = await lead(3);
    const broadcast = await insertBroadcast();
    await buildAudience(broadcast.public_id);
    // The audience left out `recent` already (24 h gap); she got another broadcast meanwhile.
    expect((await readRecipients(broadcast.id)).map((row) => row.contact_id)).toEqual([
      closing.id,
      optedOut.id,
    ]);
    // Since the audience was built: her window closed, and the other opted out.
    await operatorQuery`
      UPDATE app.contact_activities SET last_direct_message_received_at = now() - interval '24 hours'
      WHERE contact_id = ${closing.id}`;
    await operatorQuery`UPDATE app.contacts SET opted_out_at = now() WHERE id = ${optedOut.id}`;

    await harness.turn('broadcast');

    const byContact = new Map(
      (await readRecipients(broadcast.id)).map((row) => [row.contact_id, row]),
    );
    expect(byContact.get(closing.id)).toMatchObject({ status: 'skipped', reason: 'window_closed' });
    expect(byContact.get(optedOut.id)).toMatchObject({ status: 'skipped', reason: 'opted_out' });
    expect((await readNumbers(broadcast.id)).skipped).toBe(2);
    expect(await monthUsed()).toBe(0);
    expect(recent.id).toBeGreaterThan(0);

    // A second broadcast to one more lead, cancelled before her turn.
    const another = await lead(1);
    const cancelled = await insertBroadcast();
    await buildAudience(cancelled.public_id);
    await operatorQuery`
      UPDATE app.broadcasts SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'owner'
      WHERE id = ${cancelled.id}`;
    await freeTheBox();
    await harness.turn('broadcast');
    const [cancelledRecipient] = await readRecipients(cancelled.id);
    expect(cancelledRecipient).toMatchObject({
      contact_id: another.id,
      status: 'skipped',
      reason: 'broadcast_cancelled',
    });
    const cancelledMessage = (await readInstagramMessages(organization.id)).find(
      (row) => row.broadcast_id === cancelled.id,
    );
    expect(cancelledMessage).toMatchObject({ status: 'cancelled', reason: 'broadcast_cancelled' });
  });

  it('skips message 1 to her within 24 hours of her last broadcast (recent_broadcast)', async () => {
    const person = await lead(1);
    const broadcast = await insertBroadcast();
    await buildAudience(broadcast.public_id);
    // Another broadcast reached her after this one's audience was built.
    await operatorQuery`
      UPDATE app.contact_activities SET last_broadcast_at = now() - interval '1 hour'
      WHERE contact_id = ${person.id}`;

    await harness.turn('broadcast');

    expect((await readRecipients(broadcast.id))[0]).toMatchObject({
      status: 'skipped',
      reason: 'recent_broadcast',
    });
  });

  it('stops at the month limit with the slow and fast lanes, and the reply lane goes on (P3)', async () => {
    await lead(1);
    const broadcast = await insertBroadcast();
    await buildAudience(broadcast.public_id);
    await setMonthCount({ organizationId: organization.id, count: 1000 });

    await harness.turn('broadcast');

    expect((await readInstagramMessages(organization.id))[0]?.status).toBe('waiting');
    const [plan] = await operatorQuery<Array<{ plan_stop_reason: string | null }>>`
      SELECT plan_stop_reason FROM app.channel_accounts WHERE id = ${account.channel_account_id}`;
    expect(plan?.plan_stop_reason).toBe('plan_limit');
    expect(
      (await readLaneRow({ organizationId: organization.id, account, lane: 'broadcast' })).state,
    ).toBe('stopped');
  });

  it("stops only itself for twice Meta's too-fast time (plan §30.14 rule 3)", async () => {
    await lead(1);
    const broadcast = await insertBroadcast();
    await buildAudience(broadcast.public_id);
    nock(META_GRAPH_BASE_URL)
      .post(`/v27.0/${igUserId()}/messages`)
      .query(true)
      .reply(400, { error: { code: 613 } });

    await harness.turn('broadcast');

    const row = await readLaneRow({ organizationId: organization.id, account, lane: 'broadcast' });
    expect(row.stop_reason).toBe('too_fast');
    // The first too fast is 15 minutes; a broadcast lane's twice that.
    const stopFor = row.stop_until!.getTime() - Date.now();
    expect(stopFor).toBeGreaterThan(29 * 60_000);
    expect(stopFor).toBeLessThanOrEqual(30 * 60_000);
    expect(
      (await readLaneRow({ organizationId: organization.id, account, lane: 'slow' })).stop_reason,
    ).toBeNull();
    // The message goes back to `waiting`, no try used (a stop never fails a DM).
    expect((await readInstagramMessages(organization.id))[0]).toMatchObject({
      status: 'waiting',
      tries: 0,
    });
  });
});
