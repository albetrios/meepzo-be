import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationRun,
  nextInstagramObjectId,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  insertInstagramOutgoingMessage,
  readInstagramOutgoingMessages,
} from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/__tests__/factories/instagram-outgoing-message.factory.js';
import { insertLanes } from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import { InstagramOutgoingMessageService } from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/instagram-outgoing-message.service.js';
import { InstagramMediaService } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.service.js';
import { InstagramMediaRepository } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.repository.js';
import { InstagramSendingWatchService } from '@/domains/app/sub-domains/instagram-sending/instagram-sending-watch.service.js';
import { InstagramSendGateService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-gate.service.js';
import { InstagramSendLaneRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.repository.js';
import { InstagramSendLaneService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.service.js';
import { InstagramSendStopRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-stop.repository.js';
import { SendingStateService } from '@/domains/app/sub-domains/instagram-sending/sending-state.service.js';
import type { InstagramSendAccess } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import {
  rebuildInstagramGateOneFromPostgres,
  runInstagramSendingWatchDuty,
} from '@/domains/app/sub-domains/instagram-sending/workers/instagram-sending-watch.processor.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type TestAccount = Awaited<ReturnType<typeof insertInstagramAccount>>;

const LIVE_MEDIA_ID = '17955500000000001';
const OTHER_LIVE_MEDIA_ID = '17955500000000002';

/**
 * The watches on the repair queue against the database (feat-instagram-dm-sending routes-final § 6
 * SN6, SNC5, SNC9; WC-16, WC-21, WC-22, WC-24 — ROUTE row R48; AC-16.18, AC-17.24): the outage
 * watch's all-accounts stop and its 24-hour reset, the Live check's `live_ended` expiry, the waiting
 * estimate stored on the slow lane, the gate 1 rebuild from the minute counts — and that running
 * each twice changes nothing more. The Meta Live read is a fake; the services are the real ones.
 */
describe('instagram sending watches (database)', () => {
  let organization: { id: number; public_id: string };
  let account: TestAccount;
  let sendingState: SendingStateService;
  let onAir: string[];
  let liveReads: number;
  let recorded: Array<{ result: string; reason: string | null }>;

  function accessOf(): InstagramSendAccess {
    return {
      channelAccount: {
        organizationId: organization.id,
        channelAccountId: account.channel_account_id,
      },
      channelAccountPublicId: account.public_id,
      channelConnection: { organizationId: organization.id, channelConnectionId: 1 },
      channelConnectionPublicId: null,
      clientBusinessId: null,
      instagramUserId: `1784${account.channel_account_id}`,
      encryptedAccessToken: 'ciphertext',
      isSendable: true,
    };
  }

  function buildWatchService(): InstagramSendingWatchService {
    return new InstagramSendingWatchService({
      sendingStateService: {
        startAllAccountsDownStop: (input) => sendingState.startAllAccountsDownStop(input),
        resetQuietAllStop: (input) => sendingState.resetQuietAllStop(input),
        readAllAccountsStop: (now) => sendingState.readAllAccountsStop(now),
        mayTakeTickets: async () => true,
      },
      accessService: {
        readSendAccess: async () => accessOf(),
        buildUsageRecorder: () => undefined,
      },
      messageService: new InstagramOutgoingMessageService({
        recordRunMessageResult: async (input) => {
          recorded.push({ result: input.result, reason: input.reason });
        },
        recordBroadcastMessageResult: async () => undefined,
      }),
      mediaService: new InstagramMediaService(
        new InstagramMediaRepository(),
        {} as never,
        { markConnectionBroken: async () => false } as never,
      ),
      listLiveMedia: async () => {
        liveReads += 1;
        return { items: onAir.map((id) => ({ id })), nextCursor: null };
      },
    });
  }

  const dependencies = () => ({
    watchService: buildWatchService(),
    runInDatabaseSlot: <T>(callback: () => Promise<T>) => callback(),
  });

  async function liveReply({
    mediaId,
    commentAgeMinutes = 5,
  }: {
    mediaId: string;
    commentAgeMinutes?: number;
  }) {
    const contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    const automation = await insertAutomation({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
      status: 'live',
    });
    const occurredAt = new Date(Date.now() - commentAgeMinutes * 60_000);
    const run = await insertAutomationRun({
      organizationId: organization.id,
      automationId: automation.id,
      contactId: contact.id,
      trigger_type: 'live_comment',
      trigger_instagram_media_id: mediaId,
      trigger_instagram_comment_id: nextInstagramObjectId(),
      trigger_occurred_at: occurredAt,
    });
    return insertInstagramOutgoingMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_type: 'opening_message',
      message_number: null,
      lane: 'fast',
      channel: 'private_reply',
      is_counted_as_direct_message: true,
      status: 'waiting',
      reason: null,
      trigger_occurred_at: occurredAt,
    });
  }

  async function waitingOpening({ hoursOld }: { hoursOld: number }) {
    const contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    const automation = await insertAutomation({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
      status: 'live',
    });
    const run = await insertAutomationRun({
      organizationId: organization.id,
      automationId: automation.id,
      contactId: contact.id,
    });
    return insertInstagramOutgoingMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_type: 'opening_message',
      message_number: null,
      lane: 'slow',
      channel: 'private_reply',
      is_counted_as_direct_message: true,
      status: 'waiting',
      reason: null,
      trigger_occurred_at: new Date(Date.now() - hoursOld * 3_600_000),
    });
  }

  async function slowLane() {
    const rows = await new InstagramSendLaneRepository().listByAccount({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
    });
    return rows.find((row) => row.lane === 'slow')!;
  }

  async function addAttempts({ total, bad }: { total: number; bad: number }) {
    await operatorQuery`
      INSERT INTO app.instagram_send_attempts
        (organization_id, channel_account_id, instagram_message_id, contact_id, lane, count_group,
         started_at, result_group)
      SELECT ${organization.id}, ${account.channel_account_id}, n, 1, 'slow', 'open', now(),
             CASE WHEN n <= ${bad} THEN 'no_answer' ELSE 'sent' END
      FROM generate_series(1, ${total}) AS n`;
  }

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    await insertLanes({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
    });
    sendingState = new SendingStateService({ readClockSkewMilliseconds: () => 0 });
    await sendingState.ensureSendingState({ environmentId: 'test' });
    onAir = [];
    liveReads = 0;
    recorded = [];
  });

  describe('outage-check (WC-22)', () => {
    it('stops every account when 30 % of at least 50 calls in 30 s were bad — and a second run changes nothing', async () => {
      await addAttempts({ total: 50, bad: 15 });
      await runInstagramSendingWatchDuty({ duty: 'outage-check', dependencies: dependencies() });
      const stop = await sendingState.readAllAccountsStop();
      expect(stop?.reason).toBe('instagram_down');
      const minutes = (stop!.until.getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(4);
      expect(minutes).toBeLessThanOrEqual(5);
      await runInstagramSendingWatchDuty({ duty: 'outage-check', dependencies: dependencies() });
      const again = await sendingState.readSendingState();
      expect(again?.all_stop_count).toBe(1);
      expect(again?.all_stop_until?.getTime()).toBe(stop!.until.getTime());
    });

    it('does not stop under 50 calls or under 30 % bad', async () => {
      await addAttempts({ total: 49, bad: 49 });
      await runInstagramSendingWatchDuty({ duty: 'outage-check', dependencies: dependencies() });
      expect(await sendingState.readAllAccountsStop()).toBeNull();
      await operatorQuery`DELETE FROM app.instagram_send_attempts`;
      await addAttempts({ total: 100, bad: 29 });
      await runInstagramSendingWatchDuty({ duty: 'outage-check', dependencies: dependencies() });
      expect(await sendingState.readAllAccountsStop()).toBeNull();
    });

    it('stops every account when 30 % of the active accounts are in a down stop', async () => {
      await operatorQuery`
        UPDATE app.instagram_send_lanes SET state = 'stopped', stop_reason = 'instagram_down',
          stop_until = now() + interval '5 minutes', stop_count = 1
        WHERE channel_account_id = ${account.channel_account_id}`;
      await runInstagramSendingWatchDuty({ duty: 'outage-check', dependencies: dependencies() });
      expect((await sendingState.readAllAccountsStop())?.reason).toBe('instagram_down');
    });

    it('puts the all-stop count back to the start after 24 quiet hours (plan §33.6 rule 4)', async () => {
      await operatorQuery`
        UPDATE app.sending_states SET all_stop_reason = 'app_limit', all_stop_count = 2,
          all_stop_until = now() - interval '25 hours'`;
      await runInstagramSendingWatchDuty({ duty: 'outage-check', dependencies: dependencies() });
      const row = await sendingState.readSendingState();
      expect(row).toMatchObject({ all_stop_count: 0, all_stop_reason: null, all_stop_until: null });
    });

    it('counts the late lanes for readiness (SNC9)', async () => {
      await operatorQuery`
        UPDATE app.instagram_send_lanes SET next_run_at = now() - interval '5 minutes'
        WHERE channel_account_id = ${account.channel_account_id} AND lane = 'slow'`;
      const { readInstagramLateLaneGauge } = await import(
        '@/domains/app/sub-domains/instagram-sending/workers/instagram-sending-watch.processor.js'
      );
      await runInstagramSendingWatchDuty({ duty: 'outage-check', dependencies: dependencies() });
      expect((await readInstagramLateLaneGauge())?.count).toBe(1);
    });
  });

  describe('live-check (WC-16, AC-16.18)', () => {
    it("expires a waiting Live reply once its Live is off air, saves the Live's end, and leaves the Live still on", async () => {
      await operatorQuery`
        INSERT INTO app.instagram_media (organization_id, channel_account_id, instagram_media_id, media_product_type, published_at)
        VALUES (${organization.id}, ${account.channel_account_id}, ${LIVE_MEDIA_ID}, 'live', now())`;
      await liveReply({ mediaId: LIVE_MEDIA_ID });
      await liveReply({ mediaId: OTHER_LIVE_MEDIA_ID });
      onAir = [OTHER_LIVE_MEDIA_ID];
      await runInstagramSendingWatchDuty({ duty: 'live-check', dependencies: dependencies() });
      expect(liveReads).toBe(1);
      const messages = await readInstagramOutgoingMessages(organization.id);
      const statuses = messages.map((message) => [message.status, message.reason]).sort();
      expect(statuses).toEqual([
        ['expired', 'live_ended'],
        ['waiting', null],
      ]);
      expect(recorded).toEqual([{ result: 'skipped', reason: 'live_ended' }]);
      const [media] = await operatorQuery<{ live_ended_at: Date | null }[]>`
        SELECT live_ended_at FROM app.instagram_media WHERE instagram_media_id = ${LIVE_MEDIA_ID}`;
      expect(media?.live_ended_at).not.toBeNull();
      // Twice changes nothing more.
      await runInstagramSendingWatchDuty({ duty: 'live-check', dependencies: dependencies() });
      expect(recorded).toHaveLength(1);
      expect(
        (await readInstagramOutgoingMessages(organization.id)).filter(
          (m) => m.status === 'waiting',
        ),
      ).toHaveLength(1);
    });

    it('expires a Live reply older than 240 minutes even while its Live is on air', async () => {
      await liveReply({ mediaId: LIVE_MEDIA_ID, commentAgeMinutes: 241 });
      onAir = [LIVE_MEDIA_ID];
      await runInstagramSendingWatchDuty({ duty: 'live-check', dependencies: dependencies() });
      expect((await readInstagramOutgoingMessages(organization.id))[0]).toMatchObject({
        status: 'expired',
        reason: 'live_ended',
      });
    });

    it('reads no Live for an account without waiting Live replies', async () => {
      await waitingOpening({ hoursOld: 1 });
      await runInstagramSendingWatchDuty({ duty: 'live-check', dependencies: dependencies() });
      expect(liveReads).toBe(0);
    });
  });

  describe('waiting-estimate (WC-24, AC-17.24)', () => {
    it("stores the account's estimate on the slow lane, rewrites it from Postgres, and sets it back to 0 when none wait", async () => {
      await waitingOpening({ hoursOld: 1 });
      await waitingOpening({ hoursOld: 167 });
      await runInstagramSendingWatchDuty({
        duty: 'waiting-estimate',
        dependencies: dependencies(),
      });
      const first = await slowLane();
      expect(first).toMatchObject({
        estimate_waiting_count: 2,
        estimate_will_go_count: 2,
        estimate_may_expire_count: 0,
      });
      expect(first.estimated_at).not.toBeNull();
      expect(first.estimate_done_at).not.toBeNull();
      await runInstagramSendingWatchDuty({
        duty: 'waiting-estimate',
        dependencies: dependencies(),
      });
      expect(await slowLane()).toMatchObject({
        estimate_waiting_count: 2,
        estimate_will_go_count: 2,
      });

      await operatorQuery`UPDATE app.instagram_outgoing_messages SET status = 'expired', reason = 'expired'
        WHERE organization_id = ${organization.id}`;
      await runInstagramSendingWatchDuty({
        duty: 'waiting-estimate',
        dependencies: dependencies(),
      });
      expect(await slowLane()).toMatchObject({
        estimate_waiting_count: 0,
        estimate_will_go_count: 0,
      });
    });

    it('under a stop with no end time, nothing will go and every waiting DM may expire (plan §12.3 step 7)', async () => {
      await waitingOpening({ hoursOld: 1 });
      await operatorQuery`UPDATE app.channel_accounts SET paused_at = now() WHERE id = ${account.channel_account_id}`;
      await runInstagramSendingWatchDuty({
        duty: 'waiting-estimate',
        dependencies: dependencies(),
      });
      expect(await slowLane()).toMatchObject({
        estimate_waiting_count: 1,
        estimate_will_go_count: 0,
        estimate_may_expire_count: 1,
      });
    });
  });

  it('rebuilds gate 1 from the last hour of minute counts after Redis was lost (WC-21)', async () => {
    await operatorQuery`
      INSERT INTO app.instagram_send_minute_counts (organization_id, channel_account_id, count_group, minute_start, count)
      VALUES (${organization.id}, ${account.channel_account_id}, 'open', date_trunc('minute', now()), 3)`;
    const written: Array<{ key: string; members: number }> = [];
    const fakeRedis = {
      zadd: async (key: string, ...members: (string | number)[]) => {
        written.push({ key, members: members.length / 2 });
        return members.length / 2;
      },
      pexpire: async () => 1,
    };
    const gateService = new InstagramSendGateService({
      laneService: new InstagramSendLaneService(
        new InstagramSendLaneRepository(),
        new InstagramSendStopRepository(),
      ),
      redis: fakeRedis as never,
    });
    const keys = await rebuildInstagramGateOneFromPostgres({
      gateService,
      runInDatabaseSlot: (callback) => callback(),
    });
    expect(keys).toBe(1);
    expect(written).toEqual([
      {
        key: `app:instagram_send_gate:${organization.public_id}:${account.public_id}:open`,
        members: 3,
      },
    ]);
  });
});
