import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '@/shared/config/env.config.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import {
  injectAuthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  createInstagramTeam,
  createPersonalOrganizationWithInstagramCodes,
  endPaidPlanWithoutPaying,
  readStagedAuditRows,
  type InstagramTeamFixture,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  completeAutomationSteps,
  insertAutomation,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';

const BROADCASTS_PATH = testApiPath('/app/broadcasts');
const SEGMENTS_PATH = testApiPath('/app/segments');

/** The path of one broadcast, or one of its actions. */
function broadcastPath(broadcastPublicId: string, action?: 'send' | 'cancel'): string {
  return `${BROADCASTS_PATH}/${broadcastPublicId}${action === undefined ? '' : `/${action}`}`;
}

/** A one-condition tree: she shared her email. */
const EMAIL_CONDITIONS = { op: 'and', items: [{ field: 'details', has: 'email' }] };

/** One plain text message. */
const TEXT_MESSAGE = { kind: 'text', wait_minutes: 0, text: 'The drop is live.' };

/** The Broadcast object as the routes answer it (7.A.6). */
interface BroadcastAnswer {
  id: string;
  channel_account_id: string;
  name: string;
  status: string;
  mode: string;
  segment_id: string | null;
  conditions: unknown;
  messages: unknown[];
  start_automation_id: string | null;
  scheduled_at: string | null;
  ends_at: string | null;
  started_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  numbers: Record<string, number>;
  created_by_user_id: string | null;
  updated_at: string;
}

/**
 * Routes 70–76 of the broadcasts (routes-final § 7.A, ROUTE R22) over HTTP: the draft and its
 * audience (a segment or one-off conditions, never both), 0–3 messages checked as automation
 * messages (AC-9.4), the button's live automation, the edit only in draft, the send in its three
 * modes with the copy of the conditions (AC-9.8), every row of 7.A.9, cancel and delete by status
 * (AC-9.7, AC-9.8), the list with its numbers and a cursor (AC-9.9), PRO through the `broadcasts`
 * switch, the read-only plan on send, the Viewer, idempotency, team-only, the audit entries, another
 * organization's broadcast (K1) and the segment delete's draft step (BC17).
 */
