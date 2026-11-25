import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type {
  ChannelPortDatabaseHandle,
  ChannelSendingPort,
  SaveWaitingMessageInput,
} from '@/domains/app/app.channel-ports.js';
import { broadcasts } from '@/domains/app/sub-domains/broadcast/broadcast.schema.js';
import { broadcast_recipients } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.schema.js';
import { BroadcastRecipientService } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.service.js';
import { InstagramMessageService } from '@/domains/app/sub-domains/instagram-sending/instagram-message/instagram-message.service.js';
import { readInstagramMessages } from '@/domains/app/sub-domains/instagram-sending/instagram-message/__tests__/factories/instagram-message.factory.js';
import {
  type ContactFixtureRow,
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Broadcast recipients against the database (feat-instagram-dm-sending routes-final § 7.C — BCC9,
 * BCC10; AC-9.5): the audience piece makes one `waiting` row and message 1 per matching contact
 * whose chat is open — never a second row; a skipped save or result moves the recipient and the
 * broadcast's numbers; a `sent` message saves the next; `owner_chat` comes back once; her erasure,
 * a cancel and her reply. A recording port stands in for a channel — broadcasts reach messages only
 * through it (BC18); one case runs Instagram's real port end to end. Every unit runs in the
 * organization's own job scope (`pnpm test:rls-role` safe).
 */

const HOUR = 60 * 60 * 1000;

/** A port that records every save, answering `skipped` for the contacts it is told to. */
function recordingPort(skipContactIds: Set<number> = new Set()) {
  const saved: SaveWaitingMessageInput[] = [];
  const port: ChannelSendingPort = {
    saveWaitingMessage: async (input) => {
      saved.push(input);
      return skipContactIds.has(input.contactId)
        ? { messagePublicId: null, status: 'skipped', reason: 'window_closed' }
        : { messagePublicId: `igm_${String(saved.length).padStart(21, '0')}`, status: 'waiting' };
    },
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
  return { port, saved };
}

describe('BroadcastRecipientService (database)', () => {
  let organization: { id: number; public_id: string };
  let account: { id: number; public_id: string; channel_account_id: number };

  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id });
  const inUnit = <T>(callback: (databaseHandle: ChannelPortDatabaseHandle) => Promise<T>) =>
    withAppDatabaseContext({ scope: scope(), callback });

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
  });

  /** A contact tagged `lead`, her chat open unless told otherwise. */
  function lead(overrides: Partial<ContactFixtureRow> = {}): Promise<ContactFixtureRow> {
    return insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      tags: ['lead'],
      last_direct_message_received_at: new Date(Date.now() - HOUR),
      ...overrides,
    });
  }

  async function insertBroadcast({
    status = 'sending',
    mode = 'now',
    messageCount = 1,
  }: {
    status?: 'sending' | 'waiting_for_chats' | 'cancelled';
    mode?: 'now' | 'when_chat_opens';
    messageCount?: number;
  } = {}) {
    const [row] = await getOperatorDatabase()
      .insert(broadcasts)
      .values({
        public_id: generatePublicId('broadcast'),
        organization_id: organization.id,
        channel_account_id: account.channel_account_id,
        name: 'Drop',
        status,
        mode,
        conditions: { op: 'and', items: [{ field: 'tags', match: 'any', values: ['lead'] }] },
        messages: Array.from({ length: messageCount }, (_, index) => ({
          kind: 'text' as const,
          wait_minutes: index === 0 ? 0 : 5,
          text: `Message ${index + 1}`,
        })),
        started_at: new Date(),
        ends_at: mode === 'when_chat_opens' ? new Date(Date.now() + 24 * HOUR) : null,
        cancelled_at: status === 'cancelled' ? new Date() : null,
        cancel_reason: status === 'cancelled' ? 'owner' : null,
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
      .where(
        and(
          eq(broadcast_recipients.organization_id, organization.id),
          eq(broadcast_recipients.broadcast_id, broadcastId),
        ),
      )
      .orderBy(broadcast_recipients.contact_id);
  }

  describe('the audience piece (WC-40, AC-9.5)', () => {
    it('makes a waiting recipient and message 1 for each matching contact whose chat is open — only once', async () => {
      const open = await lead();
      await lead({ last_direct_message_received_at: new Date(Date.now() - 30 * HOUR) });
      await lead({ opted_out_at: new Date() });
      await lead({ automations_off_at: new Date() });
      await lead({ last_broadcast_at: new Date(Date.now() - 2 * HOUR) });
      await insertContact({
        organizationId: organization.id,
        instagramAccountId: account.id,
        tags: ['other'],
        last_direct_message_received_at: new Date(),
      });
      const broadcast = await insertBroadcast();
      const { port, saved } = recordingPort();
      const service = new BroadcastRecipientService({ sendingPorts: { instagram: port } });

      const first = await inUnit((databaseHandle) =>
        service.buildAudiencePiece({
          databaseHandle,
          broadcastPublicId: broadcast.public_id,
          afterContactId: 0,
        }),
      );
      expect(first).toEqual({
        createdCount: 1,
        skippedCount: 0,
        lastContactId: open.id,
        isLastPiece: true,
      });
      const [recipient] = await readRecipients(broadcast.id);
      expect(recipient).toMatchObject({
        contact_id: open.id,
        channel_account_id: account.channel_account_id,
        status: 'waiting',
        reason: null,
        sent_at: null,
      });
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        contactId: open.id,
        step: 'broadcast',
        messageNumber: 1,
        messageKind: 'text',
        content: { stepPath: 'messages.0', uploadPublicIds: [] },
        source: {
          broadcastId: broadcast.id,
          broadcastRecipientId: recipient!.id,
          broadcastRecipientCreatedAt: recipient!.created_at,
        },
      });
      expect((await readBroadcast(broadcast.id)).matched).toBe(1);

      // A second build of the same broadcast makes no second row and no second message.
      const again = await inUnit((databaseHandle) =>
        service.buildAudiencePiece({
          databaseHandle,
          broadcastPublicId: broadcast.public_id,
          afterContactId: 0,
        }),
      );
      expect(again.createdCount).toBe(0);
      expect(await readRecipients(broadcast.id)).toHaveLength(1);
      expect(saved).toHaveLength(1);
      expect((await readBroadcast(broadcast.id)).matched).toBe(1);
    });

    it('settles a recipient skipped when the port refuses her message at once, and builds nothing once cancelled', async () => {
      const refused = await lead();
      const broadcast = await insertBroadcast();
      const { port } = recordingPort(new Set([refused.id]));
      const service = new BroadcastRecipientService({ sendingPorts: { instagram: port } });

      const piece = await inUnit((databaseHandle) =>
        service.buildAudiencePiece({
          databaseHandle,
          broadcastPublicId: broadcast.public_id,
          afterContactId: 0,
        }),
      );
      expect(piece).toMatchObject({ createdCount: 1, skippedCount: 1 });
      expect((await readRecipients(broadcast.id))[0]).toMatchObject({
        status: 'skipped',
        reason: 'window_closed',
      });
      expect(await readBroadcast(broadcast.id)).toMatchObject({ matched: 1, skipped: 1 });

      const cancelled = await insertBroadcast({ status: 'cancelled' });
      expect(
        await inUnit((databaseHandle) =>
          service.buildAudiencePiece({
            databaseHandle,
            broadcastPublicId: cancelled.public_id,
            afterContactId: 0,
          }),
        ),
      ).toMatchObject({ createdCount: 0, isLastPiece: true });
    });
  });

  describe('results (BC17, BC18)', () => {
    it('moves the recipient and the numbers once per result of message 1, and saves message 2 after a sent 1', async () => {
      const sentTo = await lead();
      const skippedFor = await lead();
      const broadcast = await insertBroadcast({ messageCount: 2 });
      const { port, saved } = recordingPort();
      const service = new BroadcastRecipientService({ sendingPorts: { instagram: port } });
      await inUnit((databaseHandle) =>
        service.buildAudiencePiece({
          databaseHandle,
          broadcastPublicId: broadcast.public_id,
          afterContactId: 0,
        }),
      );
      expect(saved).toHaveLength(2);

      const occurredAt = new Date();
      const result = (contactId: number, outcome: 'sent' | 'skipped', messageNumber = 1) =>
        inUnit((databaseHandle) =>
          service.recordMessageResult({
            databaseHandle,
            organizationId: organization.id,
            broadcastId: broadcast.id,
            contactId,
            messagePublicId: 'igm_000000000000000000001',
            messageNumber,
            result: outcome,
            reason: outcome === 'skipped' ? 'window_closed' : null,
            occurredAt,
          }),
        );
      await result(sentTo.id, 'sent');
      await result(skippedFor.id, 'skipped');
      // A repeat of a settled result changes nothing.
      await result(sentTo.id, 'sent');

      const recipients = await readRecipients(broadcast.id);
      expect(recipients.find((row) => row.contact_id === sentTo.id)).toMatchObject({
        status: 'sent',
        reason: null,
      });
      expect(recipients.find((row) => row.contact_id === sentTo.id)?.sent_at).not.toBeNull();
      expect(recipients.find((row) => row.contact_id === skippedFor.id)).toMatchObject({
        status: 'skipped',
        reason: 'window_closed',
        sent_at: null,
      });
      expect(await readBroadcast(broadcast.id)).toMatchObject({
        matched: 2,
        sent: 1,
        skipped: 1,
        failed: 0,
      });
      // Message 2 went to the one whose message 1 was sent — once, after its wait.
      const second = saved.filter((input) => input.messageNumber === 2);
      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({
        contactId: sentTo.id,
        content: { stepPath: 'messages.1' },
      });
      expect(second[0]!.notBefore!.getTime()).toBe(occurredAt.getTime() + 5 * 60_000);

      // Message 2's own result moves nothing on the recipient (her status is message 1's).
      await result(sentTo.id, 'sent', 2);
      expect(await readBroadcast(broadcast.id)).toMatchObject({ sent: 1 });
      expect(saved.filter((input) => input.messageNumber === 3)).toHaveLength(0);
    });

    it("saves a broadcast's waiting message through Instagram's real port and takes its result back from the result save", async () => {
      const contact = await lead();
      const broadcast = await insertBroadcast({ messageCount: 2 });
      let recipients: BroadcastRecipientService | undefined;
      const instagram = new InstagramMessageService({
        recordRunMessageResult: async () => undefined,
        recordBroadcastMessageResult: (input) => recipients!.recordMessageResult(input),
      });
      recipients = new BroadcastRecipientService({ sendingPorts: { instagram } });
      await inUnit((databaseHandle) =>
        recipients!.buildAudiencePiece({
          databaseHandle,
          broadcastPublicId: broadcast.public_id,
          afterContactId: 0,
        }),
      );
      const [message] = await readInstagramMessages(organization.id);
      expect(message).toMatchObject({
        broadcast_id: broadcast.id,
        contact_id: contact.id,
        message_type: 'broadcast',
        message_number: 1,
        lane: 'broadcast',
        channel: 'direct',
        status: 'waiting',
      });
      const key = {
        organizationId: organization.id,
        publicId: message!.public_id,
        automationRunStartedAt: message!.automation_run_started_at,
      };
      const claimed = await instagram.claimMessage({
        scope: scope(),
        key,
        lane: 'broadcast',
        channel: 'direct',
        countGroup: 'broadcast',
      });
      await instagram.saveSendResult({
        scope: scope(),
        key,
        attempt: { organizationId: organization.id, ...claimed!.attempt },
        status: 'sent',
        reason: null,
        instagramMessageId: 'aWdfZAG1mid900',
        errorCode: null,
        errorSubcode: null,
        resultGroup: 'sent',
        httpStatus: 200,
        durationMilliseconds: 300,
      });

      expect((await readRecipients(broadcast.id))[0]).toMatchObject({ status: 'sent' });
      expect(await readBroadcast(broadcast.id)).toMatchObject({ matched: 1, sent: 1 });
      const messages = await readInstagramMessages(organization.id);
      expect(messages.map((row) => [row.message_number, row.status]).sort()).toEqual([
        [1, 'sent'],
        [2, 'waiting'],
      ]);
    });
  });

  describe('when her chat opens, skips and replies (BC16, BC17)', () => {
    it('makes her row once and puts a skipped owner_chat row back to waiting once', async () => {
      const contact = await lead();
      const broadcast = await insertBroadcast({
        status: 'waiting_for_chats',
        mode: 'when_chat_opens',
      });
      const { port, saved } = recordingPort();
      const service = new BroadcastRecipientService({ sendingPorts: { instagram: port } });
      const open = () =>
        inUnit((databaseHandle) =>
          service.addChatOpenedRecipient({
            databaseHandle,
            organizationId: organization.id,
            broadcastId: broadcast.id,
            contactId: contact.id,
          }),
        );

      expect(await open()).toBe('created');
      expect(await open()).toBe('unchanged');
      await inUnit((databaseHandle) =>
        service.recordMessageResult({
          databaseHandle,
          organizationId: organization.id,
          broadcastId: broadcast.id,
          contactId: contact.id,
          messagePublicId: 'igm_000000000000000000001',
          messageNumber: 1,
          result: 'skipped',
          reason: 'owner_chat',
          occurredAt: new Date(),
        }),
      );
      expect(await readBroadcast(broadcast.id)).toMatchObject({ skipped: 1 });

      expect(await open()).toBe('reopened');
      expect(await readRecipients(broadcast.id)).toEqual([
        expect.objectContaining({ status: 'waiting', reason: null }),
      ]);
      expect(await readBroadcast(broadcast.id)).toMatchObject({ skipped: 0, matched: 0 });
      expect(await open()).toBe('unchanged');
      expect(saved.map((input) => input.messageNumber)).toEqual([1, 1]);
    });

    it("skips her waiting recipients at her erasure and a cancel's piece, and counts her first reply once", async () => {
      const erased = await lead();
      const others = [await lead(), await lead()];
      const broadcast = await insertBroadcast();
      const { port } = recordingPort();
      const service = new BroadcastRecipientService({ sendingPorts: { instagram: port } });
      await inUnit((databaseHandle) =>
        service.buildAudiencePiece({
          databaseHandle,
          broadcastPublicId: broadcast.public_id,
          afterContactId: 0,
        }),
      );

      expect(
        await inUnit((databaseHandle) =>
          service.skipContactWaitingRecipients({
            databaseHandle,
            organizationId: organization.id,
            contactId: erased.id,
            reason: 'contact_deleted',
          }),
        ),
      ).toBe(1);
      // A cancel's piece of one, then the rest.
      expect(
        await inUnit((databaseHandle) =>
          service.skipBroadcastWaitingRecipients({
            databaseHandle,
            organizationId: organization.id,
            broadcastId: broadcast.id,
            reason: 'broadcast_cancelled',
            limit: 1,
          }),
        ),
      ).toBe(1);
      await inUnit((databaseHandle) =>
        service.recordMessageResult({
          databaseHandle,
          organizationId: organization.id,
          broadcastId: broadcast.id,
          contactId: others[1]!.id,
          messagePublicId: 'igm_000000000000000000002',
          messageNumber: 1,
          result: 'sent',
          reason: null,
          occurredAt: new Date(Date.now() - 1000),
        }),
      );
      expect(
        await inUnit((databaseHandle) =>
          service.skipBroadcastWaitingRecipients({
            databaseHandle,
            organizationId: organization.id,
            broadcastId: broadcast.id,
            reason: 'broadcast_cancelled',
            limit: 500,
          }),
        ),
      ).toBe(0);
      const reasons = (await readRecipients(broadcast.id)).map((row) => [
        row.contact_id,
        row.status,
        row.reason,
      ]);
      expect(reasons).toEqual([
        [erased.id, 'skipped', 'contact_deleted'],
        [others[0]!.id, 'skipped', 'broadcast_cancelled'],
        [others[1]!.id, 'sent', null],
      ]);

      const reply = (contactId: number) =>
        inUnit((databaseHandle) =>
          service.recordContactReply({
            databaseHandle,
            organizationId: organization.id,
            contactId,
            repliedAt: new Date(),
          }),
        );
      expect(await reply(others[1]!.id)).toBe(1);
      expect(await reply(others[1]!.id)).toBe(0);
      expect(await reply(others[0]!.id)).toBe(0);
      expect(await readBroadcast(broadcast.id)).toMatchObject({
        matched: 3,
        sent: 1,
        skipped: 2,
        replies: 1,
      });
    });
  });
});
