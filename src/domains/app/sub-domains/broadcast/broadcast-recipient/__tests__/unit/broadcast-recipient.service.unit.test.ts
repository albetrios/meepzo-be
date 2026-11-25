import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelBroadcastMessageResultInput,
  ChannelSendingPort,
  SaveWaitingMessageInput,
} from '@/domains/app/app.channel-ports.js';

const { repository } = vi.hoisted(() => ({
  repository: {
    findBroadcast: vi.fn(),
    insertWaiting: vi.fn(),
    reopenOwnerChat: vi.fn(),
    settleWaiting: vi.fn(),
    find: vi.fn(),
    addToBroadcastNumbers: vi.fn(),
    skipWaitingOfContact: vi.fn(),
    skipWaitingOfBroadcast: vi.fn(),
    recordReply: vi.fn(),
  },
}));

vi.mock(
  '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.repository.js',
  () => ({
    BroadcastRecipientRepository: vi.fn(function construct() {
      return repository;
    }),
  }),
);

import { BroadcastRecipientService } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.service.js';

const databaseHandle = { handle: 'job' } as never;
const CREATED_AT = new Date('2026-11-25T08:00:00.000Z');
const BROADCAST = {
  id: 21,
  organization_id: 7,
  channel_account_id: 11,
  channel: 'instagram',
  status: 'sending',
  conditions: null,
  messages: [
    { kind: 'text', wait_minutes: 0, text: 'One' },
    { kind: 'text', wait_minutes: 5, text: 'Two' },
  ],
};
const RECIPIENT = { id: 31, contact_id: 3, version_number: null, created_at: CREATED_AT };

