import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  type AutomationRunFixtureRow,
  insertAutomationRun,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  type InstagramMessageFixtureRow,
  insertInstagramMessage,
} from '@/domains/app/sub-domains/instagram-sending/instagram-message/__tests__/factories/instagram-message.factory.js';
import {
  type InstagramMessageKey,
  InstagramMessageRepository,
} from '@/domains/app/sub-domains/instagram-sending/instagram-message/instagram-message.repository.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * `app.instagram_messages` against the database (routes-final § 6.B.3, SN16): the guarded moves —
 * only a `waiting` row of the claimed lane and channel is claimed, only a `sending` row takes a
 * result or goes back to `waiting` (a repeat does nothing), cancel / skip and a lane move touch
 * `waiting` rows only — and the reads the sender and route 63 use (her sent messages of the last
 * hour, the waiting count per lane, the own-echo lookup). Every statement runs in the organization's
 * job scope (`pnpm test:rls-role` safe).
 */
describe('InstagramMessageRepository (database)', () => {
  let organizationId: number;
  let organizationPublicId: string;
  let channelAccountId: number;
  let contactId: number;
  let run: AutomationRunFixtureRow;

  function inUnit<T>(callback: (repository: InstagramMessageRepository) => Promise<T>): Promise<T> {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId }),
      callback: (databaseHandle) =>
        callback(new InstagramMessageRepository(databaseHandle as RequestScopedPostgresDatabase)),
    });
  }

  function keyOf(row: InstagramMessageFixtureRow): InstagramMessageKey {
    return {
      organizationId,
      publicId: row.public_id,
      automationRunStartedAt: row.automation_run_started_at,
    };
  }

  function waitingMessage(
    overrides: Partial<Parameters<typeof insertInstagramMessage>[0]> = {},
  ): Promise<InstagramMessageFixtureRow> {
    return insertInstagramMessage({
      run,
      channelAccountId,
      status: 'waiting',
      reason: null,
      ...overrides,
    });
  }

  beforeEach(async () => {
    await cleanupDatabase();
    const organization = await createTestOrganization({
      ownerUserId: (await createTestUser({ email: 'message-repository@example.com' })).id,
    });
    organizationId = organization.id;
    organizationPublicId = organization.public_id;
    const account = await insertInstagramAccount({ organizationId });
    channelAccountId = account.channel_account_id;
    const contact = await insertContact({ organizationId, instagramAccountId: account.id });
    contactId = contact.id;
    const automation = await insertAutomation({ organizationId, channelAccountId });
    run = await insertAutomationRun({ organizationId, automationId: automation.id, contactId });
  });

  it('claims a waiting row of the asked lane and channel only, once', async () => {
    const message = await waitingMessage();
    const key = keyOf(message);
    expect(
      await inUnit((repository) =>
        repository.claimWaiting({ key, lane: 'slow', channel: 'direct' }),
      ),
    ).toBeNull();
    expect(
      await inUnit((repository) =>
        repository.claimWaiting({ key, lane: 'fast', channel: 'private_reply' }),
      ),
    ).toBeNull();
    const claimed = await inUnit((repository) =>
      repository.claimWaiting({ key, lane: 'fast', channel: 'direct' }),
    );
    expect(claimed).toMatchObject({ status: 'sending', sending_at: expect.any(Date) });
    expect(
      await inUnit((repository) =>
        repository.claimWaiting({ key, lane: 'fast', channel: 'direct' }),
      ),
    ).toBeNull();
  });

  it('a sending row takes its result once; a repeat save changes nothing', async () => {
    const message = await waitingMessage({ status: 'sending', sending_at: new Date() });
    const key = keyOf(message);
    const result = {
      key,
      status: 'sent' as const,
      reason: null,
      instagramMessageId: 'aWdfZAG1faWQ6MTIz',
      errorCode: null,
      errorSubcode: null,
    };
    const finished = await inUnit((repository) => repository.finishSending(result));
    expect(finished).toMatchObject({
      status: 'sent',
      instagram_message_id: 'aWdfZAG1faWQ6MTIz',
      sending_at: null,
      sent_at: expect.any(Date),
    });
    expect(
      await inUnit((repository) => repository.finishSending({ ...result, status: 'failed' })),
    ).toBeNull();
    expect(await inUnit((repository) => repository.findByKey(key))).toMatchObject({
      status: 'sent',
    });
  });

  it("saves Meta's real-length message id (167 characters) as sent", async () => {
    // Meta's real `mid`s run past the 128 characters first assumed; that limit failed every save.
    const realLengthMessageId = `aWdfZAG1faWQ6${'A'.repeat(154)}`;
    expect(realLengthMessageId).toHaveLength(167);
    const message = await waitingMessage({ status: 'sending', sending_at: new Date() });
    const finished = await inUnit((repository) =>
      repository.finishSending({
        key: keyOf(message),
        status: 'sent',
        reason: null,
        instagramMessageId: realLengthMessageId,
        errorCode: null,
        errorSubcode: null,
      }),
    );
    expect(finished).toMatchObject({ status: 'sent', instagram_message_id: realLengthMessageId });
  });

  it('puts a sending row back to waiting, counting the try only when asked', async () => {
    const message = await waitingMessage({ status: 'sending', sending_at: new Date(), tries: 1 });
    const key = keyOf(message);
    const notBefore = new Date(Date.now() + 60_000);
    const back = await inUnit((repository) =>
      repository.putBackWaiting({
        key,
        isTryUsed: true,
        notBefore,
        errorCode: 2,
        errorSubcode: null,
      }),
    );
    expect(back).toMatchObject({ status: 'waiting', tries: 2, sending_at: null, error_code: 2 });
    expect(back?.not_before?.getTime()).toBe(notBefore.getTime());
    expect(
      await inUnit((repository) =>
        repository.putBackWaiting({
          key,
          isTryUsed: false,
          notBefore,
          errorCode: null,
          errorSubcode: null,
        }),
      ),
    ).toBeNull();
  });

  it('cancels and moves waiting rows only', async () => {
    const waiting = await waitingMessage();
    const sent = await waitingMessage({
      message_number: 2,
      status: 'sent',
      sent_at: new Date(),
      instagram_message_id: 'mid-sent',
    });
    expect(
      await inUnit((repository) =>
        repository.moveLane({ key: keyOf(sent), lane: 'slow', channel: 'private_reply' }),
      ),
    ).toBe(false);
    expect(
      await inUnit((repository) =>
        repository.moveLane({ key: keyOf(waiting), lane: 'slow', channel: 'private_reply' }),
      ),
    ).toBe(true);
    expect(
      await inUnit((repository) =>
        repository.endWaiting({
          selection: { organizationId, by: 'run', id: run.id },
          status: 'cancelled',
          reason: 'cancelled_by_owner',
        }),
      ),
    ).toBe(1);
    expect(await inUnit((repository) => repository.findByKey(keyOf(waiting)))).toMatchObject({
      status: 'cancelled',
      lane: 'slow',
    });
    expect(await inUnit((repository) => repository.findByKey(keyOf(sent)))).toMatchObject({
      status: 'sent',
    });
  });

  it("reads her sent messages of the last hour, the waiting count per lane and the account's own ids", async () => {
    await waitingMessage();
    await waitingMessage({ message_number: 2, lane: 'slow', channel: 'private_reply' });
    await waitingMessage({
      message_number: 3,
      status: 'sent',
      sent_at: new Date(),
      instagram_message_id: 'mid-recent',
    });
    await waitingMessage({
      message_number: 4,
      status: 'sent',
      sent_at: new Date(Date.now() - 2 * 60 * 60_000),
      instagram_message_id: 'mid-old',
    });
    expect(
      await inUnit((repository) =>
        repository.countSentToContactInLastHour({ organizationId, contactId }),
      ),
    ).toBe(1);
    const byLane = await inUnit((repository) =>
      repository.countWaitingByLane({ organizationId, channelAccountId }),
    );
    expect(byLane.sort((left, right) => left.lane.localeCompare(right.lane))).toEqual([
      { lane: 'fast', count: 1 },
      { lane: 'slow', count: 1 },
    ]);
    const own = await inUnit((repository) =>
      repository.findOwnSentMessageIds({
        organizationId,
        channelAccountId,
        messageIds: ['mid-recent', 'mid-old', 'mid-someone-else'],
      }),
    );
    expect(own.sort()).toEqual(['mid-old', 'mid-recent']);
    expect(
      await inUnit((repository) =>
        repository.findOwnSentMessageIds({ organizationId, channelAccountId, messageIds: [] }),
      ),
    ).toEqual([]);
  });
});
