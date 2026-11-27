import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { INSTAGRAM_DATABASE_TASKS_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-database-tasks.queue.js';
import { INSTAGRAM_RETRY_FAILED_JOB_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-retry-failed.job.schema.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  injectAuthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import { automation_run_events } from '@/domains/app/sub-domains/automation/automation-run/automation-run-event.schema.js';
import {
  createInstagramTeam,
  readStagedAuditRows,
  type InstagramTeamFixture,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  type ContactFixtureRow,
  contactPath,
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  automationPath,
  insertAutomation,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  type AutomationRunFixtureRow,
  insertAutomationRun,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  insertInstagramOutgoingMessage,
  readInstagramOutgoingMessages,
} from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/__tests__/factories/instagram-outgoing-message.factory.js';

const HOUR = 60 * 60 * 1000;

/**
 * The failed-message routes and "what happened" over HTTP (feat-instagram-dm-sending routes-final
 * § 3.A routes 24–26 — CTC9 — and § 4.A routes 36–37, over 6.B's message service — SNC14; AC-7.1–
 * AC-7.11): her messages and run history merged newest first across pages, never her text; the
 * summary per reason; the retry of exactly the allowed ones, once, with its audit entry; the gates
 * (a Viewer reads but cannot retry, an Editor may), the idempotency key, an opted-out contact, and
 * another organization's automation or contact. The database, auth, permissions and audit are real.
 */
describe('Failed messages and contact activity routes (24–26, 36–37)', () => {
  let app: FastifyInstance;

  /**
   * Runs the `retry-failed` jobs routes 26 / 37 queued (WC-42, R46) with the worker's handler, as
   * the database-heavy task worker does; answers how many jobs ran.
   */
  async function runQueuedRetries(): Promise<number> {
    const tasks = new Queue(INSTAGRAM_DATABASE_TASKS_QUEUE_NAME, {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
    });
    try {
      const jobs = (await tasks.getJobs(['waiting', 'prioritized'])).filter(
        (job) =>
          job.name === INSTAGRAM_RETRY_FAILED_JOB_NAME &&
          job.data.organizationPublicId === team.organization.public_id,
      );
      const handler = app.appDomain.instagramSendWork.taskHandlers[INSTAGRAM_RETRY_FAILED_JOB_NAME];
      for (const job of jobs) {
        await handler?.run({
          organizationPublicId: job.data.organizationPublicId,
          taskInput: handler.inputSchema.parse(job.data.taskInput),
          context: {
            jobId: String(job.id),
            runInDatabaseSlot: (callback) => callback(),
            returnTicket: async () => {
              throw new Error('not returned');
            },
          },
        });
        await job.remove();
      }
      return jobs.length;
    } finally {
      await tasks.close();
    }
  }
  let team: InstagramTeamFixture;
  let account: { id: number; public_id: string; channel_account_id: number };
  let automation: { id: number; public_id: string };
  let contact: ContactFixtureRow;
  let run: AutomationRunFixtureRow;

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
    automation = await insertAutomation({
      organizationId: team.organization.id,
      channelAccountId: account.channel_account_id,
      status: 'live',
      keywords: ['guide'],
    });
    contact = await insertContact({
      organizationId: team.organization.id,
      instagramAccountId: account.id,
      username: 'riya.k',
      email: 'riya@example.com',
      email_collected_at: new Date(),
      last_direct_message_received_at: new Date(Date.now() - HOUR),
    });
    run = await insertAutomationRun({
      organizationId: team.organization.id,
      automationId: automation.id,
      contactId: contact.id,
      isOpenKeyLeftOut: true,
      status: 'failed',
      failed_at: new Date(),
      waiting_for: null,
      waiting_since_at: null,
    });
  });

  function read(url: string, token = team.ownerToken): Promise<InjectHttpResult> {
    return injectAuthenticated(app, { method: 'GET', url, token });
  }

  function retry({
    url,
    token = team.ownerToken,
    idempotencyKey = `retry-${randomUUID()}`,
  }: {
    url: string;
    token?: string;
    idempotencyKey?: string | null;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'POST',
      url,
      token,
      headers: idempotencyKey === null ? {} : { 'x-idempotency-key': idempotencyKey },
    });
  }

  const automationFailed = () => `${automationPath(automation.public_id)}/failed-messages`;
  const contactFailed = () => `${contactPath(contact.public_id)}/failed-messages`;

  /** Two failed DMs to her open chat (retryable) and one already retried. */
  async function seedFailed(): Promise<void> {
    const channelAccountId = account.channel_account_id;
    await insertInstagramOutgoingMessage({ run, channelAccountId, message_number: 1 });
    await insertInstagramOutgoingMessage({ run, channelAccountId, message_number: 2 });
    await insertInstagramOutgoingMessage({
      run,
      channelAccountId,
      message_number: 3,
      owner_retry_at: new Date(Date.now() - HOUR),
    });
  }

  describe('route 24 — what happened (CT14, AC-7.1)', () => {
    it('merges her messages and her run history newest first across pages, never her text', async () => {
      const base = Date.now() - 10 * 60 * 1000;
      await insertInstagramOutgoingMessage({
        run,
        channelAccountId: account.channel_account_id,
        message_number: 1,
        status: 'sent',
        reason: null,
        sent_at: new Date(base + 2000),
        created_at: new Date(base + 1000),
        updated_at: new Date(base + 2000),
      });
      await insertInstagramOutgoingMessage({
        run,
        channelAccountId: account.channel_account_id,
        message_number: 2,
        created_at: new Date(base + 3000),
        updated_at: new Date(base + 3000),
      });
      await getOperatorDatabase()
        .insert(automation_run_events)
        .values([
          {
            organization_id: team.organization.id,
            automation_run_id: run.id,
            automation_run_started_at: run.started_at,
            event_type: 'email_received',
            created_at: new Date(base + 2000),
          },
          {
            organization_id: team.organization.id,
            automation_run_id: run.id,
            automation_run_started_at: run.started_at,
            event_type: 'status_changed',
            status: 'failed',
            created_at: new Date(base + 4000),
          },
        ]);

      const seen: Array<Record<string, unknown>> = [];
      let after: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const query: string =
          after === null ? '?limit=1' : `?limit=1&after=${encodeURIComponent(after)}`;
        const response = await read(
          `${contactPath(contact.public_id)}/activity${query}`,
          team.viewerToken,
        );
        expect(response.statusCode).toBe(200);
        const body = response.json() as {
          data: Array<Record<string, unknown>>;
          meta: {
            message_horizon_days: number;
            pagination: { next: string | null; has_more: boolean };
          };
        };
        expect(body.meta.message_horizon_days).toBe(30);
        seen.push(...body.data);
        after = body.meta.pagination.next;
        if (!body.meta.pagination.has_more) break;
      }
      expect(seen.map((item) => [item.source, item.event_type ?? item.message_number])).toEqual([
        ['run_event', 'status_changed'],
        ['message', 2],
        ['run_event', 'email_received'],
        ['message', 1],
      ]);
      expect(seen[1]).toMatchObject({
        automation: { id: automation.public_id },
        automation_run_id: run.public_id,
        broadcast_id: null,
        message_type: 'message',
        status: 'failed',
        reason: 'bad_text',
        channel: 'direct',
      });
      expect(String(seen[1]?.id)).toMatch(/^igm_/);
      expect(JSON.stringify(seen)).not.toContain('riya@example.com');
    });

    it("answers 404 contact_not_found for another organization's contact, and retries nothing", async () => {
      const other = await createInstagramTeam();
      const response = await read(`${contactPath(contact.public_id)}/activity`, other.ownerToken);
      expect(response.statusCode).toBe(404);
      expect((response.json() as { error: { reason: string } }).error.reason).toBe(
        'contact_not_found',
      );
      await seedFailed();
      const before = await readInstagramOutgoingMessages(team.organization.id);
      expect((await read(`${contactFailed()}/summary`, other.ownerToken)).statusCode).toBe(404);
      expect(
        (await retry({ url: `${contactFailed()}/retry`, token: other.ownerToken })).statusCode,
      ).toBe(404);
      expect(await readInstagramOutgoingMessages(team.organization.id)).toEqual(before);
    });
  });

  describe('routes 36–37 — an automation (AU18, AC-7.2–AC-7.4, AC-7.10, AC-7.11)', () => {
    it('counts by reason and changes nothing; a Viewer may read', async () => {
      await seedFailed();
      const before = await readInstagramOutgoingMessages(team.organization.id);
      const response = await read(`${automationFailed()}/summary`, team.viewerToken);
      expect(response.statusCode).toBe(200);
      expect((response.json() as { data: unknown }).data).toEqual({
        failed_count: 3,
        retryable_count: 2,
        not_retryable: {
          too_old: 0,
          chat_closed: 0,
          final_for_person: 0,
          text_refused: 0,
          broadcast: 0,
          already_retried: 1,
        },
        horizon_days: 30,
      });
      expect(await readInstagramOutgoingMessages(team.organization.id)).toEqual(before);
    });

    it('refuses a Viewer, needs X-Idempotency-Key, retries the allowed ones once for an Editor and writes one audit entry', async () => {
      await seedFailed();
      const viewer = await retry({ url: `${automationFailed()}/retry`, token: team.viewerToken });
      expect(viewer.statusCode).toBe(403);
      expect((viewer.json() as { error: { reason: string } }).error.reason).toBe(
        'missing_permission',
      );
      const keyless = await retry({ url: `${automationFailed()}/retry`, idempotencyKey: null });
      expect(keyless.statusCode).toBe(422);

      const key = `retry-${randomUUID()}`;
      const response = await retry({
        url: `${automationFailed()}/retry`,
        token: team.editorToken,
        idempotencyKey: key,
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { data: unknown }).data).toEqual({
        expected_retry_count: 2,
        is_queued: true,
      });
      // The press answers at once; the `retry-failed` job puts them back (WC-42, R46).
      expect(
        (await readInstagramOutgoingMessages(team.organization.id)).map((row) => row.status),
      ).toEqual(['failed', 'failed', 'failed']);
      expect(await runQueuedRetries()).toBe(1);
      const rows = await readInstagramOutgoingMessages(team.organization.id);
      expect(rows.map((row) => row.status)).toEqual(['waiting', 'waiting', 'failed']);
      // The same key again starts nothing twice; a new press finds nothing left to retry.
      const replay = await retry({
        url: `${automationFailed()}/retry`,
        token: team.editorToken,
        idempotencyKey: key,
      });
      expect(replay.statusCode).toBe(200);
      const again = await retry({ url: `${automationFailed()}/retry`, token: team.editorToken });
      expect(
        (again.json() as { data: { expected_retry_count: number } }).data.expected_retry_count,
      ).toBe(0);
      const audits = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.instagram_message.retry',
      });
      expect(audits).toHaveLength(2);
      expect(audits[0]?.metadata).toMatchObject({
        automation_public_id: automation.public_id,
        retried_count: 2,
        failed_count: 3,
      });
    });

    it("answers 404 automation_not_found for another organization's automation", async () => {
      const other = await createInstagramTeam();
      const response = await read(`${automationFailed()}/summary`, other.ownerToken);
      expect(response.statusCode).toBe(404);
      await seedFailed();
      const before = await readInstagramOutgoingMessages(team.organization.id);
      expect(
        (await retry({ url: `${automationFailed()}/retry`, token: other.ownerToken })).statusCode,
      ).toBe(404);
      expect(await readInstagramOutgoingMessages(team.organization.id)).toEqual(before);
    });
  });

  describe('routes 25–26 — a contact (CT15, AC-7.6, AC-7.9)', () => {
    it('does the same for one person, and an opted-out contact has none to retry', async () => {
      await seedFailed();
      const summary = await read(`${contactFailed()}/summary`);
      expect((summary.json() as { data: { retryable_count: number } }).data.retryable_count).toBe(
        2,
      );
      const response = await retry({ url: `${contactFailed()}/retry`, token: team.editorToken });
      expect((response.json() as { data: unknown }).data).toEqual({
        expected_retry_count: 2,
        is_queued: true,
      });
      expect(await runQueuedRetries()).toBe(1);
      expect(
        (await readInstagramOutgoingMessages(team.organization.id)).filter(
          (row) => row.status === 'waiting',
        ),
      ).toHaveLength(2);

      const optedOut = await insertContact({
        organizationId: team.organization.id,
        instagramAccountId: account.id,
        username: 'stopped',
        opted_out_at: new Date(),
        last_direct_message_received_at: new Date(Date.now() - HOUR),
      });
      const optedOutRun = await insertAutomationRun({
        organizationId: team.organization.id,
        automationId: automation.id,
        contactId: optedOut.id,
        isOpenKeyLeftOut: true,
        status: 'failed',
        failed_at: new Date(),
        waiting_for: null,
        waiting_since_at: null,
      });
      await insertInstagramOutgoingMessage({
        run: optedOutRun,
        channelAccountId: account.channel_account_id,
      });
      const path = `${contactPath(optedOut.public_id)}/failed-messages`;
      const counted = await read(`${path}/summary`);
      expect(
        (counted.json() as { data: { not_retryable: { final_for_person: number } } }).data
          .not_retryable.final_for_person,
      ).toBe(1);
      const none = await retry({ url: `${path}/retry` });
      expect(
        (none.json() as { data: { expected_retry_count: number } }).data.expected_retry_count,
      ).toBe(0);
      const viewer = await retry({ url: `${path}/retry`, token: team.viewerToken });
      expect(viewer.statusCode).toBe(403);
    });
  });
});
