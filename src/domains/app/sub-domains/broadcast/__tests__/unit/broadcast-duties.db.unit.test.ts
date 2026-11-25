import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { RepairDutyContext } from '@/infrastructure/queue/worker-runtime/repair-duty.util.js';
import type { ChannelPortDatabaseHandle } from '@/domains/app/app.channel-ports.js';
import { broadcasts } from '@/domains/app/sub-domains/broadcast/broadcast.schema.js';
import { broadcast_recipients } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.schema.js';
import { BroadcastRecipientService } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.service.js';
import { runBroadcastEndDuty } from '@/domains/app/sub-domains/broadcast/workers/broadcast-end.processor.js';
import { runBroadcastStartDuty } from '@/domains/app/sub-domains/broadcast/workers/broadcast-start.processor.js';
import type { BroadcastSentKey } from '@/domains/app/sub-domains/broadcast/broadcast.types.js';
import { InstagramMessageService } from '@/domains/app/sub-domains/instagram-sending/instagram-message/instagram-message.service.js';
import { readInstagramMessages } from '@/domains/app/sub-domains/instagram-sending/instagram-message/__tests__/factories/instagram-message.factory.js';
import {
  type ContactFixtureRow,
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { insertAutomationRun } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HOUR = 60 * 60 * 1000;

/**
 * The broadcast duties and the "when her chat opens" hook against the database
 * (feat-instagram-dm-sending § 7.A BC7, BC11, BC17, BCC7 — ROUTE row R47; WC-28, WC-29; AC-9.6,
 * AC-9.7): a scheduled broadcast starts at its time, a cancelled one's waiting recipients and
 * messages are settled, a "when her chat opens" one ends `done` past its end with its notice, and
 * her message makes her row — each duty twice changes nothing. Instagram's real message service is
 * the channel port; every change runs in the organization's job scope.
 */
describe('broadcast duties (database)', () => {
  let organization: { id: number; public_id: string };
  let account: { id: number; public_id: string; channel_account_id: number };
  let messageService: InstagramMessageService;
  let recipientService: BroadcastRecipientService;
  let notices: string[];

  const context = (): RepairDutyContext => ({ now: new Date(), isBudgetSpent: () => false });
  const inUnit = <T>(callback: (databaseHandle: ChannelPortDatabaseHandle) => Promise<T>) =>
    withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id }),
      callback,
    });
  const endServices = () => ({
    recipientService,
    sendingPorts: { instagram: messageService },
    runInDatabaseSlot: <T>(callback: () => Promise<T>) => callback(),
    notifyDone: async (input: { dedupeKey: string }) => {
      notices.push(input.dedupeKey);
      return { createdCount: 1, failedCount: 0, deduplicated: false, recipientCount: 1 };
    },
  });

  function lead(overrides: Partial<ContactFixtureRow> = {}): Promise<ContactFixtureRow> {
    return insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      tags: ['lead'],
      last_direct_message_received_at: new Date(Date.now() - HOUR),
      ...overrides,
    });
  }

  async function insertBroadcast(
    values: Partial<typeof broadcasts.$inferInsert> & { status: string; mode: string },
  ) {
    const [row] = await getOperatorDatabase()
      .insert(broadcasts)
      .values({
        public_id: generatePublicId('broadcast'),
        organization_id: organization.id,
        channel_account_id: account.channel_account_id,
        name: 'Drop',
        conditions: { op: 'and', items: [{ field: 'tags', match: 'any', values: ['lead'] }] },
        messages: [{ kind: 'text' as const, wait_minutes: 0, text: 'Message 1' }],
        ...values,
      })
      .returning();
    return row!;
  }

  async function readBroadcast(broadcastId: number) {
    const [row] = await getOperatorDatabase()
      .select()
      .from(broadcasts)
      .where(eq(broadcasts.id, broadcastId));
    return row!;
  }

  async function readRecipients(broadcastId: number) {
    return getOperatorDatabase()
      .select()
      .from(broadcast_recipients)
      .where(eq(broadcast_recipients.broadcast_id, broadcastId));
  }

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    messageService = new InstagramMessageService({
      recordRunMessageResult: async () => undefined,
      recordBroadcastMessageResult: async () => undefined,
    });
    recipientService = new BroadcastRecipientService({
      sendingPorts: { instagram: messageService },
    });
    notices = [];
  });

  it('starts a scheduled broadcast at its time and adds its audience task once; one not yet due waits (WC-28, AC-9.6)', async () => {
    const due = await insertBroadcast({
      status: 'scheduled',
      mode: 'scheduled',
      scheduled_at: new Date(Date.now() - 60_000),
    });
    const later = await insertBroadcast({
      status: 'scheduled',
      mode: 'scheduled',
      scheduled_at: new Date(Date.now() + HOUR),
    });
    const added: BroadcastSentKey[] = [];
    const sendQueue = {
      enqueueBroadcastAudience: async (key: BroadcastSentKey) => {
        added.push(key);
      },
      enqueueBroadcastMatchedCount: async () => undefined,
    };
    const runInDatabaseSlot = <T>(callback: () => Promise<T>) => callback();

    expect(
      (await runBroadcastStartDuty({ context: context(), sendQueue: undefined, runInDatabaseSlot }))
        .done,
    ).toBe(0);
    expect((await readBroadcast(due.id)).status).toBe('scheduled');

    expect(
      (await runBroadcastStartDuty({ context: context(), sendQueue, runInDatabaseSlot })).done,
    ).toBe(1);
    const started = await readBroadcast(due.id);
    expect(started.status).toBe('sending');
    expect(started.started_at).toBeInstanceOf(Date);
    expect(added).toEqual([
      {
        organizationPublicId: organization.public_id,
        broadcastPublicId: due.public_id,
        channelAccountPublicId: account.public_id,
      },
    ]);
    expect((await readBroadcast(later.id)).status).toBe('scheduled');

    expect(
      (await runBroadcastStartDuty({ context: context(), sendQueue, runInDatabaseSlot })).done,
    ).toBe(0);
    expect(added).toHaveLength(1);
  });

  it('settles a cancelled broadcast: waiting recipients skipped, their waiting messages cancelled · broadcast_cancelled (WC-29, AC-9.7)', async () => {
    await lead();
    await lead();
    const broadcast = await insertBroadcast({
      status: 'sending',
      mode: 'now',
      started_at: new Date(),
    });
    await inUnit((databaseHandle) =>
      recipientService.buildAudiencePiece({
        databaseHandle,
        broadcastPublicId: broadcast.public_id,
        afterContactId: 0,
      }),
    );
    await getOperatorDatabase()
      .update(broadcasts)
      .set({ status: 'cancelled', cancelled_at: new Date(), cancel_reason: 'owner' })
      .where(eq(broadcasts.id, broadcast.id));

    const first = await runBroadcastEndDuty({ context: context(), services: endServices() });
    expect(first.done).toBe(4);
    const recipients = await readRecipients(broadcast.id);
    expect(recipients.map((row) => [row.status, row.reason])).toEqual([
      ['skipped', 'broadcast_cancelled'],
      ['skipped', 'broadcast_cancelled'],
    ]);
    const messages = (await readInstagramMessages(organization.id)).filter(
      (row) => row.broadcast_id === broadcast.id,
    );
    expect(messages.map((row) => [row.status, row.reason])).toEqual([
      ['cancelled', 'broadcast_cancelled'],
      ['cancelled', 'broadcast_cancelled'],
    ]);
    expect((await readBroadcast(broadcast.id)).skipped).toBe(2);
    expect(notices).toEqual([]);

    expect((await runBroadcastEndDuty({ context: context(), services: endServices() })).done).toBe(
      0,
    );
  });

  it('ends a "when her chat opens" broadcast past its end with nobody waiting, told once; a sending one waits for its audience mark (WC-29, AC-9.6, P319)', async () => {
    const ended = await insertBroadcast({
      status: 'waiting_for_chats',
      mode: 'when_chat_opens',
      started_at: new Date(Date.now() - 2 * HOUR),
      ends_at: new Date(Date.now() - 60_000),
    });
    const running = await insertBroadcast({
      status: 'waiting_for_chats',
      mode: 'when_chat_opens',
      started_at: new Date(),
      ends_at: new Date(Date.now() + HOUR),
    });
    const sending = await insertBroadcast({
      status: 'sending',
      mode: 'now',
      started_at: new Date(),
    });

    expect((await runBroadcastEndDuty({ context: context(), services: endServices() })).done).toBe(
      1,
    );
    const done = await readBroadcast(ended.id);
    expect(done.status).toBe('done');
    expect(done.finished_at).toBeInstanceOf(Date);
    expect(notices).toEqual([`broadcast-done:${ended.public_id}`]);
    expect((await readBroadcast(running.id)).status).toBe('waiting_for_chats');
    expect((await readBroadcast(sending.id)).status).toBe('sending');

    expect((await runBroadcastEndDuty({ context: context(), services: endServices() })).done).toBe(
      0,
    );
    expect(notices).toHaveLength(1);
  });

  it('makes her row when her chat opens — not while the owner chats with her, not while a run of hers is open (BC17, AC-9.6)', async () => {
    const broadcast = await insertBroadcast({
      status: 'waiting_for_chats',
      mode: 'when_chat_opens',
      started_at: new Date(),
      ends_at: new Date(Date.now() + HOUR),
    });
    const her = await lead();
    const busy = await lead();
    const automation = await insertAutomation({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
      status: 'live',
    });
    await insertAutomationRun({
      organizationId: organization.id,
      automationId: automation.id,
      contactId: busy.id,
    });
    const other = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      tags: ['other'],
      last_direct_message_received_at: new Date(),
    });
    const opened = (contactId: number, isOwnerChatting = false) =>
      inUnit((databaseHandle) =>
        recipientService.handleChatOpened({
          databaseHandle,
          organizationId: organization.id,
          channelAccountId: account.channel_account_id,
          contactId,
          isOwnerChatting,
        }),
      );

    expect(await opened(her.id, true)).toBe(0);
    expect(await opened(busy.id)).toBe(0);
    expect(await opened(other.id)).toBe(0);
    expect(await opened(her.id)).toBe(1);
    expect(await opened(her.id)).toBe(0);
    const recipients = await readRecipients(broadcast.id);
    expect(recipients.map((row) => [row.contact_id, row.status])).toEqual([[her.id, 'waiting']]);
  });
});
