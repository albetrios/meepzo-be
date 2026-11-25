import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import {
  injectAuthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  createInstagramTeam,
  createPersonalOrganizationWithInstagramCodes,
  readStagedAuditRows,
  type InstagramTeamFixture,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  automationPath,
  insertAutomation,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  automationBackfillPath,
  automationBackfillsPath,
  insertAutomationBackfill,
  readAutomationBackfillRows,
} from '@/domains/app/sub-domains/automation/automation-backfill/__tests__/factories/automation-backfill.factory.js';

/** The error body of a refusal. */
interface ErrorBody {
  code?: string;
  reason?: string;
}

/**
 * Routes 38–39 — past comments (feat-instagram-dm-sending routes-final § 4.C, ROUTE R15; AC-8.1–AC-8.3,
 * AC-8.9) over HTTP: a start on a live comment automation answers the read `queued` and the
 * automation's object shows it as `open_backfill`; days outside 1–7, a draft or paused automation, a
 * Live-comment automation, a plan without past comments, a connection without the permission and a
 * second start while one is open are refused; the read by id under its own automation only; the
 * gates, the idempotency key, the audit entry and team-only. The database, auth, permissions,
 * idempotency and audit are real.
 */
describe('Automation backfill routes 38–39 (past comments, § 4.C)', () => {
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

  function errorOf(response: InjectHttpResult): ErrorBody {
    return (response.json() as { error: ErrorBody }).error;
  }

  function dataOf<T = Record<string, unknown>>(response: InjectHttpResult): T {
    return (response.json() as { data: T }).data;
  }

  /** Gives the team a plan with these features (Free or Creator, P83). */
  async function usePlan(features: typeof FREE_PLAN_FEATURES): Promise<void> {
    const plan = await createTestPlan({ features, priceMonthly: '29.00', priceYearly: '276.00' });
    await createTestSubscription({
      organizationId: team.organization.id,
      planId: plan.id,
      status: 'ACTIVE',
    });
  }

  /** A live automation of the team's account (comment unless told otherwise). */
  function liveAutomation(overrides: Record<string, unknown> = {}) {
    return insertAutomation({
      organizationId: team.organization.id,
      channelAccountId: account.channel_account_id,
      status: 'live',
      trigger_type: 'comment',
      ...overrides,
    } as Parameters<typeof insertAutomation>[0]);
  }

  function start({
    automationPublicId,
    body = { days: 3 },
    token = team.ownerToken,
    idempotencyKey = `backfill-${randomUUID()}`,
  }: {
    automationPublicId: string;
    body?: unknown;
    token?: string;
    idempotencyKey?: string | null;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'POST',
      url: automationBackfillsPath(automationPublicId),
      token,
      headers: idempotencyKey === null ? {} : { 'x-idempotency-key': idempotencyKey },
      payload: body,
    });
  }

  function readOne({
    automationPublicId,
    automationBackfillPublicId,
    token = team.ownerToken,
  }: {
    automationPublicId: string;
    automationBackfillPublicId: string;
    token?: string;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'GET',
      url: automationBackfillPath({ automationPublicId, automationBackfillPublicId }),
      token,
    });
  }

  describe('route 38 — start a read (AU31, AC-8.1)', () => {
    it('wakes the account read job on `instagram-tasks` after its commit, at the lowest priority (WC-41, R41)', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      const tasks = new Queue('instagram-tasks', {
        connection: getBullMQConnectionOptions(),
        prefix: getBullMQKeyPrefix(),
      });
      try {
        await tasks.obliterate({ force: true });
        const automation = await liveAutomation();
        const response = await start({ automationPublicId: automation.public_id });
        expect(response.statusCode, response.body).toBe(200);
        const jobs = await tasks.getJobs(['prioritized', 'waiting', 'delayed']);
        expect(
          jobs.map((job) => ({ name: job.name, data: job.data, priority: job.opts.priority })),
        ).toEqual([
          {
            name: 'automation-backfill-read',
            data: expect.objectContaining({
              organizationPublicId: team.organization.public_id,
              taskInput: { channelAccountPublicId: account.public_id },
            }),
            priority: 20,
          },
        ]);
      } finally {
        await tasks.obliterate({ force: true });
        await tasks.close();
      }
    });

    it('answers the read queued for 1 to 7 days, shows it on the automation, and audits the start', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      const automation = await liveAutomation();
      const response = await start({ automationPublicId: automation.public_id, body: { days: 7 } });
      expect(response.statusCode, response.body).toBe(200);
      const backfill = dataOf<Record<string, unknown>>(response);
      expect(backfill).toMatchObject({
        automation_id: automation.public_id,
        days: 7,
        status: 'queued',
        posts_read: 0,
        found: 0,
        matched: 0,
        queued_count: 0,
        fail_reason: null,
        requested_by_user_id: team.owner.public_id,
        started_at: null,
        done_at: null,
      });
      expect(backfill.id).toMatch(/^abf_[a-z0-9]{21}$/);
      expect(backfill).not.toHaveProperty('last_error');

      const rows = await readAutomationBackfillRows(automation.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        channel_account_id: account.channel_account_id,
        status: 'queued',
        days: 7,
      });

      const object = await injectAuthenticated(app, {
        method: 'GET',
        url: automationPath(automation.public_id),
        token: team.ownerToken,
      });
      expect(dataOf<{ open_backfill: unknown }>(object).open_backfill).toEqual(backfill);

      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.automation_backfill.start',
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        severity: 'INFO',
        resource_type: 'automation_backfill',
        metadata: {
          automation_backfill_public_id: backfill.id,
          automation_public_id: automation.public_id,
          days: 7,
        },
      });
    });

    it('starts on a live ad-comment automation and with one day', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      const automation = await liveAutomation({
        trigger_type: 'ad_comment',
        ad_id: '120200000001',
      });
      const response = await start({ automationPublicId: automation.public_id, body: { days: 1 } });
      expect(response.statusCode, response.body).toBe(200);
      expect(dataOf(response)).toMatchObject({ days: 1, status: 'queued' });
    });

    it('refuses days outside 1–7, a fraction, a missing days and an unknown field with 400', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      const automation = await liveAutomation();
      for (const body of [{ days: 0 }, { days: 8 }, { days: 2.5 }, {}, { days: 3, posts: 5 }]) {
        const response = await start({ automationPublicId: automation.public_id, body });
        expect(response.statusCode, JSON.stringify(body)).toBe(400);
      }
      expect(await readAutomationBackfillRows(automation.id)).toEqual([]);
    });

    it('refuses a draft or paused automation with 409 automation_not_live', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      for (const status of ['draft', 'paused'] as const) {
        const automation = await liveAutomation({ status });
        const response = await start({ automationPublicId: automation.public_id });
        expect(response.statusCode).toBe(409);
        expect(errorOf(response).reason).toBe('automation_not_live');
        expect(await readAutomationBackfillRows(automation.id)).toEqual([]);
      }
    });

    it('refuses a Live-comment or any other kind with 422 automation_backfill_not_supported', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      for (const triggerType of ['live_comment', 'dm_keyword', 'story_reply'] as const) {
        const automation = await liveAutomation({ trigger_type: triggerType, keywords: ['price'] });
        const response = await start({ automationPublicId: automation.public_id });
        expect(response.statusCode, triggerType).toBe(422);
        expect(errorOf(response).reason).toBe('automation_backfill_not_supported');
      }
    });

    it('refuses a plan without past comments with 403 plan_lacks_feature (AC-8.2)', async () => {
      await usePlan(FREE_PLAN_FEATURES);
      const automation = await liveAutomation();
      const response = await start({ automationPublicId: automation.public_id });
      expect(response.statusCode).toBe(403);
      expect(errorOf(response).reason).toBe('plan_lacks_feature');
      expect(await readAutomationBackfillRows(automation.id)).toEqual([]);
    });

    it('refuses a connection without the comments permission with 409 permission_not_granted', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      await operatorQuery`
        UPDATE app.channel_connections
        SET scopes = array_remove(scopes, 'instagram_manage_comments')
        WHERE organization_id = ${team.organization.id}`;
      const automation = await liveAutomation();
      const response = await start({ automationPublicId: automation.public_id });
      expect(response.statusCode).toBe(409);
      expect(errorOf(response).reason).toBe('permission_not_granted');
    });

    it('refuses a second start while one is queued or reading, and starts again after a failed one (AC-8.3)', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      const automation = await liveAutomation();
      const first = await start({ automationPublicId: automation.public_id });
      expect(first.statusCode).toBe(200);
      const second = await start({ automationPublicId: automation.public_id });
      expect(second.statusCode).toBe(409);
      expect(errorOf(second).reason).toBe('automation_backfill_in_progress');

      await operatorQuery`
        UPDATE app.automation_backfills SET status = 'reading', started_at = now()
        WHERE automation_id = ${automation.id}`;
      const whileReading = await start({ automationPublicId: automation.public_id });
      expect(whileReading.statusCode).toBe(409);
      expect(errorOf(whileReading).reason).toBe('automation_backfill_in_progress');

      await operatorQuery`
        UPDATE app.automation_backfills
        SET status = 'failed', fail_reason = 'meta_error', done_at = now()
        WHERE automation_id = ${automation.id}`;
      const again = await start({ automationPublicId: automation.public_id });
      expect(again.statusCode).toBe(200);
      expect((await readAutomationBackfillRows(automation.id)).map((row) => row.status)).toEqual([
        'failed',
        'queued',
      ]);
    });

    it('lets two automations of the account each hold a queued read', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      const first = await liveAutomation({ name: 'First' });
      const second = await liveAutomation({ name: 'Second' });
      expect((await start({ automationPublicId: first.public_id })).statusCode).toBe(200);
      expect((await start({ automationPublicId: second.public_id })).statusCode).toBe(200);
    });

    it('replays the answer for a repeated idempotency key and writes one row', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      const automation = await liveAutomation();
      const idempotencyKey = `backfill-${randomUUID()}`;
      const first = await start({ automationPublicId: automation.public_id, idempotencyKey });
      const repeat = await start({ automationPublicId: automation.public_id, idempotencyKey });
      expect(first.statusCode).toBe(200);
      expect(repeat.statusCode).toBe(200);
      expect(dataOf<{ id: string }>(repeat).id).toBe(dataOf<{ id: string }>(first).id);
      expect(await readAutomationBackfillRows(automation.id)).toHaveLength(1);
    });
  });

  describe('route 39 — one read (AU33)', () => {
    it('reads a read of this automation with its numbers and a failed one with its reason (AC-8.4 shape)', async () => {
      const automation = await liveAutomation();
      const done = await insertAutomationBackfill({
        organizationId: team.organization.id,
        channelAccountId: account.channel_account_id,
        automationId: automation.id,
        status: 'done',
        posts_read: 12,
        found: 340,
        matched: 87,
        queued_count: 85,
        started_at: new Date('2026-11-21T09:00:00.000Z'),
        done_at: new Date('2026-11-21T09:40:00.000Z'),
      });
      const response = await readOne({
        automationPublicId: automation.public_id,
        automationBackfillPublicId: done.public_id,
        token: team.viewerToken,
      });
      expect(response.statusCode).toBe(200);
      expect(dataOf(response)).toMatchObject({
        id: done.public_id,
        status: 'done',
        posts_read: 12,
        found: 340,
        matched: 87,
        queued_count: 85,
        fail_reason: null,
        requested_by_user_id: null,
        started_at: '2026-11-21T09:00:00.000Z',
        done_at: '2026-11-21T09:40:00.000Z',
      });

      const failed = await insertAutomationBackfill({
        organizationId: team.organization.id,
        channelAccountId: account.channel_account_id,
        automationId: automation.id,
        status: 'failed',
        fail_reason: 'plan_feature_off',
        last_error: 'meta_error_code:2',
      });
      const failedResponse = await readOne({
        automationPublicId: automation.public_id,
        automationBackfillPublicId: failed.public_id,
      });
      expect(dataOf(failedResponse)).toMatchObject({
        status: 'failed',
        fail_reason: 'plan_feature_off',
      });
      expect(dataOf(failedResponse)).not.toHaveProperty('last_error');
      // Neither is open, so the automation's object shows none.
      const object = await injectAuthenticated(app, {
        method: 'GET',
        url: automationPath(automation.public_id),
        token: team.ownerToken,
      });
      expect(dataOf<{ open_backfill: unknown }>(object).open_backfill).toBeNull();
    });

    it("answers 404 automation_backfill_not_found for another automation's read and an unknown id", async () => {
      const automation = await liveAutomation({ name: 'This one' });
      const other = await liveAutomation({ name: 'Other one' });
      const read = await insertAutomationBackfill({
        organizationId: team.organization.id,
        channelAccountId: account.channel_account_id,
        automationId: other.id,
      });
      for (const automationBackfillPublicId of [read.public_id, 'abf_000000000000000000000']) {
        const response = await readOne({
          automationPublicId: automation.public_id,
          automationBackfillPublicId,
        });
        expect(response.statusCode).toBe(404);
        expect(errorOf(response).reason).toBe('automation_backfill_not_found');
      }
      const malformed = await readOne({
        automationPublicId: automation.public_id,
        automationBackfillPublicId: 'not-a-public-id',
      });
      expect(malformed.statusCode).toBe(400);
    });
  });

  describe('gates, keys and team-only (AC-8.9)', () => {
    it('refuses a Viewer the start with missing_permission; an Editor may start; a Viewer may read', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      const automation = await liveAutomation();
      const viewer = await start({
        automationPublicId: automation.public_id,
        token: team.viewerToken,
      });
      expect(viewer.statusCode).toBe(403);
      expect(errorOf(viewer).reason).toBe('missing_permission');
      const editor = await start({
        automationPublicId: automation.public_id,
        token: team.editorToken,
      });
      expect(editor.statusCode).toBe(200);
      const read = await readOne({
        automationPublicId: automation.public_id,
        automationBackfillPublicId: dataOf<{ id: string }>(editor).id,
        token: team.viewerToken,
      });
      expect(read.statusCode).toBe(200);
    });

    it('refuses a start without an idempotency key with 422 and writes nothing', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      const automation = await liveAutomation();
      const response = await start({
        automationPublicId: automation.public_id,
        idempotencyKey: null,
      });
      expect(response.statusCode).toBe(422);
      expect(await readAutomationBackfillRows(automation.id)).toEqual([]);
    });

    it('is team-only: a personal organization starts 422 and reads 404', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes({
        permissionCodes: ['automation:read', 'automation:update'],
      });
      const automation = await liveAutomation();
      const write = await start({
        automationPublicId: automation.public_id,
        token: personal.token,
      });
      expect(write.statusCode).toBe(422);
      const read = await readOne({
        automationPublicId: automation.public_id,
        automationBackfillPublicId: 'abf_000000000000000000000',
        token: personal.token,
      });
      expect(read.statusCode).toBe(404);
      expect(errorOf(read).reason).toBe('team_organization_required');
    });

    it("answers 404 automation_not_found for another organization's automation and read, writing nothing", async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      const other = await createInstagramTeam();
      const otherAccount = await insertInstagramAccount({ organizationId: other.organization.id });
      const foreign = await insertAutomation({
        organizationId: other.organization.id,
        channelAccountId: otherAccount.channel_account_id,
        status: 'live',
        trigger_type: 'comment',
      } as Parameters<typeof insertAutomation>[0]);
      const foreignRead = await insertAutomationBackfill({
        organizationId: other.organization.id,
        channelAccountId: otherAccount.channel_account_id,
        automationId: foreign.id,
      });
      const startResponse = await start({ automationPublicId: foreign.public_id });
      expect(startResponse.statusCode).toBe(404);
      expect(errorOf(startResponse).reason).toBe('automation_not_found');
      const readResponse = await readOne({
        automationPublicId: foreign.public_id,
        automationBackfillPublicId: foreignRead.public_id,
      });
      expect(readResponse.statusCode).toBe(404);
      expect(errorOf(readResponse).reason).toBe('automation_not_found');
      expect(await readAutomationBackfillRows(foreign.id)).toEqual([foreignRead]);
    });
  });
});
