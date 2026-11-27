import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { expect } from 'vitest';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { META_GRAPH_BASE_URL } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { broadcasts } from '@/domains/app/sub-domains/broadcast/broadcast.schema.js';
import { broadcast_recipients } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { contact_activities } from '@/domains/app/sub-domains/contact/contact-activity.schema.js';
import { nextInstagramUserId } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { readInstagramOutgoingMessages } from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/__tests__/factories/instagram-outgoing-message.factory.js';
import { insertLanes } from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import { INSTAGRAM_DATABASE_TASKS_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-database-tasks.queue.js';
import { INSTAGRAM_SEND_FAST_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-fast.queue.js';
import { INSTAGRAM_SEND_SLOW_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-slow.queue.js';
import { INSTAGRAM_TASKS_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.queue.js';
import type {
  InstagramSendTicketContext,
  InstagramTaskHandler,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import type { InstagramSendLane } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { getOperatorDatabase, operatorQuery } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import type { ConnectedInstagramTeam } from './instagram-retention-erasure.helper.js';

const HOUR = 3_600_000;

/** The queues a broadcast flow adds jobs to (emptied before and after each case). */
const FLOW_QUEUE_NAMES = [
  INSTAGRAM_DATABASE_TASKS_QUEUE_NAME,
  INSTAGRAM_TASKS_QUEUE_NAME,
  INSTAGRAM_SEND_SLOW_QUEUE_NAME,
  INSTAGRAM_SEND_FAST_QUEUE_NAME,
] as const;

/** A ticket context as a worker gives it, the slot run in place; a returned ticket throws. */
export const FLOW_TICKET_CONTEXT: InstagramSendTicketContext = {
  jobId: 'broadcast-flow-ticket',
  runInDatabaseSlot: (callback) => callback(),
  returnTicket: async (delayMilliseconds) => {
    throw new Error(`ticket returned for ${delayMilliseconds} ms`);
  },
};

/** The flow's BullMQ queues, opened on the suite's Redis namespace. */
export function openFlowQueues(): Queue[] {
  return FLOW_QUEUE_NAMES.map(
    (name) =>
      new Queue(name, { connection: getBullMQConnectionOptions(), prefix: getBullMQKeyPrefix() }),
  );
}

/** Empties every flow queue. */
export async function emptyFlowQueues(queues: readonly Queue[]): Promise<void> {
  for (const queue of queues) await queue.obliterate({ force: true });
}

/** The connected account's ids: internal channel account id and `cha_…`. */
export interface FlowAccount {
  channelAccountId: number;
  channelAccountPublicId: string;
  instagramAccountId: number;
}

/** Reads the team's channel account and makes sure its four lanes exist (the pick makes them). */
export async function readFlowAccount(team: ConnectedInstagramTeam): Promise<FlowAccount> {
  const [row] = await operatorQuery<Array<{ id: string; public_id: string }>>`
    SELECT channel_accounts.id, channel_accounts.public_id FROM app.instagram_accounts
    JOIN app.channel_accounts ON channel_accounts.id = instagram_accounts.channel_account_id
    WHERE instagram_accounts.id = ${team.account.id}`;
  if (row === undefined) throw new Error('the connected team has no channel account');
  const account = {
    channelAccountId: Number(row.id),
    channelAccountPublicId: row.public_id,
    instagramAccountId: team.account.id,
  };
  await insertLanes({
    organizationId: team.organization.id,
    channelAccountId: account.channelAccountId,
  });
  return account;
}

/**
 * Inserts `count` live contacts of the account in one statement per 500 — tagged `tags`, the chat
 * opened `openHoursAgo` hours ago (`null` = never) — and answers their internal ids in order.
 */
export async function insertAudience({
  team,
  account,
  count,
  tags,
  openHoursAgo,
}: {
  team: ConnectedInstagramTeam;
  account: FlowAccount;
  count: number;
  tags: string[];
  openHoursAgo: number | null;
}): Promise<number[]> {
  const database = getOperatorDatabase();
  const ids: number[] = [];
  for (let start = 0; start < count; start += 500) {
    const size = Math.min(500, count - start);
    const rows = await database
      .insert(contacts)
      .values(
        Array.from({ length: size }, () => ({
          public_id: generatePublicId('contact'),
          organization_id: team.organization.id,
          channel_account_id: account.channelAccountId,
          instagram_user_id: nextInstagramUserId(),
          full_name: 'Riya',
          tags,
          first_seen_at: new Date(Date.now() - 10 * 24 * HOUR),
        })),
      )
      .returning({ id: contacts.id });
    await database.insert(contact_activities).values(
      rows.map((row) => ({
        contact_id: row.id,
        organization_id: team.organization.id,
        channel_account_id: account.channelAccountId,
        last_message_received_at: new Date(Date.now() - 3 * 24 * HOUR),
        last_direct_message_received_at:
          openHoursAgo === null ? null : new Date(Date.now() - openHoursAgo * HOUR),
      })),
    );
    ids.push(...rows.map((row) => row.id));
  }
  return ids;
}

/** A POST of the team's member with a fresh idempotency key; answers the `data` of a 200. */
export async function postAsMember<T>({
  app,
  token,
  path,
  payload,
}: {
  app: FastifyInstance;
  token: string;
  path: string;
  payload: unknown;
}): Promise<T> {
  const response = await injectAuthenticated(app, {
    method: 'POST',
    url: testApiPath(path),
    token,
    payload,
    headers: { 'x-idempotency-key': randomUUID() },
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { data: T }).data;
}

/**
 * Makes a broadcast over routes 71 and 75 as `token`'s member: one text message to `audience` (a
 * segment's id, or one-off conditions), sent in `send`'s mode. Answers its `brc_…`.
 */
export async function sendBroadcastOverRoutes({
  app,
  token,
  account,
  name,
  audience,
  send,
}: {
  app: FastifyInstance;
  token: string;
  account: FlowAccount;
  name: string;
  audience: { segment_id: string } | { conditions: unknown };
  send: Record<string, unknown>;
}): Promise<string> {
  const draft = await postAsMember<{ id: string }>({
    app,
    token,
    path: '/app/broadcasts',
    payload: {
      channel_account_id: account.channelAccountPublicId,
      name,
      messages: [{ kind: 'text', wait_minutes: 0, text: `Hi {name}, ${name} is live.` }],
      ...audience,
    },
  });
  await postAsMember({ app, token, path: `/app/broadcasts/${draft.id}/send`, payload: send });
  return draft.id;
}

/**
 * Works the database-task queue as its worker would, job by job (chained pieces included), with
 * the app's own handlers; answers the names of the jobs it ran.
 */
export async function workDatabaseTasks({
  app,
  queue,
}: {
  app: FastifyInstance;
  queue: Queue;
}): Promise<string[]> {
  const ran: string[] = [];
  for (let round = 0; round < 20; round += 1) {
    const jobs = await queue.getJobs(['waiting', 'prioritized', 'delayed']);
    if (jobs.length === 0) return ran;
    for (const job of jobs) {
      const handler: InstagramTaskHandler | undefined =
        app.appDomain.instagramSendWork.taskHandlers[job.name];
      if (handler === undefined) throw new Error(`no task handler for ${job.name}`);
      await job.remove();
      await handler.run({
        organizationPublicId: job.data.organizationPublicId,
        taskInput: handler.inputSchema.parse(job.data.taskInput),
        context: { ...FLOW_TICKET_CONTEXT, jobId: String(job.id) },
      });
      ran.push(job.name);
    }
  }
  throw new Error('the database tasks never drained');
}

/** The account's lane row of `lane`. */
export async function readLane({
  account,
  lane,
}: {
  account: FlowAccount;
  lane: InstagramSendLane;
}): Promise<Record<string, unknown> & { turn_number: number; next_run_at: Date | null }> {
  const [row] = await operatorQuery<
    Array<Record<string, unknown> & { turn_number: number; next_run_at: Date | null }>
  >`
    SELECT * FROM app.instagram_send_lanes
    WHERE channel_account_id = ${account.channelAccountId} AND lane = ${lane}`;
  if (row === undefined) throw new Error(`no ${lane} lane`);
  return row;
}

/** Frees the lane's box (its next turn due now), as time passing would. */
export async function freeTheBox({
  account,
  lane,
}: {
  account: FlowAccount;
  lane: InstagramSendLane;
}): Promise<void> {
  await operatorQuery`
    UPDATE app.instagram_send_lanes SET next_run_at = NULL, last_sent_at = NULL
    WHERE channel_account_id = ${account.channelAccountId} AND lane = ${lane}`;
}

/** Works one turn of the account's lane with the app's real send core (its current turn number). */
export async function workLaneTurn({
  app,
  team,
  account,
  lane,
}: {
  app: FastifyInstance;
  team: ConnectedInstagramTeam;
  account: FlowAccount;
  lane: 'slow' | 'reply' | 'broadcast';
}): Promise<void> {
  const row = await readLane({ account, lane });
  const work = app.appDomain.instagramSendWork.laneTurn;
  if (work === null) throw new Error('the app has no lane-turn work');
  await work.workLaneTurn({
    ticket: {
      organizationPublicId: team.organization.public_id,
      channelAccountPublicId: account.channelAccountPublicId,
      lane,
      turnNumber: Number(row.turn_number),
    },
    scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId: team.organization.public_id }),
    context: FLOW_TICKET_CONTEXT,
  });
}

/** Sends every waiting fast message of the organization now (their wait over), as their tickets would. */
export async function sendWaitingFastMessages({
  app,
  team,
  account,
}: {
  app: FastifyInstance;
  team: ConnectedInstagramTeam;
  account: FlowAccount;
}): Promise<number> {
  await operatorQuery`
    UPDATE app.instagram_outgoing_messages SET not_before = now() - interval '1 second'
    WHERE organization_id = ${team.organization.id} AND lane = 'fast' AND status = 'waiting'`;
  const waiting = (await readInstagramOutgoingMessages(team.organization.id)).filter(
    (row) => row.lane === 'fast' && row.status === 'waiting',
  );
  const work = app.appDomain.instagramSendWork.fastMessage;
  if (work === null) throw new Error('the app has no fast-message work');
  for (const message of waiting) {
    await work.sendFastMessage({
      ticket: {
        organizationPublicId: team.organization.public_id,
        channelAccountPublicId: account.channelAccountPublicId,
        instagramMessagePublicId: message.public_id,
        automationRunStartedAt: message.automation_run_started_at.toISOString(),
        tries: message.tries,
      },
      scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId: team.organization.public_id }),
      context: FLOW_TICKET_CONTEXT,
    });
  }
  return waiting.length;
}

/** The broadcast row by `brc_…`. */
export async function readBroadcast(publicId: string) {
  const [row] = await getOperatorDatabase()
    .select()
    .from(broadcasts)
    .where(eq(broadcasts.public_id, publicId));
  if (row === undefined) throw new Error(`no broadcast ${publicId}`);
  return row;
}

/** The broadcast's recipient rows, by contact id. */
export async function readRecipients(broadcastId: number) {
  return getOperatorDatabase()
    .select()
    .from(broadcast_recipients)
    .where(and(eq(broadcast_recipients.broadcast_id, broadcastId)))
    .orderBy(asc(broadcast_recipients.contact_id));
}

/** The organization's DMs counted this month. */
export async function monthUsed(organizationId: number): Promise<number> {
  const [row] = await operatorQuery<Array<{ used: number }>>`
    SELECT COALESCE(sum(count), 0)::int AS used FROM app.message_month_counts
    WHERE organization_id = ${organizationId}`;
  return row?.used ?? 0;
}

/**
 * Answers every Instagram send of the account until `nock.cleanAll()` with Meta's success —
 * unless `refuse` answers a refusal for that send — and records each send's body.
 */
export function mockInstagramSends({
  refuse,
}: {
  refuse?: (sendNumber: number) => [number, Record<string, unknown>] | undefined;
} = {}): { bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  // nock hands a `fetch` call over as its `Request` (the retention suite's mock does the same).
  nock(META_GRAPH_BASE_URL)
    .persist()
    .post(/\/messages$/)
    .query(true)
    .reply(async (request: unknown) => {
      bodies.push((await (request as Request).json()) as Record<string, unknown>);
      return (
        refuse?.(bodies.length) ?? [200, { recipient_id: '1', message_id: `mid.${bodies.length}` }]
      );
    });
  return { bodies };
}
