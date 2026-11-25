import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Pieces of 2 instead of 500, so three contacts span two pieces (WC-40).
vi.mock(
  '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.constants.js',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    BROADCAST_AUDIENCE_PIECE_SIZE: 2,
  }),
);

import type { ChannelSendingPort } from '@/domains/app/app.channel-ports.js';
import { broadcasts } from '@/domains/app/sub-domains/broadcast/broadcast.schema.js';
import { broadcast_recipients } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.schema.js';
import { BroadcastRecipientService } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.service.js';
import {
  type BroadcastAudienceTaskInput,
  broadcastAudienceJobId,
  broadcastAudienceTaskInputSchema,
} from '@/domains/app/sub-domains/broadcast/broadcast-recipient/queues/broadcast-audience.job.schema.js';
import { runBroadcastAudiencePiece } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/workers/broadcast-audience.processor.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HOUR = 60 * 60 * 1000;

/**
 * The `broadcast-audience` task (routes-final § 7.C BCC9; WC-40, P214 — ROUTE row R46): piece after
 * piece, each committed alone, chained from the last contact of the one before; the lane woken
 * after each piece that made recipients; the "audience built" mark (7.A.10) set by the last piece
 * only; a replayed piece makes no second row. Every unit runs in the organization's job scope.
 */
describe('broadcast-audience task (database, AC-9.5)', () => {
  let organization: { id: number; public_id: string };
  let account: { id: number; public_id: string; channel_account_id: number };

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
  });

  const port: ChannelSendingPort = {
    saveWaitingMessage: async () => ({
      messagePublicId: 'igm_000000000000000000001',
      status: 'waiting',
    }),
    cancelWaitingMessages: async () => 0,
    skipWaitingMessages: async () => 0,
    listContactMessages: async () => [],
    summarizeFailedMessages: async () => {
      throw new Error('not used');
    },
    retryFailedMessages: async () => {
      throw new Error('not used');
    },
  };

  async function insertSendingBroadcast() {
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
        messages: [{ kind: 'text' as const, wait_minutes: 0, text: 'Hello' }],
        started_at: new Date(),
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

  it('builds the audience in chained pieces, wakes the lane after each, and marks it built on the last', async () => {
    for (let index = 0; index < 3; index += 1) {
      await insertContact({
        organizationId: organization.id,
        instagramAccountId: account.id,
        tags: ['lead'],
        last_direct_message_received_at: new Date(Date.now() - HOUR),
      });
    }
    const broadcast = await insertSendingBroadcast();
    const recipientService = new BroadcastRecipientService({ sendingPorts: { instagram: port } });
    const wakes: Array<{ channelAccountId: number; channelAccountPublicId: string }> = [];
    const jobIds: string[] = [];
    const marks: Array<Date | null> = [];

    let next: BroadcastAudienceTaskInput | null = broadcastAudienceTaskInputSchema.parse({
      broadcastPublicId: broadcast.public_id,
      channelAccountPublicId: account.public_id,
      pieceNumber: 1,
      afterContactPublicId: null,
    });
    while (next !== null) {
      const current: BroadcastAudienceTaskInput = next;
      next = null;
      await runBroadcastAudiencePiece({
        recipientService,
        organizationPublicId: organization.public_id,
        taskInput: current,
        runInDatabaseSlot: (callback) => callback(),
        wakeSending: async (input) => {
          wakes.push({
            channelAccountId: input.channelAccountId,
            channelAccountPublicId: input.channelAccountPublicId,
          });
        },
        enqueuePiece: async ({ taskInput }) => {
          jobIds.push(broadcastAudienceJobId(taskInput));
          next = broadcastAudienceTaskInputSchema.parse(taskInput);
        },
      });
      marks.push((await readBroadcast(broadcast.id)).audience_built_at);
    }

    expect(jobIds).toEqual([`bcaud-${broadcast.public_id}-2`]);
    // The first piece left the mark empty; the last one set it.
    expect(marks[0]).toBeNull();
    expect(marks[1]).toBeInstanceOf(Date);
    expect(wakes).toEqual([
      { channelAccountId: account.channel_account_id, channelAccountPublicId: account.public_id },
      { channelAccountId: account.channel_account_id, channelAccountPublicId: account.public_id },
    ]);
    const recipients = await getOperatorDatabase()
      .select()
      .from(broadcast_recipients)
      .where(
        and(
          eq(broadcast_recipients.organization_id, organization.id),
          eq(broadcast_recipients.broadcast_id, broadcast.id),
        ),
      );
    expect(recipients).toHaveLength(3);
    expect((await readBroadcast(broadcast.id)).matched).toBe(3);

    // A replayed first piece makes no second row and wakes nothing.
    const replayWakes: number[] = [];
    await runBroadcastAudiencePiece({
      recipientService,
      organizationPublicId: organization.public_id,
      taskInput: broadcastAudienceTaskInputSchema.parse({
        broadcastPublicId: broadcast.public_id,
        channelAccountPublicId: account.public_id,
        pieceNumber: 1,
        afterContactPublicId: null,
      }),
      runInDatabaseSlot: (callback) => callback(),
      wakeSending: async (input) => {
        replayWakes.push(input.channelAccountId);
      },
      enqueuePiece: async () => undefined,
    });
    expect(replayWakes).toEqual([]);
    expect((await readBroadcast(broadcast.id)).matched).toBe(3);
  });
});