function resultInput(
  overrides: Partial<ChannelBroadcastMessageResultInput> = {},
): ChannelBroadcastMessageResultInput {
  return {
    databaseHandle,
    organizationId: 7,
    broadcastId: 21,
    contactId: 3,
    messagePublicId: 'igm_aaaaaaaaaaaaaaaaaaaaa',
    messageNumber: 1,
    result: 'sent',
    reason: null,
    occurredAt: new Date('2026-11-25T09:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Broadcast recipients with their repository faked and a recording channel port (routes-final § 7.C
 * — BC16–BC18; BCC9, BCC10): message 1's result settles her row once and moves the broadcast's one
 * number, a `sent` saves her next message through the account's channel's port (never after a
 * cancel), a chat that opens adds or reopens her row and saves message 1, and the erasure, cancel
 * and reply moves add to the numbers per broadcast. The database side is
 * `broadcast-recipient.service.db.unit.test.ts` and `broadcast-recipient.repository.db.unit.test.ts`.
 */
describe('BroadcastRecipientService', () => {
  let saved: SaveWaitingMessageInput[];
  let saveAnswer: Awaited<ReturnType<ChannelSendingPort['saveWaitingMessage']>>;
  let service: BroadcastRecipientService;

  beforeEach(() => {
    vi.clearAllMocks();
    saved = [];
    saveAnswer = { messagePublicId: 'igm_bbbbbbbbbbbbbbbbbbbbb', status: 'waiting' };
    const port = {
      saveWaitingMessage: vi.fn(async (input: SaveWaitingMessageInput) => {
        saved.push(input);
        return saveAnswer;
      }),
    } as unknown as ChannelSendingPort;
    service = new BroadcastRecipientService({ sendingPorts: { instagram: port } });
    repository.findBroadcast.mockResolvedValue(BROADCAST);
    repository.settleWaiting.mockResolvedValue({ ...RECIPIENT, status: 'sent' });
    repository.find.mockResolvedValue(RECIPIENT);
  });

  it("settles message 1's result once, adds to its number and saves message 2", async () => {
    await service.recordMessageResult(resultInput());
    expect(repository.settleWaiting).toHaveBeenCalledWith({
      key: { organizationId: 7, broadcastId: 21, contactId: 3 },
      status: 'sent',
      reason: null,
      at: resultInput().occurredAt,
    });
    expect(repository.addToBroadcastNumbers).toHaveBeenCalledWith({
      organizationId: 7,
      broadcastId: 21,
      change: { sent: 1 },
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      organizationId: 7,
      channelAccountId: 11,
      contactId: 3,
      step: 'broadcast',
      messageNumber: 2,
      source: {
        broadcastId: 21,
        broadcastRecipientId: 31,
        broadcastRecipientCreatedAt: CREATED_AT,
      },
      notBefore: new Date(resultInput().occurredAt.getTime() + 5 * 60_000),
    });
  });

  it("a repeat of message 1's result changes nothing and saves no second message", async () => {
    repository.settleWaiting.mockResolvedValueOnce(null);
    await service.recordMessageResult(resultInput());
    expect(repository.addToBroadcastNumbers).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it("an unknown result moves no number; a later message's result moves her row not at all", async () => {
    repository.settleWaiting.mockResolvedValueOnce({ ...RECIPIENT, status: 'unknown' });
    await service.recordMessageResult(resultInput({ result: 'unknown' }));
    expect(repository.addToBroadcastNumbers).not.toHaveBeenCalled();
    expect(saved).toEqual([]);

    await service.recordMessageResult(resultInput({ messageNumber: 2 }));
    expect(repository.settleWaiting).toHaveBeenCalledTimes(1);
    // Message 3 does not exist: nothing is saved after the last message.
    expect(saved).toEqual([]);
  });

  it('saves no next message once the broadcast is cancelled, and needs a reason for a skip', async () => {
    repository.findBroadcast.mockResolvedValueOnce({ ...BROADCAST, status: 'cancelled' });
    await service.recordMessageResult(resultInput());
    expect(saved).toEqual([]);
    await expect(
      service.recordMessageResult(resultInput({ result: 'skipped', reason: null })),
    ).rejects.toThrow('needs a reason');
  });

  it('a gone broadcast is ignored', async () => {
    repository.findBroadcast.mockResolvedValueOnce(null);
    await service.recordMessageResult(resultInput());
    expect(repository.settleWaiting).not.toHaveBeenCalled();
  });

  it('a chat that opens adds her row and saves message 1; a skipped save counts as skipped', async () => {
    repository.insertWaiting.mockResolvedValueOnce([RECIPIENT]);
    saveAnswer = { messagePublicId: null, status: 'skipped', reason: 'window_closed' };
    repository.settleWaiting.mockResolvedValueOnce({ ...RECIPIENT, status: 'skipped' });
    expect(
      await service.addChatOpenedRecipient({
        databaseHandle,
        organizationId: 7,
        broadcastId: 21,
        contactId: 3,
      }),
    ).toBe('created');
    expect(saved[0]).toMatchObject({ messageNumber: 1, notBefore: null });
    expect(repository.addToBroadcastNumbers).toHaveBeenCalledWith({
      organizationId: 7,
      broadcastId: 21,
      change: { skipped: 1 },
    });
  });

  it('a chat that opens reopens an owner_chat row (one skip fewer), or changes nothing', async () => {
    repository.insertWaiting.mockResolvedValue([]);
    repository.reopenOwnerChat.mockResolvedValueOnce(RECIPIENT);
    const key = { databaseHandle, organizationId: 7, broadcastId: 21, contactId: 3 };
    expect(await service.addChatOpenedRecipient(key)).toBe('reopened');
    expect(repository.addToBroadcastNumbers).toHaveBeenCalledWith({
      organizationId: 7,
      broadcastId: 21,
      change: { skipped: -1 },
    });
    repository.reopenOwnerChat.mockResolvedValueOnce(null);
    expect(await service.addChatOpenedRecipient(key)).toBe('unchanged');
    repository.findBroadcast.mockResolvedValueOnce({ ...BROADCAST, status: 'cancelled' });
    expect(await service.addChatOpenedRecipient(key)).toBe('unchanged');
  });

  it('her erasure, a cancel piece and her reply add to each broadcast its own count', async () => {
    repository.skipWaitingOfContact.mockResolvedValueOnce([21, 22, 21]);
    expect(
      await service.skipContactWaitingRecipients({
        databaseHandle,
        organizationId: 7,
        contactId: 3,
        reason: 'contact_deleted',
      }),
    ).toBe(3);
    expect(repository.addToBroadcastNumbers).toHaveBeenCalledWith({
      organizationId: 7,
      broadcastId: 21,
      change: { skipped: 2 },
    });
    expect(repository.addToBroadcastNumbers).toHaveBeenCalledWith({
      organizationId: 7,
      broadcastId: 22,
      change: { skipped: 1 },
    });

    repository.skipWaitingOfBroadcast.mockResolvedValueOnce(4);
    expect(
      await service.skipBroadcastWaitingRecipients({
        databaseHandle,
        organizationId: 7,
        broadcastId: 21,
        reason: 'cancelled',
        limit: 500,
      }),
    ).toBe(4);

    repository.recordReply.mockResolvedValueOnce([22]);
    expect(
      await service.recordContactReply({ organizationId: 7, contactId: 3, repliedAt: new Date() }),
    ).toBe(1);
    expect(repository.addToBroadcastNumbers).toHaveBeenLastCalledWith({
      organizationId: 7,
      broadcastId: 22,
      change: { replies: 1 },
    });
  });
});
