import type { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { broadcastSendQueue } from '@/domains/app/app.tasks.js';
import { runBroadcastEndDuty } from '@/domains/app/sub-domains/broadcast/workers/broadcast-end.processor.js';
import { runBroadcastStartDuty } from '@/domains/app/sub-domains/broadcast/workers/broadcast-start.processor.js';
import { insertContact } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { readInstagramMessages } from '@/domains/app/sub-domains/instagram-sending/instagram-message/__tests__/factories/instagram-message.factory.js';
import { setMonthCount } from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import {
  type FlowAccount,
  emptyFlowQueues,
  freeTheBox,
  insertAudience,
  mockInstagramSends,
  monthUsed,
  openFlowQueues,
  postAsMember,
  readBroadcast,
  readFlowAccount,
  readLane,
  readRecipients,
  sendBroadcastOverRoutes,
  sendWaitingFastMessages,
  workDatabaseTasks,
  workLaneTurn,
} from './instagram-broadcast-flow.helper.js';
import {
  type ConnectedInstagramTeam,
  JORDAN,
  MORGAN,
  connectInstagramTeam,
  contactOf,
  directMessageItem,
  liveAutomation,
  mockInstagramConversation,
  say,
} from './instagram-retention-erasure.helper.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

const HOUR = 3_600_000;
const VIP = { op: 'and', items: [{ field: 'tags', match: 'any', values: ['vip'] }] };

/**
 * Flow — a broadcast from draft to done (feat-instagram-dm-sending ROUTE row R56; AC-21.1–AC-21.9;
 * routes-final § 7.A–7.C, § 6.10 WC-8, WC-28, WC-29, WC-40; plan §27.15, §30.14): the broadcast made
 * and sent over routes 71 and 75 by the team's member, its audience built by the app's own
 * `broadcast-audience` task (500 a piece, chained), each message sent by the app's real send core
 * in the broadcast lane (Meta via nock), the checks again just before each send, the scheduled
 * start and the end duties, "when her chat opens" through the real webhook intake and the run
 * engine, the month limit and "too fast" — and the in-app "Broadcast done" note.
 */
describe('Flow — a broadcast from draft to done (R56)', () => {
  let app: FastifyInstance;
  let queues: Queue[];
  let team: ConnectedInstagramTeam;
  let account: FlowAccount;

  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: team.organization.public_id });
  const repairContext = (now = new Date()) => ({ now, isBudgetSpent: () => false });
  const endServices = () => ({
    recipientService: app.appDomain.broadcastRecipientService,
    sendingPorts: app.appDomain.channelSendingPorts,
    runInDatabaseSlot: <T>(callback: () => Promise<T>) => callback(),
  });

  /** Sends broadcast-lane turns, the box freed before each, until nothing of it waits. */
  async function sendTheBroadcastLane(maxTurns: number): Promise<number> {
    let turns = 0;
    for (; turns < maxTurns; turns += 1) {
      const waiting = (await readInstagramMessages(team.organization.id)).filter(
        (row) => row.lane === 'broadcast' && row.status === 'waiting',
      );
      if (waiting.length === 0) break;
      await freeTheBox({ account, lane: 'broadcast' });
      await workLaneTurn({ app, team, account, lane: 'broadcast' });
    }
    return turns;
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    queues = openFlowQueues();
  });

  afterAll(async () => {
    await emptyFlowQueues(queues);
    await Promise.all(queues.map((queue) => queue.close()));
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    nock.cleanAll();
    await emptyFlowQueues(queues);
    team = await connectInstagramTeam(app);
    account = await readFlowAccount(team);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('"Send now" to a segment of 1,240 with 310 open chats: 310 waiting recipients, one per box, the checks again, done with the note (AC-21.1, AC-21.2, AC-21.8)', async () => {
    const open = await insertAudience({
      team,
      account,
      count: 310,
      tags: ['vip'],
      openHoursAgo: 2,
    });
    await insertAudience({ team, account, count: 930, tags: ['vip'], openHoursAgo: 72 });
    const segment = await postAsMember<{ id: string }>({
      app,
      token: team.editorToken,
      path: '/app/segments',
      payload: { channel_account_id: account.channelAccountPublicId, name: 'vip', conditions: VIP },
    });
    const publicId = await sendBroadcastOverRoutes({
      app,
      token: team.editorToken,
      account,
      name: 'Diwali sale',
      audience: { segment_id: segment.id },
      send: { mode: 'now' },
    });
    expect((await readBroadcast(publicId)).status).toBe('sending');

    // The audience task: only the 310 open chats, one waiting recipient and message 1 each.
    expect(await workDatabaseTasks({ app, queue: queues[0]! })).toContain('broadcast-audience');
    const broadcast = await readBroadcast(publicId);
    expect(broadcast.audience_built_at).toBeInstanceOf(Date);
    const recipients = await readRecipients(broadcast.id);
    expect(recipients).toHaveLength(310);
    expect(new Set(recipients.map((row) => row.status))).toEqual(new Set(['waiting']));
    expect(recipients.map((row) => row.contact_id)).toEqual(open);

    // Since the build: one chat closed, one opted out, one got another broadcast (AC-21.2).
    const [closed, optedOut, recent] = [open[10]!, open[20]!, open[30]!];
    await operatorQuery`
      UPDATE app.contact_activities SET last_direct_message_received_at = now() - interval '25 hours'
      WHERE contact_id = ${closed}`;
    await operatorQuery`UPDATE app.contacts SET opted_out_at = now() WHERE id = ${optedOut}`;
    await operatorQuery`
      UPDATE app.contact_activities SET last_broadcast_at = now() - interval '1 hour'
      WHERE contact_id = ${recent}`;

    const { bodies } = mockInstagramSends();
    const before = await monthUsed(team.organization.id);
    // One broadcast turn: one message, and the next turn at a second of the next 6-second box.
    await workLaneTurn({ app, team, account, lane: 'broadcast' });
    expect(bodies).toHaveLength(1);
    const lane = await readLane({ account, lane: 'broadcast' });
    const untilNext = lane.next_run_at!.getTime() - Date.now();
    expect(untilNext).toBeGreaterThan(0);
    expect(untilNext).toBeLessThanOrEqual(12_500);
    // A turn before its box second sends nothing.
    await workLaneTurn({ app, team, account, lane: 'broadcast' });
    expect(bodies).toHaveLength(1);

    await sendTheBroadcastLane(400);
    expect(bodies).toHaveLength(307);
    expect(await monthUsed(team.organization.id)).toBe(before + 307);
    const settled = new Map(
      (await readRecipients(broadcast.id)).map((row) => [row.contact_id, row]),
    );
    expect(settled.get(closed)).toMatchObject({ status: 'skipped', reason: 'window_closed' });
    expect(settled.get(optedOut)).toMatchObject({ status: 'skipped', reason: 'opted_out' });
    expect(settled.get(recent)).toMatchObject({ status: 'skipped', reason: 'recent_broadcast' });
    expect([...settled.values()].filter((row) => row.status === 'sent')).toHaveLength(307);

    // The end duty: `done`, and one in-app "Broadcast done" note each to the member who sent it,
    // the Owner and the Admin with sent, skipped and replies — no email (AC-21.8).
    expect(
      (await runBroadcastEndDuty({ context: repairContext(), services: endServices() })).done,
    ).toBe(1);
    const done = await readBroadcast(publicId);
    expect(done).toMatchObject({ status: 'done', sent: 307, skipped: 3 });
    const notes = await operatorQuery<Array<{ user_id: string; data: Record<string, unknown> }>>`
      SELECT user_id, data FROM notify.notifications
      WHERE organization_id = ${team.organization.id} AND type = 'broadcast.done'`;
    expect(notes.map((row) => Number(row.user_id)).sort()).toEqual(
      [team.owner.id, team.editor.id, await adminUserId()].sort(),
    );
    expect(notes[0]?.data).toMatchObject({ sent: 307, skipped: 3, replies: 0 });
    const [mail] = await operatorQuery<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM auth.mail_outbox`;
    expect(mail?.count).toBe(0);
    // Twice changes nothing.
    expect(
      (await runBroadcastEndDuty({ context: repairContext(), services: endServices() })).done,
    ).toBe(0);
  });

  it('builds the audience 500 at a time, chained, each person once, the mark on the last piece', async () => {
    await insertAudience({ team, account, count: 620, tags: ['vip'], openHoursAgo: 1 });
    const publicId = await sendBroadcastOverRoutes({
      app,
      token: team.ownerToken,
      account,
      name: 'Pieces',
      audience: { conditions: VIP },
      send: { mode: 'now' },
    });
    const ran = await workDatabaseTasks({ app, queue: queues[0]! });
    expect(ran.filter((name) => name === 'broadcast-audience')).toHaveLength(2);
    const broadcast = await readBroadcast(publicId);
    const recipients = await readRecipients(broadcast.id);
    expect(recipients).toHaveLength(620);
    expect(new Set(recipients.map((row) => row.contact_id)).size).toBe(620);
    expect(broadcast.audience_built_at).toBeInstanceOf(Date);
    // Nobody is sent before the build ends: the end duty leaves it `sending` while 620 wait.
    expect(
      (await runBroadcastEndDuty({ context: repairContext(), services: endServices() })).done,
    ).toBe(0);
    expect((await readBroadcast(publicId)).status).toBe('sending');
  });

  it('starts a broadcast scheduled for Friday 18:00 at that time (AC-21.3)', async () => {
    await insertAudience({ team, account, count: 2, tags: ['vip'], openHoursAgo: 1 });
    const friday = nextFridayAtSix();
    const publicId = await sendBroadcastOverRoutes({
      app,
      token: team.ownerToken,
      account,
      name: 'Friday drop',
      audience: { conditions: VIP },
      send: { mode: 'scheduled', scheduled_at: friday.toISOString() },
    });
    expect(await readBroadcast(publicId)).toMatchObject({ status: 'scheduled', matched: 0 });
    // Nothing is built or sent before its time.
    expect(await workDatabaseTasks({ app, queue: queues[0]! })).not.toContain('broadcast-audience');
    const startAt = (now: Date) =>
      runBroadcastStartDuty({
        context: repairContext(now),
        sendQueue: broadcastSendQueue,
        runInDatabaseSlot: (callback) => callback(),
      });
    expect((await startAt(new Date(friday.getTime() - 60_000))).done).toBe(0);
    expect((await readBroadcast(publicId)).status).toBe('scheduled');
    expect((await startAt(friday)).done).toBe(1);
    expect((await readBroadcast(publicId)).status).toBe('sending');
    expect(await workDatabaseTasks({ app, queue: queues[0]! })).toContain('broadcast-audience');
    expect(await readRecipients((await readBroadcast(publicId)).id)).toHaveLength(2);
  });

  it('"when her chat opens": her story reply runs her automation first; when her run is completed she gets the broadcast in the next box, 1 DM; once per person; done at the end time, made rows still going (AC-21.4, AC-21.6)', async () => {
    const { sends } = mockInstagramConversation({
      instagramAppUserId: team.profile.id,
      people: [JORDAN, MORGAN],
    });
    const riya = await insertContact({
      organizationId: team.organization.id,
      instagramAccountId: account.instagramAccountId,
      instagram_user_id: JORDAN.instagramUserId,
      tags: ['vip'],
      last_direct_message_received_at: null,
    });
    const story = await liveAutomation({ team, name: 'Story', trigger_type: 'story_reply' });
    const publicId = await sendBroadcastOverRoutes({
      app,
      token: team.ownerToken,
      account,
      name: 'New guide',
      audience: { conditions: VIP },
      send: { mode: 'when_chat_opens', open_wait_days: 3 },
    });
    const broadcast = await readBroadcast(publicId);
    expect(broadcast.status).toBe('waiting_for_chats');

    // Day 2: Riya replies to a story. Her automation runs first: no recipient row while it is open.
    await say({
      app,
      team,
      messaging: [directMessageItem({ person: JORDAN, text: 'love it', storyId: '1799' })],
    });
    const runs = await operatorQuery<Array<{ status: string }>>`
      SELECT status FROM app.automation_runs WHERE automation_id = ${story.id} AND contact_id = ${riya.id}`;
    expect(runs.map((row) => row.status)).toEqual(['running']);
    expect(await readRecipients(broadcast.id)).toHaveLength(0);

    // Her story answer goes; her run is `completed` — in that commit her recipient row is made.
    expect(await sendWaitingFastMessages({ app, team, account })).toBeGreaterThan(0);
    const [ended] = await operatorQuery<Array<{ status: string }>>`
      SELECT status FROM app.automation_runs WHERE automation_id = ${story.id} AND contact_id = ${riya.id}`;
    expect(ended?.status).toBe('completed');
    expect((await readRecipients(broadcast.id)).map((row) => [row.contact_id, row.status])).toEqual(
      [[riya.id, 'waiting']],
    );

    // The broadcast lane's next box: "New guide" goes to her, 1 DM in the month.
    const before = await monthUsed(team.organization.id);
    const sendsBefore = sends.length;
    await sendTheBroadcastLane(3);
    expect(sends.length).toBe(sendsBefore + 1);
    expect(JSON.stringify(sends.at(-1)?.body)).toContain('New guide is live');
    expect(await monthUsed(team.organization.id)).toBe(before + 1);
    expect((await readRecipients(broadcast.id))[0]).toMatchObject({ status: 'sent' });

    // Wednesday she writes again: nothing (once per person per broadcast).
    await say({ app, team, messaging: [directMessageItem({ person: JORDAN, text: 'hi again' })] });
    expect(await readRecipients(broadcast.id)).toHaveLength(1);

    // Morgan writes before the end: her row is made; then the end time passes.
    await insertContact({
      organizationId: team.organization.id,
      instagramAccountId: account.instagramAccountId,
      instagram_user_id: MORGAN.instagramUserId,
      tags: ['vip'],
    });
    await say({ app, team, messaging: [directMessageItem({ person: MORGAN, text: 'hello' })] });
    expect(await readRecipients(broadcast.id)).toHaveLength(2);
    await operatorQuery`
      UPDATE app.broadcasts SET ends_at = now() - interval '1 minute' WHERE id = ${broadcast.id}`;
    // Past its end nobody new is added; Morgan's row made before then still goes, then `done`.
    expect(
      (await runBroadcastEndDuty({ context: repairContext(), services: endServices() })).done,
    ).toBe(0);
    await sendTheBroadcastLane(3);
    const morgan = await contactOf({ team, person: MORGAN });
    expect(
      (await readRecipients(broadcast.id)).find((row) => row.contact_id === morgan.id)?.status,
    ).toBe('sent');
    expect(
      (await runBroadcastEndDuty({ context: repairContext(), services: endServices() })).done,
    ).toBe(1);
    expect((await readBroadcast(publicId)).status).toBe('done');
  });

  it('several waiting broadcasts send her only the oldest that day; a row she holds is never made twice (AC-21.5)', async () => {
    mockInstagramConversation({ instagramAppUserId: team.profile.id, people: [JORDAN] });
    const riya = await insertContact({
      organizationId: team.organization.id,
      instagramAccountId: account.instagramAccountId,
      instagram_user_id: JORDAN.instagramUserId,
      tags: ['vip'],
    });
    const older = await readBroadcast(
      await sendBroadcastOverRoutes({
        app,
        token: team.ownerToken,
        account,
        name: 'Older',
        audience: { conditions: VIP },
        send: { mode: 'when_chat_opens', open_wait_days: 3 },
      }),
    );
    const newer = await readBroadcast(
      await sendBroadcastOverRoutes({
        app,
        token: team.ownerToken,
        account,
        name: 'Newer',
        audience: { conditions: VIP },
        send: { mode: 'when_chat_opens', open_wait_days: 3 },
      }),
    );
    await say({ app, team, messaging: [directMessageItem({ person: JORDAN, text: 'hi' })] });
    expect((await readRecipients(older.id)).map((row) => row.contact_id)).toEqual([riya.id]);
    expect(await readRecipients(newer.id)).toHaveLength(0);
    // She writes again before it went: still only the oldest.
    await say({ app, team, messaging: [directMessageItem({ person: JORDAN, text: 'hi again' })] });
    expect(await readRecipients(newer.id)).toHaveLength(0);
    await sendTheBroadcastLane(3);
    expect((await readRecipients(older.id))[0]?.status).toBe('sent');
    // The same day, after it went: the 24-hour gap holds the newer one.
    await say({ app, team, messaging: [directMessageItem({ person: JORDAN, text: 'thanks' })] });
    expect(await readRecipients(newer.id)).toHaveLength(0);
    expect(await readRecipients(older.id)).toHaveLength(1);
  });

  it('"too fast" on the broadcast lane stops only that lane for double the time; her DM answers still go (AC-21.7)', async () => {
    const { sends } = mockInstagramConversation({
      instagramAppUserId: team.profile.id,
      people: [JORDAN],
      onSend: async (send) =>
        JSON.stringify(send.body).includes('Drop is live')
          ? [400, { error: { code: 613 } }]
          : undefined,
    });
    await insertAudience({ team, account, count: 2, tags: ['vip'], openHoursAgo: 1 });
    await sendBroadcastOverRoutes({
      app,
      token: team.ownerToken,
      account,
      name: 'Drop',
      audience: { conditions: VIP },
      send: { mode: 'now' },
    });
    await workDatabaseTasks({ app, queue: queues[0]! });
    await workLaneTurn({ app, team, account, lane: 'broadcast' });
    const stopped = await readLane({ account, lane: 'broadcast' });
    expect(stopped.stop_reason).toBe('too_fast');
    const stopFor = (stopped.stop_until as Date).getTime() - Date.now();
    expect(stopFor).toBeGreaterThan(29 * 60_000);
    expect(stopFor).toBeLessThanOrEqual(30 * 60_000);
    for (const lane of ['slow', 'reply', 'fast'] as const) {
      expect((await readLane({ account, lane })).stop_reason).toBeNull();
    }
    // An answer to her DM still goes in the fast lane.
    await liveAutomation({ team, name: 'Catalog', trigger_type: 'dm', keywords: ['catalog'] });
    await say({ app, team, messaging: [directMessageItem({ person: JORDAN, text: 'catalog' })] });
    const sentBefore = sends.length;
    expect(await sendWaitingFastMessages({ app, team, account })).toBeGreaterThan(0);
    expect(sends.length).toBeGreaterThan(sentBefore);
    expect(
      (await readInstagramMessages(team.organization.id)).some(
        (row) => row.lane === 'fast' && row.status === 'sent',
      ),
    ).toBe(true);
  });

  it('the month limit reached mid-broadcast stops the broadcast lane with the others; its waiting recipients wait (AC-21.9)', async () => {
    const { bodies } = mockInstagramSends();
    await insertAudience({ team, account, count: 3, tags: ['vip'], openHoursAgo: 1 });
    const publicId = await sendBroadcastOverRoutes({
      app,
      token: team.ownerToken,
      account,
      name: 'Limit',
      audience: { conditions: VIP },
      send: { mode: 'now' },
    });
    await workDatabaseTasks({ app, queue: queues[0]! });
    const limit = await app.appDomain.messageMonthCountService.readMonthLimit(scope());
    await setMonthCount({ organizationId: team.organization.id, count: limit! - 1 });

    await sendTheBroadcastLane(5);

    expect(bodies).toHaveLength(1);
    expect(await monthUsed(team.organization.id)).toBe(limit!);
    const broadcast = await readBroadcast(publicId);
    const statuses = (await readRecipients(broadcast.id)).map((row) => row.status).sort();
    expect(statuses).toEqual(['sent', 'waiting', 'waiting']);
    const [planStop] = await operatorQuery<Array<{ plan_stop_reason: string | null }>>`
      SELECT plan_stop_reason FROM app.channel_accounts WHERE id = ${account.channelAccountId}`;
    expect(planStop?.plan_stop_reason).toBe('plan_limit');
    expect((await readLane({ account, lane: 'broadcast' })).state).toBe('stopped');
    expect(broadcast.status).toBe('sending');
  });

  /** The team's Admin's user id (the fixture names its token only). */
  async function adminUserId(): Promise<number> {
    const [row] = await operatorQuery<Array<{ user_id: string }>>`
      SELECT m.user_id FROM tenancy.memberships m
      JOIN tenancy.roles r ON r.id = m.role_id
      WHERE m.organization_id = ${team.organization.id} AND r.name = 'Admin'`;
    return Number(row?.user_id);
  }
});

/** The next Friday 18:00 UTC at least a day ahead (inside route 75's 30 days). */
function nextFridayAtSix(): Date {
  const date = new Date(Date.now() + 24 * HOUR);
  date.setUTCHours(18, 0, 0, 0);
  while (date.getUTCDay() !== 5) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}
