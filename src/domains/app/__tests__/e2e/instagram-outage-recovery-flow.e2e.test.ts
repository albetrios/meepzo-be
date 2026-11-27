import { createHmac } from 'node:crypto';
import type { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import {
  WORKER_REDIS_MARKER_KEY,
  runWorkerRedisWatchTick,
} from '@/infrastructure/queue/worker-runtime/worker-redis-watch.js';
import { getEnv } from '@/shared/config/env.config.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { InstagramSendingRepairService } from '@/domains/app/sub-domains/instagram-sending/instagram-sending-repair.service.js';
import { SENDING_SETTINGS_VERSION } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import type { InstagramSendTicketContext } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import {
  readInstagramOutgoingMessages,
  readInstagramSendAttempts,
} from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/__tests__/factories/instagram-outgoing-message.factory.js';
import { addMissingInstagramSendFastMessages } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-fast.queue.js';
import { addMissingInstagramSendLaneTurns } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-slow.queue.js';
import { decideSending } from '@/domains/app/sub-domains/instagram-sending/sending-state.service.js';
import {
  rebuildInstagramGateOneFromPostgres,
  runInstagramSendingWatchDuty,
} from '@/domains/app/sub-domains/instagram-sending/workers/instagram-sending-watch.processor.js';
import { INSTAGRAM_WEBHOOK_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import { runAppPartitionUpkeepJob } from '@/domains/app/workers/app-partition-upkeep.processor.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery, withOperatorTransaction } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { injectRoute } from '@/tests/helpers/test-http-inject.helper.js';
import {
  type FlowAccount,
  emptyFlowQueues,
  openFlowQueues,
  readFlowAccount,
  readLane,
} from './instagram-broadcast-flow.helper.js';
import {
  type ConnectedInstagramTeam,
  type InstagramRefusal,
  type TestInstagramPerson,
  connectInstagramTeam,
  directMessageItem,
  liveAutomation,
  mockInstagramConversation,
  processInstagramEvents,
} from './instagram-retention-erasure.helper.js';
import { Queue as BullQueue } from 'bullmq';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const WEBHOOK_PATH = testApiPath('/app/social/channel-connections/meta/webhooks/instagram');
const MINUTE = 60_000;
/** Meta's "try later" (a code no list names, plan §33.1). */
const TRY_LATER: InstagramRefusal = [500, { error: { code: 2, message: 'try again later' } }];

/** A ticket context whose returned ticket throws, so a test sees the delay. */
class TicketReturned extends Error {
  constructor(readonly delayMilliseconds: number) {
    super('ticket returned');
  }
}
const CONTEXT: InstagramSendTicketContext = {
  jobId: 'outage-flow-ticket',
  runInDatabaseSlot: (callback) => callback(),
  returnTicket: async (delayMilliseconds) => {
    throw new TicketReturned(delayMilliseconds);
  },
};

/** The n-th person writing to the account. */
function person(n: number): TestInstagramPerson {
  return {
    instagramUserId: `178414555100${String(n).padStart(5, '0')}`,
    username: `person.${n}`,
    fullName: `Person ${n}`,
    pictureUrl: `https://scontent.cdninstagram.com/v/person-${n}.jpg`,
    email: `person${n}@example.com`,
    phone: `+1555000${String(n).padStart(4, '0')}`,
  };
}

/**
 * Flow — recovery after an outage: Meta down, Redis lost, a restore that must not send
 * (feat-instagram-dm-sending ROUTE row R62; AC-27.*; routes-final § 5 WH2, § 6 SN5–SN7, SN10, SNC5,
 * SNC8; WC-13, WC-14, WC-21, WC-22, WC-55; plan §33.4–§33.6, §35): the webhook route with Postgres
 * held, the real intake, the app container's send core (Meta via nock), the outage watch, the
 * all-accounts test and the release over 5 minutes at half speed (§33.6 rules 2–3, built here),
 * the stuck-send settle, the "Redis lost" watch and the lost-ticket repair, the sending check and
 * the partition make pass.
 */
describe('Flow — recovery after an outage (R62)', () => {
  let app: FastifyInstance;
  let queues: Queue[];
  let webhookQueue: BullQueue;
  let team: ConnectedInstagramTeam;
  let account: FlowAccount;
  let refuse: (() => InstagramRefusal | undefined) | null;
  let sends: Array<{ kind: string; body: Record<string, unknown> }>;
  /** Meta calls in order: `read` (a profile or object read) or `send`. */
  let calls: string[];

  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: team.organization.public_id });
  const repairContext = () => ({ now: new Date(), isBudgetSpent: () => false });
  const repairService = () =>
    new InstagramSendingRepairService({
      messageService: app.appDomain.instagramOutgoingMessageService,
      gateService: app.appDomain.instagramSendGateService,
      addLaneTurns: addMissingInstagramSendLaneTurns,
      addFastMessages: addMissingInstagramSendFastMessages,
      runInDatabaseSlot: (callback) => callback(),
      jobScopeFor: (organizationPublicId) => PRINCIPAL_SCOPE.JOB({ organizationPublicId }),
    });

  /** People write "catalog" to the account: Meta delivers it, intake runs (a fast answer waits). */
  async function peopleWrite(people: TestInstagramPerson[]): Promise<void> {
    const response = await deliver(
      people.map((one) => directMessageItem({ person: one, text: 'catalog' })),
    );
    expect(response.statusCode).toBe(200);
    await processInstagramEvents({ app, team });
  }

  /** Meta delivers `messaging` items over route 61, signed. */
  async function deliver(messaging: readonly Record<string, unknown>[], rawBody?: string) {
    const body =
      rawBody ??
      JSON.stringify({
        object: 'instagram',
        entry: [{ id: team.profile.user_id, time: Date.now(), messaging }],
      });
    const signature = createHmac('sha256', getEnv().META_APP_SECRET ?? '')
      .update(body)
      .digest('hex');
    return injectRoute(app, {
      method: 'POST',
      url: WEBHOOK_PATH,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}` },
      payload: Buffer.from(body),
    });
  }

  async function waitingFast() {
    return (await readInstagramOutgoingMessages(team.organization.id)).filter(
      (row) => row.lane === 'fast' && row.status === 'waiting',
    );
  }

  /** One fast message's ticket through the app's send core, its wait over; the returned delay. */
  async function sendFast(publicId: string): Promise<number | null> {
    await operatorQuery`
      UPDATE app.instagram_outgoing_messages SET not_before = now() - interval '1 second'
      WHERE public_id = ${publicId} AND status = 'waiting'`;
    const message = (await readInstagramOutgoingMessages(team.organization.id)).find(
      (row) => row.public_id === publicId,
    )!;
    try {
      await app.appDomain.instagramSendWork.fastMessage!.sendFastMessage({
        ticket: {
          organizationPublicId: team.organization.public_id,
          channelAccountPublicId: account.channelAccountPublicId,
          instagramMessagePublicId: message.public_id,
          automationRunStartedAt: message.automation_run_started_at.toISOString(),
          tries: message.tries,
        },
        scope: scope(),
        context: CONTEXT,
      });
      return null;
    } catch (error) {
      if (error instanceof TicketReturned) return error.delayMilliseconds;
      throw error;
    }
  }

  async function sendingStateRow() {
    const [row] = await operatorQuery<Array<Record<string, unknown>>>`
      SELECT * FROM app.sending_states WHERE id = 1`;
    return row!;
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    queues = openFlowQueues();
    webhookQueue = new BullQueue(INSTAGRAM_WEBHOOK_QUEUE_NAME, {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
    });
  });

  afterAll(async () => {
    await emptyFlowQueues([...queues, webhookQueue]);
    await Promise.all([...queues, webhookQueue].map((queue) => queue.close()));
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    nock.cleanAll();
    await emptyFlowQueues([...queues, webhookQueue]);
    await app.appDomain.sendingStateService.ensureSendingState({ environmentId: 'test' });
    await operatorQuery`
      UPDATE app.sending_states SET all_stop_reason = NULL, all_stop_until = NULL,
        all_stop_count = 0, testing_lane = NULL, testing_until = NULL,
        all_release_started_at = NULL, environment_id = 'test'
      WHERE id = 1`;
    team = await connectInstagramTeam(app);
    account = await readFlowAccount(team);
    await liveAutomation({ team, name: 'Catalog', trigger_type: 'dm', keywords: ['catalog'] });
    refuse = null;
    calls = [];
    const people = Array.from({ length: 8 }, (_, index) => person(index + 1));
    ({ sends } = mockInstagramConversation({
      instagramAppUserId: team.profile.id,
      people,
      onSend: async () => {
        calls.push('send');
        return refuse?.() ?? undefined;
      },
      onRead: async () => {
        calls.push('read');
      },
    }));
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('Postgres held: the webhook answers a failure and nothing reaches Redis; the redelivery saves once — and during an Instagram outage intake still decides, then the waiting answers go once (AC-27.1, AC-27.9)', async () => {
    const rawBody = JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: team.profile.user_id,
          time: Date.now(),
          messaging: [directMessageItem({ person: person(1), text: 'catalog' })],
        },
      ],
    });
    const held = await withOperatorTransaction(async (transaction) => {
      await transaction`LOCK TABLE app.instagram_webhook_event_keys IN SHARE MODE`;
      return deliver([], rawBody);
    });
    expect(held.statusCode).toBe(503);
    expect(await webhookQueue.getJobCounts('waiting', 'prioritized', 'delayed')).toEqual({
      waiting: 0,
      prioritized: 0,
      delayed: 0,
    });
    const [none] = await operatorQuery<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM app.instagram_webhook_events`;
    expect(none?.count).toBe(0);

    // Instagram is down for every account (the outage watch's stop) when Meta delivers again.
    await app.appDomain.sendingStateService.startAllAccountsDownStop();
    expect((await deliver([], rawBody)).statusCode).toBe(200);
    expect((await deliver([], rawBody)).statusCode).toBe(200);
    const [saved] = await operatorQuery<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM app.instagram_webhook_events`;
    expect(saved?.count).toBe(1);
    // Intake still decides: her run starts and its answer waits; nothing is sent while stopped.
    await processInstagramEvents({ app, team });
    const [waiting] = await waitingFast();
    expect(waiting).toBeDefined();
    expect(await sendFast(waiting!.public_id)).toBeGreaterThan(0);
    expect(sends).toHaveLength(0);

    // The outage ends: the waiting answer is the all-accounts test — the profile read first, then
    // the DM — and it goes once.
    await operatorQuery`UPDATE app.sending_states SET all_stop_until = now() - interval '1 second'`;
    calls.length = 0;
    expect(await sendFast(waiting!.public_id)).toBeNull();
    expect(calls).toEqual(['read', 'send']);
    expect(sends).toHaveLength(1);
    expect((await readInstagramOutgoingMessages(team.organization.id))[0]?.status).toBe('sent');
    expect(await sendFast(waiting!.public_id)).toBeNull();
    expect(sends).toHaveLength(1);
    expect((await sendingStateRow()).all_release_started_at).toBeInstanceOf(Date);
  });

  it('three bad results in a row stop only that account for 5 minutes; its test reads the profile first, then sends one DM (AC-27.7)', async () => {
    await peopleWrite([person(1), person(2), person(3), person(4)]);
    refuse = () => TRY_LATER;
    const messages = await waitingFast();
    expect(messages).toHaveLength(4);
    for (const message of messages.slice(0, 3)) await sendFast(message.public_id);
    expect(sends).toHaveLength(3);
    const fast = await readLane({ account, lane: 'fast' });
    expect(fast.stop_reason).toBe('instagram_down');
    const minutes = ((fast.stop_until as Date).getTime() - Date.now()) / MINUTE;
    expect(minutes).toBeGreaterThan(4);
    expect(minutes).toBeLessThanOrEqual(5);
    for (const lane of ['slow', 'reply', 'broadcast'] as const) {
      expect((await readLane({ account, lane })).stop_reason).toBe('instagram_down');
    }
    // Only that account: no all-accounts stop.
    expect((await sendingStateRow()).all_stop_reason).toBeNull();

    // After the stop: the profile read first, then one DM; the stop ends.
    refuse = null;
    calls.length = 0;
    await operatorQuery`
      UPDATE app.instagram_send_lanes SET stop_until = now() - interval '1 second'
      WHERE channel_account_id = ${account.channelAccountId}`;
    await sendFast(messages[3]!.public_id);
    expect(calls).toEqual(['read', 'send']);
    expect(sends).toHaveLength(4);
    expect((await readLane({ account, lane: 'fast' })).stop_reason).toBeNull();
  });

  it('30 % of 50 calls failing stops every account; after a good test the lanes are released over 5 minutes at half speed (AC-27.8, plan §33.6 rules 2–3)', async () => {
    await peopleWrite([person(1), person(2)]);
    await operatorQuery`
      INSERT INTO app.instagram_send_attempts
        (organization_id, channel_account_id, instagram_message_id, contact_id, lane, count_group,
         started_at, result_group)
      SELECT ${team.organization.id}, ${account.channelAccountId}, n, 1, 'slow', 'open', now(),
             CASE WHEN n <= 15 THEN 'no_answer' ELSE 'sent' END
      FROM generate_series(1, 50) AS n`;
    await runInstagramSendingWatchDuty({
      duty: 'outage-check',
      dependencies: {
        watchService: app.appDomain.instagramSendingWatchService,
        runInDatabaseSlot: (callback) => callback(),
      },
    });
    expect(await sendingStateRow()).toMatchObject({ all_stop_reason: 'instagram_down' });
    const [first, second] = await waitingFast();
    expect(await sendFast(first!.public_id)).toBeGreaterThan(0);
    expect(sends).toHaveLength(0);

    // The stop is over: the first message to wake takes the one test (profile read, then its DM).
    await operatorQuery`UPDATE app.sending_states SET all_stop_until = now() - interval '1 second'`;
    calls.length = 0;
    expect(await sendFast(first!.public_id)).toBeNull();
    expect(sends).toHaveLength(1);
    expect(calls).toEqual(['read', 'send']);
    const released = await sendingStateRow();
    expect(released.all_release_started_at).toBeInstanceOf(Date);
    expect(released.testing_lane).toBeNull();

    // The others go back one by one over 5 minutes: before its place, the fast lane waits.
    await operatorQuery`
      UPDATE app.sending_states SET all_release_started_at = now() + interval '1 second'`;
    const delay = await sendFast(second!.public_id);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(5 * MINUTE + 1000);
    expect(sends).toHaveLength(1);
    // Past its place it goes, at half speed for an hour from the release.
    await operatorQuery`
      UPDATE app.sending_states SET all_release_started_at = now() - interval '4 minutes 59 seconds'`;
    expect(await sendFast(second!.public_id)).toBeNull();
    expect(sends).toHaveLength(2);
    const halfSpeedUntil = (await readLane({ account, lane: 'fast' })).half_speed_until as Date;
    expect(halfSpeedUntil.getTime() - Date.now()).toBeGreaterThan(50 * MINUTE);
  });

  it('a restart before the sending commit sends nothing and the same message goes after the retry; after Meta answered it settles sent or unknown; an unknown is never sent again (AC-27.3, AC-27.4)', async () => {
    await peopleWrite([person(1), person(2), person(3)]);
    const [first, second, third] = await waitingFast();
    // The database goes away before the claim commits: the ticket fails, nothing is sent.
    await expect(
      withOperatorTransaction(async (transaction) => {
        await transaction`LOCK TABLE app.instagram_send_minute_counts IN EXCLUSIVE MODE`;
        await sendFast(first!.public_id);
      }),
    ).rejects.toThrow();
    expect(sends).toHaveLength(0);
    expect(await readInstagramSendAttempts(team.organization.id)).toHaveLength(0);
    expect(await sendFast(first!.public_id)).toBeNull();
    expect(sends).toHaveLength(1);

    // Two sends whose worker died after Meta answered (`sending`, past the lease): one with its
    // Instagram id → `sent`; one without → `unknown`.
    await operatorQuery`
      UPDATE app.instagram_outgoing_messages SET status = 'sending', sending_at = now() - interval '3 minutes'
      WHERE public_id IN (${second!.public_id}, ${third!.public_id})`;
    await operatorQuery`
      UPDATE app.instagram_outgoing_messages SET instagram_message_id = 'mid.answered'
      WHERE public_id = ${second!.public_id}`;
    expect((await repairService().settleStuckSends(repairContext())).done).toBe(2);
    const settled = new Map(
      (await readInstagramOutgoingMessages(team.organization.id)).map((row) => [
        row.public_id,
        row,
      ]),
    );
    expect(settled.get(second!.public_id)?.status).toBe('sent');
    expect(settled.get(third!.public_id)).toMatchObject({
      status: 'unknown',
      reason: 'worker_lost',
    });

    // No repair, retry or restart sends the unknown one again.
    await repairService().repairLostTurns(repairContext());
    await repairService().expireWaitingMessages(repairContext());
    expect(await sendFast(third!.public_id)).toBeNull();
    expect(sends).toHaveLength(1);
    expect(
      (await readInstagramOutgoingMessages(team.organization.id)).find(
        (row) => row.public_id === third!.public_id,
      )?.status,
    ).toBe('unknown');
  });

  it('Redis lost and back empty: the watch rebuilds the hour counts from Postgres, the repair gives every due message its ticket again, and the account sends only what is left of its hour (AC-27.5)', async () => {
    await operatorQuery`
      UPDATE app.instagram_account_settings SET fast_hour_limit = 3
      WHERE channel_account_id = ${account.channelAccountId}`;
    await peopleWrite([person(1), person(2)]);
    for (const message of await waitingFast()) await sendFast(message.public_id);
    expect(sends).toHaveLength(2);
    await peopleWrite([person(3), person(4)]);
    const [countGroupRow] = await operatorQuery<Array<{ count_group: string }>>`
      SELECT count_group FROM app.instagram_send_attempts LIMIT 1`;
    const countGroup = countGroupRow!.count_group as never;
    const gateCount = () =>
      app.appDomain.instagramSendGateService.readGateOneCount({
        scope: scope(),
        channelAccountPublicId: account.channelAccountPublicId,
        countGroup,
      });
    expect(await gateCount()).toBe(2);

    // Redis dies and comes back empty: the gate keys, the tickets and the marker are gone.
    const prefix = redisConnection.options.keyPrefix ?? '';
    for (const key of await redisConnection.keys(`${prefix}app:instagram_send_gate:*`)) {
      await redisConnection.del(key.slice(prefix.length));
    }
    await redisConnection.del(WORKER_REDIS_MARKER_KEY);
    await emptyFlowQueues(queues);
    expect(await gateCount()).toBe(0);

    const outcome = await runWorkerRedisWatchTick({
      clients: [redisConnection],
      rebuildSchedules: async () => undefined,
      steps: [
        {
          name: 'instagram-gate-one',
          run: async () => {
            await rebuildInstagramGateOneFromPostgres({
              gateService: app.appDomain.instagramSendGateService,
              runInDatabaseSlot: (callback) => callback(),
            });
          },
        },
      ],
    });
    expect(outcome).toBe('rebuilt');
    expect(await gateCount()).toBe(2);

    // The lost-ticket repair: every due waiting message has its ticket again.
    await operatorQuery`
      UPDATE app.instagram_outgoing_messages SET not_before = now() - interval '2 minutes'
      WHERE organization_id = ${team.organization.id} AND status = 'waiting'`;
    await repairService().repairLostTurns(repairContext());
    const fastQueue = queues.find((queue) => queue.name === 'instagram-send-fast')!;
    const tickets = await fastQueue.getJobs(['waiting', 'prioritized', 'delayed']);
    const waiting = await waitingFast();
    expect(tickets.map((job) => job.data.instagramMessagePublicId).sort()).toEqual(
      waiting.map((row) => row.public_id).sort(),
    );

    // Only what is left of the hour: one more goes, the other waits for the hour.
    for (const message of waiting) await sendFast(message.public_id);
    expect(sends).toHaveLength(3);
    expect(await waitingFast()).toHaveLength(1);
  });

  it('a restored database sends nothing until the team switches sending on, a copy whose environment id differs never sends, and the worker start makes the parts again (AC-27.10, AC-27.11)', async () => {
    // Step 1 of the restore: SENDING_ENABLED off (the suite's value) — no server takes a ticket.
    const check = await app.appDomain.sendingStateService.checkSending();
    expect(check).toMatchObject({ maySend: false, reason: 'sending_disabled' });
    expect(await app.appDomain.sendingStateService.mayTakeTickets()).toBe(false);

    // A copy of production: the row carries production's id, whatever SENDING_ENABLED says.
    await operatorQuery`UPDATE app.sending_states SET environment_id = 'production' WHERE id = 1`;
    const row = await app.appDomain.sendingStateService.readSendingState();
    expect(
      decideSending({
        isSendingEnabled: true,
        environmentId: 'test',
        serverSettingsVersion: SENDING_SETTINGS_VERSION,
        state: row,
      }),
    ).toEqual({ maySend: false, reason: 'environment_mismatch' });

    // The worker start's make pass makes the parts a restore left behind, 14 days ahead.
    const reports = await runAppPartitionUpkeepJob({ mode: 'make' });
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) expect(report.ready_days).toBeGreaterThanOrEqual(14);
  });
});
