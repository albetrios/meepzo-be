import { randomUUID } from 'node:crypto';
import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import {
  type ChannelFailedMessagesRetry,
  type ChannelMessageResult,
  type ChannelSendingPort,
  type ChannelWaitingMessageSelection,
  type SaveWaitingMessageInput,
  type SaveWaitingMessageResult,
  emptyFailedMessagesSummary,
} from '@/domains/app/app.channel-ports.js';
import type { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';

/**
 * The read and retry side of a fake sending port (routes 24–26, 36–37): no messages, nothing failed.
 * The engine never calls these; a fake port spreads them in.
 */
export const EMPTY_MESSAGE_HISTORY_PORT_PARTS = {
  listContactMessages: async () => [],
  summarizeFailedMessages: async () => emptyFailedMessagesSummary(),
  retryFailedMessages: async (): Promise<ChannelFailedMessagesRetry> => ({
    summary: emptyFailedMessagesSummary(),
    expectedRetryCount: 0,
    isQueued: false,
  }),
};

/** One waiting message the engine saved through the port (the handle left out). */
export type RecordedWaitingMessage = Omit<SaveWaitingMessageInput, 'databaseHandle'> & {
  messagePublicId: string;
};

/**
 * A channel's sending port, faked for the run engine's tests (feat-instagram-dm-sending AU35): every
 * saved waiting message, cancel and skip recorded in order; the next saves may be answered `skipped`.
 * Sending is the channel's sub-domain (ROUTE rows R19–R20) — here a test reports each result itself
 * with {@link reportMessageResult}.
 */
export class RecordingSendingPort implements ChannelSendingPort {
  readonly saved: RecordedWaitingMessage[] = [];
  readonly cancelled: Array<Omit<ChannelWaitingMessageSelection, 'databaseHandle'>> = [];
  readonly skipped: Array<Omit<ChannelWaitingMessageSelection, 'databaseHandle'>> = [];
  /** Reasons the next saves answer `skipped` with (one per save). */
  readonly nextSkips: string[] = [];

  async saveWaitingMessage(input: SaveWaitingMessageInput): Promise<SaveWaitingMessageResult> {
    const { databaseHandle: _databaseHandle, ...rest } = input;
    const skip = this.nextSkips.shift();
    if (skip !== undefined) return { messagePublicId: null, status: 'skipped', reason: skip };
    const messagePublicId = `igm_${randomUUID().replaceAll('-', '').slice(0, 21)}`;
    this.saved.push({ ...rest, messagePublicId });
    return { messagePublicId, status: 'waiting' };
  }

  async cancelWaitingMessages(input: ChannelWaitingMessageSelection): Promise<number> {
    const { databaseHandle: _databaseHandle, ...rest } = input;
    this.cancelled.push(rest);
    return 0;
  }

  async skipWaitingMessages(input: ChannelWaitingMessageSelection): Promise<number> {
    const { databaseHandle: _databaseHandle, ...rest } = input;
    this.skipped.push(rest);
    return 0;
  }

  readonly listContactMessages = EMPTY_MESSAGE_HISTORY_PORT_PARTS.listContactMessages;
  readonly summarizeFailedMessages = EMPTY_MESSAGE_HISTORY_PORT_PARTS.summarizeFailedMessages;
  readonly retryFailedMessages = EMPTY_MESSAGE_HISTORY_PORT_PARTS.retryFailedMessages;

  /** How many of {@link saved} {@link sendAll} has sent. */
  sentCount = 0;

  /**
   * The channel's sending sub-domain, faked (AU35): every saved message not sent yet is "sent" and
   * its result reported, until none is left — a follow check answers "following", a nudge waits its
   * hour and is never sent here. Answers how many it sent.
   */
  async sendAll({
    service,
    scope,
    organizationId,
  }: {
    service: Pick<AutomationRunService, 'recordMessageResult'>;
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
  }): Promise<number> {
    let sent = 0;
    while (this.sentCount < this.saved.length) {
      const message = this.saved[this.sentCount] as RecordedWaitingMessage;
      this.sentCount += 1;
      if (message.step === 'nudge') continue;
      await reportMessageResult({
        service,
        scope,
        organizationId,
        message,
        result: 'sent',
        reason: message.step === 'follow_check' ? 'following' : null,
      });
      sent += 1;
    }
    return sent;
  }

  /** The saved messages' steps, in order (`hello`, `public_reply`, `messages#1`, …). */
  steps(): string[] {
    return this.saved.map((message) =>
      message.messageNumber === null ? message.step : `${message.step}#${message.messageNumber}`,
    );
  }

  /** The last saved message of a step. */
  last(step: SaveWaitingMessageInput['step']): RecordedWaitingMessage {
    const found = [...this.saved].reverse().find((message) => message.step === step);
    if (found === undefined) throw new Error(`no ${step} message was saved`);
    return found;
  }
}

/**
 * Reports a saved message's final result to the engine as the channel's sending sub-domain does
 * (AU35 — in its own commit here, with its job's scope).
 */
export async function reportMessageResult({
  service,
  scope,
  organizationId,
  message,
  result,
  reason = null,
  occurredAt = new Date(),
}: {
  service: Pick<AutomationRunService, 'recordMessageResult'>;
  scope: OrganizationPrincipalDatabaseScope;
  organizationId: number;
  message: RecordedWaitingMessage;
  result: ChannelMessageResult;
  reason?: string | null;
  occurredAt?: Date;
}): Promise<void> {
  if (!('automationRunId' in message.source)) throw new Error('not a run message');
  await service.recordMessageResult({
    scope,
    // The engine joins its own unit in the scope; the handle is the channel's.
    databaseHandle: undefined as never,
    organizationId,
    channelAccountId: message.channelAccountId,
    automationRunId: message.source.automationRunId,
    automationRunStartedAt: message.source.automationRunStartedAt,
    messagePublicId: message.messagePublicId,
    step: message.step,
    messageNumber: message.messageNumber,
    result,
    reason,
    occurredAt,
  });
}
