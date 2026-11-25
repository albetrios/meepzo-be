import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepairDutyContext } from '@/infrastructure/queue/worker-runtime/repair-duty.util.js';
import type { ChannelMessageResultInput } from '@/domains/app/app.channel-ports.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { insertAutomationRun } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  insertInstagramMessage,
  readInstagramMessages,
} from '@/domains/app/sub-domains/instagram-sending/instagram-message/__tests__/factories/instagram-message.factory.js';
import { insertLanes } from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import { InstagramMessageService } from '@/domains/app/sub-domains/instagram-sending/instagram-message/instagram-message.service.js';
import {
  type InstagramRepairFastTicket,
  type InstagramRepairLaneTicket,
  InstagramSendingRepairService,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending-repair.service.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * The sending repair duties against the database (feat-instagram-dm-sending § 6 SN6, SNC5 — ROUTE
 * row R47; WC-13–WC-15, WC-17–WC-20; AC-17.13, AC-17.19, AC-6.15): each duty repairs what it owns,
 * and running it twice changes nothing (SNC5's DB test per duty). The reads run under the
 * global-retention arm, each change in the organization's job scope (`pnpm test:rls-role` safe);
 * the queues' "add missing" producers are recorders.
 */
describe('InstagramSendingRepairService (database)', () => {
  let organization: { id: number; public_id: string };
  let account: Awaited<ReturnType<typeof insertInstagramAccount>>;
  let run: Awaited<ReturnType<typeof insertAutomationRun>>;
  let automation: Awaited<ReturnType<typeof insertAutomation>>;
  let recorded: ChannelMessageResultInput[];
  let laneTickets: InstagramRepairLaneTicket[];
  let fastTickets: InstagramRepairFastTicket[];
  let service: InstagramSendingRepairService;

  const context = (): RepairDutyContext => ({ now: new Date(), isBudgetSpent: () => false });

  async function laneOf(lane: string) {
    const [row] = await operatorQuery<
      { state: string; turn_number: number; next_run_at: Date | null; sending_count: number }[]
    >`
      SELECT state, turn_number::int, next_run_at, sending_count FROM app.instagram_send_lanes
      WHERE channel_account_id = ${account.channel_account_id} AND lane = ${lane}`;
    return row!;
  }

  async function messageOf(publicId: string) {
    const rows = await readInstagramMessages(organization.id);
    return rows.find((row) => row.public_id === publicId)!;
  }

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    await insertLanes({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
    });
    const contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      last_direct_message_received_at: new Date(),
    });
    automation = await insertAutomation({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
      status: 'live',
    });
    run = await insertAutomationRun({
      organizationId: organization.id,
      automationId: automation.id,
      contactId: contact.id,
    });
    recorded = [];
    laneTickets = [];
    fastTickets = [];
    service = new InstagramSendingRepairService({
      jobScopeFor: (organizationPublicId) => PRINCIPAL_SCOPE.JOB({ organizationPublicId }),
      messageService: new InstagramMessageService({
        recordRunMessageResult: async (input) => {
          recorded.push(input);
        },
        recordBroadcastMessageResult: async () => undefined,
      }),
      gateService: { readGateOneCount: async () => 0 },
      addLaneTurns: async (tickets) => {
        laneTickets.push(...tickets);
        return { added: tickets.length };
      },
      addFastMessages: async (tickets) => {
        fastTickets.push(...tickets);
        return { added: tickets.length };
      },
      runInDatabaseSlot: (callback) => callback(),
    });
  });

  it('settles a send past its lease as unknown · worker_lost, one with a Meta id as sent, a follow check back to waiting — and a second run changes nothing (WC-14, AC-17.19, D17)', async () => {
    const sendingAt = new Date(Date.now() - 3 * MINUTE);
    const lost = await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      status: 'sending',
      reason: null,
      sending_at: sendingAt,
    });
    const answered = await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_number: 2,
      status: 'sending',
      reason: null,
      sending_at: sendingAt,
      instagram_message_id: 'mid.lost-save',
    });
    const followCheck = await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_type: 'follow_check',
      message_number: null,
      channel: null,
      is_counted_as_direct_message: false,
      status: 'sending',
      reason: null,
      sending_at: sendingAt,
    });
    const fresh = await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_number: 3,
      status: 'sending',
      reason: null,
      sending_at: new Date(),
    });

    expect((await service.settleStuckSends(context())).done).toBe(3);
    expect(await messageOf(lost.public_id)).toMatchObject({
      status: 'unknown',
      reason: 'worker_lost',
    });
    expect(await messageOf(answered.public_id)).toMatchObject({ status: 'sent', reason: null });
    expect(await messageOf(followCheck.public_id)).toMatchObject({ status: 'waiting' });
    expect(await messageOf(fresh.public_id)).toMatchObject({ status: 'sending' });
    expect(recorded.map((entry) => entry.result).sort()).toEqual(['sent', 'unknown']);

    expect((await service.settleStuckSends(context())).done).toBe(0);
    expect(recorded).toHaveLength(2);
  });

  it('releases a lane whose turn lease ran out with a new turn and its ticket, once (WC-14, AC-17.19)', async () => {
    await operatorQuery`
      UPDATE app.instagram_send_lanes SET state = 'working', working_turn = 0,
        lease_until = now() - interval '1 minute'
      WHERE channel_account_id = ${account.channel_account_id} AND lane = 'slow'`;
    expect((await service.settleStuckSends(context())).done).toBe(1);
    expect(await laneOf('slow')).toMatchObject({ state: 'sleeping', turn_number: 1 });
    expect(laneTickets).toEqual([
      expect.objectContaining({
        lane: 'slow',
        turnNumber: 1,
        channelAccountPublicId: account.public_id,
      }),
    ]);
    expect((await service.settleStuckSends(context())).done).toBe(0);
    expect(laneTickets).toHaveLength(1);
  });

  it('re-adds a late turn, wakes an idle lane with work, re-adds a late fast message and fixes the fast count (WC-13, AC-17.19)', async () => {
    await operatorQuery`
      UPDATE app.instagram_send_lanes SET state = 'sleeping', next_run_at = now() - interval '5 minutes'
      WHERE channel_account_id = ${account.channel_account_id} AND lane = 'slow'`;
    await operatorQuery`
      UPDATE app.instagram_send_lanes SET state = 'sleeping', next_run_at = NULL
      WHERE channel_account_id = ${account.channel_account_id} AND lane = 'reply'`;
    await operatorQuery`
      UPDATE app.instagram_send_lanes SET sending_count = 3
      WHERE channel_account_id = ${account.channel_account_id} AND lane = 'fast'`;
    await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_type: 'public_reply',
      message_number: null,
      lane: 'reply',
      channel: 'comment_reply',
      is_counted_as_direct_message: false,
      status: 'waiting',
      reason: null,
    });
    const late = await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      status: 'waiting',
      reason: null,
      not_before: new Date(Date.now() - 5 * MINUTE),
    });

    const first = await service.repairLostTurns(context());
    expect(first.done).toBe(4);
    expect(laneTickets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lane: 'slow', turnNumber: 0 }),
        expect.objectContaining({ lane: 'reply', turnNumber: 1 }),
      ]),
    );
    expect(await laneOf('reply')).toMatchObject({ state: 'ready', turn_number: 1 });
    expect(fastTickets).toEqual([
      expect.objectContaining({ instagramMessagePublicId: late.public_id, tries: 0 }),
    ]);
    expect((await laneOf('fast')).sending_count).toBe(0);

    // The idle lane and the count are repaired; a ticket still late is offered again — the queue's
    // job id keeps a present one (late but present) from being added twice.
    laneTickets = [];
    fastTickets = [];
    await service.repairLostTurns(context());
    expect(laneTickets).toEqual([expect.objectContaining({ lane: 'slow', turnNumber: 0 })]);
    expect(await laneOf('reply')).toMatchObject({ turn_number: 1 });
  });

  it('expires a waiting opening DM 7 days minus 30 minutes after its comment, plan_limit behind the month limit, never twice (WC-15, AC-17.13)', async () => {
    const old = new Date(Date.now() - 7 * DAY);
    const opening = await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_type: 'opening_message',
      message_number: null,
      lane: 'slow',
      channel: 'private_reply',
      status: 'waiting',
      reason: null,
      trigger_occurred_at: old,
    });
    const young = await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_type: 'public_reply',
      message_number: null,
      lane: 'reply',
      channel: 'comment_reply',
      is_counted_as_direct_message: false,
      status: 'waiting',
      reason: null,
      trigger_occurred_at: new Date(Date.now() - 6 * DAY),
    });
    expect((await service.expireWaitingMessages(context())).done).toBe(1);
    expect(await messageOf(opening.public_id)).toMatchObject({
      status: 'expired',
      reason: 'expired',
    });
    expect(await messageOf(young.public_id)).toMatchObject({ status: 'waiting' });
    expect(recorded).toEqual([expect.objectContaining({ result: 'skipped', reason: 'expired' })]);
    expect((await service.expireWaitingMessages(context())).done).toBe(0);

    await operatorQuery`
      UPDATE app.channel_accounts SET plan_stop_reason = 'plan_limit', plan_stopped_at = now()
      WHERE id = ${account.channel_account_id}`;
    const behindLimit = await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_type: 'hide_comment',
      message_number: null,
      lane: 'reply',
      channel: 'comment_hide',
      is_counted_as_direct_message: false,
      status: 'waiting',
      reason: null,
      trigger_occurred_at: old,
    });
    expect((await service.expireWaitingMessages(context())).done).toBe(1);
    expect(await messageOf(behindLimit.public_id)).toMatchObject({
      status: 'expired',
      reason: 'plan_limit',
    });
  });

  it('skips a waiting DM whose chat window closed and leaves an open one waiting (WC-17)', async () => {
    const closedContact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      last_direct_message_received_at: new Date(Date.now() - 2 * DAY),
    });
    const closedRun = await insertAutomationRun({
      organizationId: organization.id,
      automationId: automation.id,
      contactId: closedContact.id,
    });
    const closed = await insertInstagramMessage({
      run: closedRun,
      channelAccountId: account.channel_account_id,
      message_type: 'nudge',
      message_number: null,
      status: 'waiting',
      reason: null,
    });
    const open = await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      status: 'waiting',
      reason: null,
    });
    expect((await service.skipClosedWindows(context())).done).toBe(1);
    expect(await messageOf(closed.public_id)).toMatchObject({
      status: 'skipped',
      reason: 'window_closed',
    });
    expect(await messageOf(open.public_id)).toMatchObject({ status: 'waiting' });
    expect((await service.skipClosedWindows(context())).done).toBe(0);
  });

  it('trims a "Reply like a person" automation to its limit of waiting replies, oldest first, hides kept (WC-18)', async () => {
    // The limit is 500 in the settings; a small one keeps the fixture short.
    const trimming = new InstagramSendingRepairService({
      jobScopeFor: (organizationPublicId) => PRINCIPAL_SCOPE.JOB({ organizationPublicId }),
      messageService: new InstagramMessageService({
        recordRunMessageResult: async (input) => {
          recorded.push(input);
        },
        recordBroadcastMessageResult: async () => undefined,
      }),
      gateService: { readGateOneCount: async () => 0 },
      addLaneTurns: async () => ({ added: 0 }),
      addFastMessages: async () => ({ added: 0 }),
      runInDatabaseSlot: (callback) => callback(),
      replyBacklogMax: 2,
    });
    await operatorQuery`
      UPDATE app.automations SET is_reply_like_person_enabled = true WHERE id = ${automation.id}`;
    const replies = [];
    for (let index = 0; index < 4; index += 1) {
      const contact = await insertContact({
        organizationId: organization.id,
        instagramAccountId: account.id,
      });
      const replyRun = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
      });
      replies.push(
        await insertInstagramMessage({
          run: replyRun,
          channelAccountId: account.channel_account_id,
          message_type: 'public_reply',
          message_number: null,
          lane: 'reply',
          channel: 'comment_reply',
          is_counted_as_direct_message: false,
          status: 'waiting',
          reason: null,
          created_at: new Date(Date.now() - (10 - index) * MINUTE),
        }),
      );
    }
    const hide = await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_type: 'hide_comment',
      message_number: null,
      lane: 'reply',
      channel: 'comment_hide',
      is_counted_as_direct_message: false,
      status: 'waiting',
      reason: null,
    });
    await operatorQuery`
      INSERT INTO app.automation_reply_states (organization_id, automation_id, channel_account_id,
        waiting_count)
      VALUES (${organization.id}, ${automation.id}, ${account.channel_account_id}, 4)`;

    expect((await trimming.trimReplyBacklog(context())).done).toBe(2);
    for (const [index, reply] of replies.entries()) {
      expect(await messageOf(reply.public_id)).toMatchObject(
        index < 2 ? { status: 'skipped', reason: 'hour_limit' } : { status: 'waiting' },
      );
    }
    expect(await messageOf(hide.public_id)).toMatchObject({ status: 'waiting' });
    const [state] = await operatorQuery<{ waiting_count: number }[]>`
      SELECT waiting_count FROM app.automation_reply_states WHERE automation_id = ${automation.id}`;
    expect(state?.waiting_count).toBe(2);
    expect((await trimming.trimReplyBacklog(context())).done).toBe(0);
  });

  it('cancels the waiting messages made before a pause with Cancel, not the ones after (WC-19, AC-6.15)', async () => {
    const before = await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      status: 'waiting',
      reason: null,
      created_at: new Date(Date.now() - 10 * MINUTE),
    });
    await operatorQuery`
      UPDATE app.automations SET status = 'paused', cancelled_before_at = now() - interval '5 minutes'
      WHERE id = ${automation.id}`;
    const after = await insertInstagramMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_number: 2,
      status: 'waiting',
      reason: null,
    });
    expect((await service.cancelPausedAutomationMessages(context())).done).toBe(1);
    expect(await messageOf(before.public_id)).toMatchObject({
      status: 'cancelled',
      reason: 'cancelled_by_owner',
    });
    expect(await messageOf(after.public_id)).toMatchObject({ status: 'waiting' });
    expect((await service.cancelPausedAutomationMessages(context())).done).toBe(0);
  });

  it('deletes minute counts over 2 hours old and keeps the rest (WC-20)', async () => {
    await operatorQuery`
      INSERT INTO app.instagram_send_minute_counts (organization_id, channel_account_id, count_group,
        minute_start, count)
      VALUES
        (${organization.id}, ${account.channel_account_id}, 'open', date_trunc('minute', now() - interval '3 hours'), 4),
        (${organization.id}, ${account.channel_account_id}, 'open', date_trunc('minute', now()), 2)`;
    expect((await service.keepSendCounts({ ...context(), isDailyCheck: true })).done).toBe(1);
    const [left] = await operatorQuery<{ total: number }[]>`
      SELECT count(*)::int AS total FROM app.instagram_send_minute_counts
      WHERE channel_account_id = ${account.channel_account_id}`;
    expect(left?.total).toBe(1);
    expect((await service.keepSendCounts({ ...context(), isDailyCheck: false })).done).toBe(0);
  });
});