describe('Broadcast routes (list, draft, open, edit, delete, send, cancel)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  let account: { id: number; public_id: string; channel_account_id: number };

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    team = await createInstagramTeam();
    account = await insertInstagramAccount({ organizationId: team.organization.id });
  });

  /** Gives `organizationId` a plan with these features (P83). */
  async function usePlan({
    features,
    organizationId = team.organization.id,
  }: {
    features: typeof FREE_PLAN_FEATURES;
    organizationId?: number;
  }): Promise<number> {
    const plan = await createTestPlan({ features, priceMonthly: '29.00', priceYearly: '276.00' });
    await createTestSubscription({ organizationId, planId: plan.id, status: 'ACTIVE' });
    return plan.id;
  }

  /** A POST with an idempotency key (71, 75, 76). */
  function post({
    url,
    payload,
    token = team.ownerToken,
    idempotencyKey = randomUUID(),
  }: {
    url: string;
    payload: unknown;
    token?: string;
    idempotencyKey?: string | null;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'POST',
      url,
      token,
      payload,
      headers: idempotencyKey === null ? {} : { 'x-idempotency-key': idempotencyKey },
    });
  }

  /** Route 71 on the team's account. */
  function create({
    body = {},
    token = team.ownerToken,
    accountPublicId = account.public_id,
  }: {
    body?: Record<string, unknown>;
    token?: string;
    accountPublicId?: string;
  } = {}): Promise<InjectHttpResult> {
    return post({
      url: BROADCASTS_PATH,
      token,
      payload: { channel_account_id: accountPublicId, name: 'Drop', ...body },
    });
  }

  /** Route 71, expecting `200`. */
  async function createBroadcast(body: Record<string, unknown> = {}): Promise<BroadcastAnswer> {
    const response = await create({ body });
    expect(response.statusCode, response.body).toBe(200);
    return dataOf<BroadcastAnswer>(response);
  }

  /** A complete draft: one message and one-off conditions. */
  function createCompleteDraft(): Promise<BroadcastAnswer> {
    return createBroadcast({ messages: [TEXT_MESSAGE], conditions: EMAIL_CONDITIONS });
  }

  /** Route 75. */
  function send(
    broadcastPublicId: string,
    payload: Record<string, unknown> = { mode: 'now' },
  ): Promise<InjectHttpResult> {
    return post({ url: broadcastPath(broadcastPublicId, 'send'), payload });
  }

  /** Route 76. */
  function cancel(broadcastPublicId: string): Promise<InjectHttpResult> {
    return post({ url: broadcastPath(broadcastPublicId, 'cancel'), payload: {} });
  }

  /** Route 73. */
  function patch(
    broadcastPublicId: string,
    payload: Record<string, unknown>,
    token = team.ownerToken,
  ): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'PATCH',
      url: broadcastPath(broadcastPublicId),
      token,
      payload,
    });
  }

  /** Route 74. */
  function remove(broadcastPublicId: string, token = team.ownerToken): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'DELETE',
      url: broadcastPath(broadcastPublicId),
      token,
    });
  }

  function dataOf<T>(response: InjectHttpResult): T {
    return (response.json() as { data: T }).data;
  }

  function errorOf(response: InjectHttpResult): {
    reason?: string;
    errors?: { field: string; reason?: string }[];
  } {
    return (response.json() as { error: { reason?: string; errors?: { field: string }[] } }).error;
  }

  /** Saves a segment on the team's account (route 78). */
  async function createSegment(): Promise<{ id: string }> {
    const response = await post({
      url: SEGMENTS_PATH,
      payload: { channel_account_id: account.public_id, name: 'VIP', conditions: EMAIL_CONDITIONS },
    });
    expect(response.statusCode).toBe(200);
    return dataOf<{ id: string }>(response);
  }

  describe('on a plan with broadcasts (Creator)', () => {
    beforeEach(async () => {
      await usePlan({ features: CREATOR_PLAN_FEATURES });
    });

    it('makes a draft on its account and answers it with its numbers', async () => {
      const broadcast = await createBroadcast({ name: '  Winter drop  ' });
      expect(broadcast).toMatchObject({
        channel_account_id: account.public_id,
        name: 'Winter drop',
        status: 'draft',
        mode: 'now',
        segment_id: null,
        conditions: null,
        messages: [],
        start_automation_id: null,
        numbers: { matched: 0, sent: 0, skipped: 0, failed: 0, replies: 0, taps: 0 },
        created_by_user_id: team.owner.public_id,
      });
      expect(broadcast.id).toMatch(/^brc_[a-z0-9]{21}$/);
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.broadcast.create',
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.metadata).toMatchObject({ broadcast_public_id: broadcast.id });
    });

    it('refuses 4 messages, both audiences and a broken message with 400 (AC-9.4)', async () => {
      const four = await create({ body: { messages: Array(4).fill(TEXT_MESSAGE) } });
      expect(four.statusCode).toBe(400);
      expect(errorOf(four).errors?.[0]?.field).toMatch(/^body\.messages/);
      const segment = await createSegment();
      const both = await create({ body: { segment_id: segment.id, conditions: EMAIL_CONDITIONS } });
      expect(both.statusCode).toBe(400);
      const blank = await create({ body: { messages: [{ ...TEXT_MESSAGE, text: '  ' }] } });
      expect(blank.statusCode).toBe(400);
      expect(errorOf(blank).errors?.map((item) => item.field)).toEqual(['body.messages.0.text']);
    });

    it("refuses a segment, a button automation or a condition automation that is not the account's with 400", async () => {
      const other = await insertInstagramAccount({ organizationId: team.organization.id });
      const foreignAutomation = await insertAutomation({
        organizationId: team.organization.id,
        instagramAccountId: other.id,
        status: 'live',
        steps: completeAutomationSteps(),
      });
      const draftAutomation = await insertAutomation({
        organizationId: team.organization.id,
        instagramAccountId: account.id,
      });
      const otherSegment = await post({
        url: SEGMENTS_PATH,
        payload: { channel_account_id: other.public_id, name: 'X', conditions: EMAIL_CONDITIONS },
      });
      const cases: [Record<string, unknown>, string][] = [
        [{ segment_id: dataOf<{ id: string }>(otherSegment).id }, 'segment_id'],
        [{ start_automation_id: foreignAutomation.public_id }, 'start_automation_id'],
        [{ start_automation_id: draftAutomation.public_id }, 'start_automation_id'],
        [
          {
            conditions: {
              op: 'and',
              items: [
                {
                  field: 'automation',
                  automation_id: foreignAutomation.public_id,
                  state: 'started',
                },
              ],
            },
          },
          'conditions',
        ],
      ];
      for (const [body, field] of cases) {
        const refused = await create({ body });
        expect(refused.statusCode, field).toBe(400);
        expect(errorOf(refused).errors?.[0]?.field).toBe(field);
      }
      const live = await insertAutomation({
        organizationId: team.organization.id,
        instagramAccountId: account.id,
        status: 'live',
        steps: completeAutomationSteps(),
      });
      const withButton = await createBroadcast({ start_automation_id: live.public_id });
      expect(withButton.start_automation_id).toBe(live.public_id);
    });

    it("answers 404 instagram_not_connected on another organization's or a revoked account", async () => {
      const revoked = await insertInstagramAccount({
        organizationId: team.organization.id,
        connectionStatus: 'revoked',
      });
      const otherTeam = await createInstagramTeam();
      const foreign = await insertInstagramAccount({ organizationId: otherTeam.organization.id });
      for (const accountPublicId of [revoked.public_id, foreign.public_id]) {
        const refused = await create({ accountPublicId });
        expect(refused.statusCode).toBe(404);
        expect(errorOf(refused).reason).toBe('instagram_not_connected');
      }
      const malformed = await create({ accountPublicId: 'nope' });
      expect(malformed.statusCode).toBe(400);
    });

    it('edits a draft — one audience clears the other — and refuses a stale save and a sent one (AC-9.4)', async () => {
      const broadcast = await createBroadcast({ conditions: EMAIL_CONDITIONS });
      const segment = await createSegment();
      const edited = await patch(broadcast.id, {
        name: 'Renamed',
        segment_id: segment.id,
        messages: [TEXT_MESSAGE],
      });
      expect(edited.statusCode).toBe(200);
      expect(dataOf<BroadcastAnswer>(edited)).toMatchObject({
        name: 'Renamed',
        segment_id: segment.id,
        conditions: null,
        messages: [TEXT_MESSAGE],
      });
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.broadcast.update',
      });
      expect(audit[0]?.metadata).toMatchObject({
        changed_fields: expect.arrayContaining(['name', 'segment_id', 'conditions', 'messages']),
      });
      const stale = await patch(broadcast.id, {
        name: 'Again',
        expected_updated_at: broadcast.updated_at,
      });
      expect(stale.statusCode).toBe(409);
      expect(errorOf(stale).reason).toBe('record_changed');
      const sent = await send(broadcast.id);
      expect(sent.statusCode).toBe(200);
      const late = await patch(broadcast.id, { name: 'Too late' });
      expect(late.statusCode).toBe(409);
      expect(errorOf(late).reason).toBe('broadcast_not_draft');
    });

    it('sends now with a copy of its segment that a later segment edit never changes (AC-9.8)', async () => {
      const segment = await createSegment();
      const broadcast = await createBroadcast({ segment_id: segment.id, messages: [TEXT_MESSAGE] });
      const response = await send(broadcast.id);
      expect(response.statusCode).toBe(200);
      const sent = dataOf<BroadcastAnswer>(response);
      expect(sent).toMatchObject({
        status: 'sending',
        mode: 'now',
        segment_id: segment.id,
        conditions: EMAIL_CONDITIONS,
        scheduled_at: null,
        ends_at: null,
      });
      expect(sent.started_at).not.toBeNull();
      const changed = await injectAuthenticated(app, {
        method: 'PATCH',
        url: `${SEGMENTS_PATH}/${segment.id}`,
        token: team.ownerToken,
        payload: { conditions: { op: 'and', items: [{ field: 'details', has: 'phone' }] } },
      });
      expect(changed.statusCode).toBe(200);
      const read = await injectAuthenticated(app, {
        url: broadcastPath(broadcast.id),
        token: team.ownerToken,
      });
      expect(dataOf<BroadcastAnswer>(read).conditions).toEqual(EMAIL_CONDITIONS);
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.broadcast.send',
      });
      expect(audit[0]?.metadata).toMatchObject({ broadcast_public_id: broadcast.id, mode: 'now' });
      const again = await send(broadcast.id);
      expect(again.statusCode).toBe(409);
      expect(errorOf(again).reason).toBe('transition_not_allowed');
    });

    it('schedules at a time and waits for chats for N days, and refuses a field of another mode', async () => {
      const scheduledAt = new Date(Date.now() + 2 * 24 * 3_600_000).toISOString();
      const first = await createCompleteDraft();
      const scheduled = await send(first.id, { mode: 'scheduled', scheduled_at: scheduledAt });
      expect(scheduled.statusCode).toBe(200);
      expect(dataOf<BroadcastAnswer>(scheduled)).toMatchObject({
        status: 'scheduled',
        mode: 'scheduled',
        scheduled_at: scheduledAt,
        started_at: null,
      });
      const second = await createCompleteDraft();
      const waiting = await send(second.id, { mode: 'when_chat_opens', open_wait_days: 3 });
      expect(waiting.statusCode).toBe(200);
      const waitingBroadcast = dataOf<BroadcastAnswer>(waiting);
      expect(waitingBroadcast).toMatchObject({
        status: 'waiting_for_chats',
        mode: 'when_chat_opens',
      });
      const endsIn = new Date(waitingBroadcast.ends_at as string).getTime() - Date.now();
      expect(endsIn).toBeGreaterThan(2.9 * 24 * 3_600_000);
      expect(endsIn).toBeLessThanOrEqual(3 * 24 * 3_600_000);
      const third = await createCompleteDraft();
      const refusals: [Record<string, unknown>, string][] = [
        [{ mode: 'soon' }, 'body.mode'],
        [{ mode: 'scheduled' }, 'body.scheduled_at'],
        [{ mode: 'now', open_wait_days: 2 }, 'body.open_wait_days'],
        [
          { mode: 'scheduled', scheduled_at: new Date(Date.now() - 60_000).toISOString() },
          'body.scheduled_at',
        ],
        [
          {
            mode: 'scheduled',
            scheduled_at: new Date(Date.now() + 31 * 24 * 3_600_000).toISOString(),
          },
          'body.scheduled_at',
        ],
        [{ mode: 'when_chat_opens', open_wait_days: 8 }, 'body.open_wait_days'],
      ];
      for (const [payload, field] of refusals) {
        const refused = await send(third.id, payload);
        expect(refused.statusCode, JSON.stringify(payload)).toBe(400);
        expect(errorOf(refused).errors?.[0]?.field).toBe(field);
      }
    });

    it('refuses an incomplete draft with 422 broadcast_incomplete naming messages and audience', async () => {
      const empty = await createBroadcast();
      const refused = await send(empty.id);
      expect(refused.statusCode).toBe(422);
      expect(errorOf(refused).reason).toBe('broadcast_incomplete');
      expect(errorOf(refused).errors?.map((item) => item.field)).toEqual(['messages', 'audience']);
      // Its segment deleted: the delete's step emptied the draft's audience (BC17).
      const segment = await createSegment();
      const draft = await createBroadcast({ segment_id: segment.id, messages: [TEXT_MESSAGE] });
      const deleted = await injectAuthenticated(app, {
        method: 'DELETE',
        url: `${SEGMENTS_PATH}/${segment.id}`,
        token: team.ownerToken,
      });
      expect(deleted.statusCode).toBe(204);
      const read = await injectAuthenticated(app, {
        url: broadcastPath(draft.id),
        token: team.ownerToken,
      });
      expect(dataOf<BroadcastAnswer>(read).segment_id).toBeNull();
      const noAudience = await send(draft.id);
      expect(noAudience.statusCode).toBe(422);
      expect(errorOf(noAudience).errors?.map((item) => item.field)).toEqual(['audience']);
    });

    it('refuses the send on a broken account and at the month limit with 409', async () => {
      const broadcast = await createCompleteDraft();
      await operatorQuery`
        INSERT INTO app.message_month_counts (organization_id, month_start, slot, count)
        VALUES (${team.organization.id}, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 0, 100000),
               (${team.organization.id}, date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date, 1, 100000)
        ON CONFLICT DO NOTHING`;
      const limited = await send(broadcast.id);
      expect(limited.statusCode).toBe(409);
      expect(errorOf(limited).reason).toBe('message_month_limit_reached');
      await operatorQuery`
        UPDATE app.channel_accounts SET connection_status = 'error' WHERE id = ${account.channel_account_id}`;
      const broken = await send(broadcast.id);
      expect(broken.statusCode).toBe(409);
      expect(errorOf(broken).reason).toBe('instagram_not_connected');
      const [row] = await operatorQuery<{ status: string }[]>`
        SELECT status FROM app.broadcasts WHERE public_id = ${broadcast.id}`;
      expect(row?.status).toBe('draft');
    });

    it('cancels a draft, scheduled, sending or waiting broadcast and refuses a done or cancelled one (AC-9.7)', async () => {
      const drafts = await Promise.all([1, 2, 3, 4].map(() => createCompleteDraft()));
      const [draft, scheduled, sending, waiting] = drafts as [
        BroadcastAnswer,
        BroadcastAnswer,
        BroadcastAnswer,
        BroadcastAnswer,
      ];
      await send(scheduled.id, {
        mode: 'scheduled',
        scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await send(sending.id);
      await send(waiting.id, { mode: 'when_chat_opens', open_wait_days: 1 });
      for (const broadcast of [draft, scheduled, sending, waiting]) {
        const response = await cancel(broadcast.id);
        expect(response.statusCode).toBe(200);
        expect(dataOf<BroadcastAnswer>(response)).toMatchObject({
          status: 'cancelled',
          cancel_reason: 'owner',
        });
        expect(dataOf<BroadcastAnswer>(response).cancelled_at).not.toBeNull();
      }
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.broadcast.cancel',
      });
      expect(audit).toHaveLength(4);
      const again = await cancel(draft.id);
      expect(again.statusCode).toBe(409);
      expect(errorOf(again).reason).toBe('transition_not_allowed');
      await operatorQuery`
        UPDATE app.broadcasts SET status = 'done', cancelled_at = NULL, cancel_reason = NULL
        WHERE public_id = ${sending.id}`;
      const done = await cancel(sending.id);
      expect(done.statusCode).toBe(409);
      expect(errorOf(done).reason).toBe('transition_not_allowed');
      const notEmpty = await post({ url: broadcastPath(draft.id, 'cancel'), payload: { x: 1 } });
      expect(notEmpty.statusCode).toBe(400);
    });

    it('refuses deleting a scheduled, sending or waiting broadcast with broadcast_active and hides a draft, done or cancelled one (AC-9.8)', async () => {
      const [scheduled, sending, waiting] = (await Promise.all(
        [1, 2, 3].map(() => createCompleteDraft()),
      )) as [BroadcastAnswer, BroadcastAnswer, BroadcastAnswer];
      await send(scheduled.id, {
        mode: 'scheduled',
        scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await send(sending.id);
      await send(waiting.id, { mode: 'when_chat_opens', open_wait_days: 1 });
      for (const [broadcast, status] of [
        [scheduled, 'scheduled'],
        [sending, 'sending'],
        [waiting, 'waiting_for_chats'],
      ] as const) {
        const refused = await remove(broadcast.id);
        expect(refused.statusCode, status).toBe(409);
        expect(errorOf(refused).reason).toBe('broadcast_active');
        const read = await injectAuthenticated(app, {
          url: broadcastPath(broadcast.id),
          token: team.ownerToken,
        });
        expect(read.statusCode).toBe(200);
        expect(dataOf<BroadcastAnswer>(read).status).toBe(status);
      }
      const draft = await createBroadcast();
      const cancelled = await createBroadcast();
      await cancel(cancelled.id);
      const done = await createCompleteDraft();
      await send(done.id);
      await operatorQuery`
        UPDATE app.broadcasts SET status = 'done' WHERE public_id = ${done.id}`;
      for (const broadcast of [draft, done, cancelled]) {
        expect((await remove(broadcast.id)).statusCode).toBe(204);
        const read = await injectAuthenticated(app, {
          url: broadcastPath(broadcast.id),
          token: team.ownerToken,
        });
        expect(read.statusCode).toBe(404);
        expect(errorOf(read).reason).toBe('broadcast_not_found');
        expect((await remove(broadcast.id)).statusCode).toBe(404);
      }
      const hidden = await operatorQuery<Array<{ public_id: string; deleted_at: Date | null }>>`
        SELECT public_id, deleted_at FROM app.broadcasts
        WHERE public_id IN (${draft.id}, ${done.id}, ${cancelled.id})`;
      expect(hidden).toHaveLength(3);
      for (const row of hidden) expect(row.deleted_at).not.toBeNull();
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.broadcast.delete',
      });
      expect(audit).toHaveLength(3);
    });

    it('lists name, mode, status and the numbers, filters, sorts and pages with a cursor (AC-9.9)', async () => {
      const first = await createBroadcast({ name: 'Alpha' });
      const second = await createCompleteDraft();
      await send(second.id);
      const third = await createBroadcast({ name: 'Charlie' });
      await operatorQuery`
        UPDATE app.broadcasts SET sent = 12, skipped = 2, replies = 5, taps = 3
        WHERE public_id = ${second.id}`;
      const deleted = await createBroadcast({ name: 'Gone' });
      await remove(deleted.id);
      const page = await injectAuthenticated(app, {
        url: `${BROADCASTS_PATH}?channel_account_id=${account.public_id}&limit=2`,
        token: team.ownerToken,
      });
      expect(page.statusCode).toBe(200);
      const body = page.json() as {
        data: BroadcastAnswer[];
        meta: { pagination: { next: string | null; has_more: boolean; estimated_total?: number } };
      };
      expect(body.data.map((row) => row.id)).toEqual([third.id, second.id]);
      expect(body.meta.pagination).toMatchObject({ has_more: true, estimated_total: 3 });
      expect(body.data[1]).toMatchObject({
        name: 'Drop',
        mode: 'now',
        status: 'sending',
        numbers: { sent: 12, skipped: 2, replies: 5, taps: 3 },
      });
      const next = await injectAuthenticated(app, {
        url: `${BROADCASTS_PATH}?channel_account_id=${account.public_id}&limit=2&after=${body.meta.pagination.next}`,
        token: team.ownerToken,
      });
      expect(dataOf<BroadcastAnswer[]>(next).map((row) => row.id)).toEqual([first.id]);
      const byStatus = await injectAuthenticated(app, {
        url: `${BROADCASTS_PATH}?channel_account_id=${account.public_id}&status=draft&sort=name`,
        token: team.ownerToken,
      });
      expect(dataOf<BroadcastAnswer[]>(byStatus).map((row) => row.name)).toEqual([
        'Alpha',
        'Charlie',
      ]);
      const unknown = await injectAuthenticated(app, {
        url: `${BROADCASTS_PATH}?channel_account_id=${account.public_id.replace(/.$/, 'z')}`,
        token: team.ownerToken,
      });
      expect(unknown.statusCode).toBe(200);
      expect(dataOf<BroadcastAnswer[]>(unknown)).toEqual([]);
      const missing = await injectAuthenticated(app, {
        url: BROADCASTS_PATH,
        token: team.ownerToken,
      });
      expect(missing.statusCode).toBe(400);
    });

    it('needs X-Idempotency-Key on draft, send and cancel', async () => {
      const broadcast = await createCompleteDraft();
      for (const [url, payload] of [
        [BROADCASTS_PATH, { channel_account_id: account.public_id, name: 'x' }],
        [broadcastPath(broadcast.id, 'send'), { mode: 'now' }],
        [broadcastPath(broadcast.id, 'cancel'), {}],
      ] as const) {
        const refused = await post({ url, payload, idempotencyKey: null });
        expect(refused.statusCode).toBe(422);
      }
    });

    it('lets a Viewer list and read, and refuses every change with missing_permission', async () => {
      const broadcast = await createCompleteDraft();
      for (const url of [
        `${BROADCASTS_PATH}?channel_account_id=${account.public_id}`,
        broadcastPath(broadcast.id),
      ]) {
        const read = await injectAuthenticated(app, { url, token: team.viewerToken });
        expect(read.statusCode).toBe(200);
      }
      const refusals = [
        await create({ token: team.viewerToken }),
        await patch(broadcast.id, { name: 'No' }, team.viewerToken),
        await remove(broadcast.id, team.viewerToken),
        await post({
          url: broadcastPath(broadcast.id, 'send'),
          payload: { mode: 'now' },
          token: team.viewerToken,
        }),
        await post({
          url: broadcastPath(broadcast.id, 'cancel'),
          payload: {},
          token: team.viewerToken,
        }),
      ];
      for (const refused of refusals) {
        expect(refused.statusCode).toBe(403);
        expect(errorOf(refused).reason).toBe('missing_permission');
      }
    });

    it("answers 404 broadcast_not_found for another organization's broadcast and leaves it unchanged (K1)", async () => {
      const otherTeam = await createInstagramTeam();
      const otherAccount = await insertInstagramAccount({
        organizationId: otherTeam.organization.id,
      });
      await usePlan({ features: CREATOR_PLAN_FEATURES, organizationId: otherTeam.organization.id });
      const foreign = dataOf<BroadcastAnswer>(
        await create({
          token: otherTeam.ownerToken,
          accountPublicId: otherAccount.public_id,
          body: { messages: [TEXT_MESSAGE], conditions: EMAIL_CONDITIONS },
        }),
      );
      const attempts = [
        await injectAuthenticated(app, { url: broadcastPath(foreign.id), token: team.ownerToken }),
        await patch(foreign.id, { name: 'Taken' }),
        await remove(foreign.id),
        await send(foreign.id),
        await cancel(foreign.id),
      ];
      for (const attempt of attempts) {
        expect(attempt.statusCode).toBe(404);
        expect(errorOf(attempt).reason).toBe('broadcast_not_found');
      }
      const [row] = await operatorQuery<
        { name: string; status: string; deleted_at: Date | null }[]
      >`SELECT name, status, deleted_at FROM app.broadcasts WHERE public_id = ${foreign.id}`;
      expect(row).toEqual({ name: 'Drop', status: 'draft', deleted_at: null });
    });
  });

  describe('on Free (BC3, P76)', () => {
    it('refuses draft and send with 403 plan_lacks_feature and leaves list, read, edit, cancel and delete open (AC-9.1)', async () => {
      const creatorPlanId = await usePlan({ features: CREATOR_PLAN_FEATURES });
      const draft = await createCompleteDraft();
      const other = await createBroadcast();
      const freePlan = await createTestPlan({
        features: FREE_PLAN_FEATURES,
        priceMonthly: '0.00',
        priceYearly: '0.00',
      });
      await operatorQuery`
        UPDATE billing.subscriptions SET plan_id = ${freePlan.id}
        WHERE organization_id = ${team.organization.id} AND plan_id = ${creatorPlanId}`;
      for (const refused of [await create(), await send(draft.id)]) {
        expect(refused.statusCode).toBe(403);
        expect(errorOf(refused).reason).toBe('plan_lacks_feature');
      }
      const list = await injectAuthenticated(app, {
        url: `${BROADCASTS_PATH}?channel_account_id=${account.public_id}`,
        token: team.ownerToken,
      });
      expect(list.statusCode).toBe(200);
      const read = await injectAuthenticated(app, {
        url: broadcastPath(draft.id),
        token: team.ownerToken,
      });
      expect(read.statusCode).toBe(200);
      expect((await patch(draft.id, { name: 'Kept' })).statusCode).toBe(200);
      expect((await cancel(other.id)).statusCode).toBe(200);
      expect((await remove(draft.id)).statusCode).toBe(204);
    });
  });

  describe('a read-only plan', () => {
    const enforced = env.LAPSED_PLAN_READ_ONLY_ENABLED;

    afterEach(() => {
      env.LAPSED_PLAN_READ_ONLY_ENABLED = enforced;
    });

    it('refuses the send with 403 organization_read_only', async () => {
      await usePlan({ features: CREATOR_PLAN_FEATURES });
      const draft = await createCompleteDraft();
      // The Creator plan lapses: only the ended paid plan is left.
      await operatorQuery`DELETE FROM billing.subscriptions WHERE organization_id = ${team.organization.id}`;
      await endPaidPlanWithoutPaying(team.organization.id);
      env.LAPSED_PLAN_READ_ONLY_ENABLED = true;
      const refused = await send(draft.id);
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused).reason).toBe('organization_read_only');
    });
  });

  it('is team-only: a personal organization reads 404 team_organization_required and writes 422', async () => {
    const personal = await createPersonalOrganizationWithInstagramCodes({
      permissionCodes: [APP_PERMISSIONS.AUTOMATION_READ, APP_PERMISSIONS.AUTOMATION_CREATE],
    });
    const read = await injectAuthenticated(app, {
      url: `${BROADCASTS_PATH}?channel_account_id=${account.public_id}`,
      token: personal.token,
    });
    expect(read.statusCode).toBe(404);
    expect(errorOf(read).reason).toBe('team_organization_required');
    const write = await create({ token: personal.token });
    expect(write.statusCode).toBe(422);
  });
});
