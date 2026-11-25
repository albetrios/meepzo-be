import { Queue } from 'bullmq';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { getEnv } from '@/shared/config/env.config.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { SENSITIVE_REDACTION_PLACEHOLDER } from '@/shared/utils/security/sensitive-redaction.util.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { runOrganizationTombstoneRetentionJob } from '@/domains/tenancy/sub-domains/organization/workers/organization-tombstone-retention.processor.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import { AutomationCommentLogRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.repository.js';
import { RecordingSendingPort } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/recording-sending-port.factory.js';
import { runAutomationRunWaitExpiryJob } from '@/domains/app/sub-domains/automation/automation-run/workers/automation-run-wait-expiry.processor.js';
import { runAutomationTombstoneRetentionJob } from '@/domains/app/sub-domains/automation/workers/automation-tombstone-retention.processor.js';
import { INSTAGRAM_WEBHOOK_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import { runAppPartitionUpkeepJob } from '@/domains/app/workers/app-partition-upkeep.processor.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationRun,
  readCommentLogRows,
  readRunEventTrail,
  readRunRow,
  readRunRows,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  CONTACTS_PATH,
  insertContact,
  insertInstagramAccount,
  readContactRow,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  createInstagramTeam,
  mockInstagramUnsubscribe,
  readStagedAuditRows,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  FORM_CONTENT_TYPE,
  META_DATA_DELETION_PATH,
  buildMetaSignedRequest,
  metaCallbackFormBody,
  metaIssuedAtAfterConnections,
  metaSignedRequestPayload,
} from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection-meta-callback.factory.js';
import { INSTAGRAM_WEBHOOK_EVENTS_PATH } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/__tests__/factories/instagram-webhook-event.factory.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import {
  type InjectHttpResult,
  injectAuthenticated,
  injectRoute,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  type ConnectedInstagramTeam,
  JORDAN,
  MORGAN,
  type PersonHistory,
  captureLogLines,
  commentChange,
  connectInstagramTeam,
  contactOf,
  countAppRowsOfOrganization,
  daysBefore,
  deleteContactAsOwner,
  deliverInstagramEvents,
  directMessageItem,
  historyAutomations,
  liveAutomation,
  mockInstagramConversation,
  personalValuesOf,
  processInstagramEvents,
  readAppRowsOfOrganization,
  readRowsOfContact,
  runOf,
  say,
  writeHistory,
  writeSegmentHistory,
  writeBroadcastHistory,
  writeSendingHistory,
} from './instagram-retention-erasure.helper.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Retention and erasure end to end (routes-final § 2 CT7–CT9, § 1.D, § 3.B AU25–AU26, § 4.B
 * WH18–WH19; D8, D22, D24–D26 — ROUTE R18, AC-12.1–AC-12.13): people write to a connected account
 * over Meta's signed webhook, the real processing job and run engine work with them (Instagram
 * mocked at the network), and then each way data leaves — the 7-day wait, the daily clean-ups in
 * their order, a contact delete (route 10), Meta's data deletion (route 8), the organization delete
 * and its purge — is checked on the whole `app` schema; and no log line of any of it carries a
 * person's data.
 */

/** `days` whole days after now. */
function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * MILLISECONDS_PER_DAY);
}

describe('Instagram retention and erasure flow (e2e)', () => {
  let app: FastifyInstance;
  /** A reader of the queue the webhook route adds to — never a worker. */
  let processingQueue: Queue;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    // The run engine saves waiting messages through the channel's sending port (AU35); Instagram's
    // lands at R19–R20, so the suite records them.
    app.appDomain.channelSendingPorts.instagram = new RecordingSendingPort();
    processingQueue = new Queue(INSTAGRAM_WEBHOOK_QUEUE_NAME, {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
    });
  });

  afterAll(async () => {
    await processingQueue.obliterate({ force: true });
    await processingQueue.close();
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    nock.cleanAll();
    await metaGraphCircuit.reset();
  });

  /** Makes a waiting run look as if it waited since `days` ago. */
  async function ageWait({ runId, days }: { runId: number; days: number }): Promise<void> {
    const since = daysBefore({ from: new Date(), days });
    await operatorQuery`
      UPDATE app.automation_runs SET waiting_since_at = ${since} WHERE id = ${runId}`;
  }

  function runWaitCheck(now: Date = new Date()) {
    return runAutomationRunWaitExpiryJob({ runService: app.appDomain.automationRunService, now });
  }

  /** The organization's `app` rows but the webhook events (a contact erase leaves those, CQ1). */
  async function readRowsWithoutWebhookEvents(organizationId: number) {
    const { instagram_webhook_events: _events, ...rows } =
      await readAppRowsOfOrganization(organizationId);
    return rows;
  }

  describe('the 7-day wait (AC-12.1, AC-12.2)', () => {
    it('cancels a run waiting more than 7 days with its history and log; its saved automation never starts; the contact may start it again', async () => {
      const team = await connectInstagramTeam(app);
      const price = await liveAutomation({
        team,
        name: 'Price list',
        keywords: ['price'],
        is_email_collection_enabled: true,
      });
      const giveaway = await liveAutomation({ team, name: 'Giveaway', keywords: ['giveaway'] });
      mockInstagramConversation({ instagramAppUserId: team.profile.id, people: [JORDAN] });
      await say({ app, team, changes: [commentChange({ person: JORDAN, text: 'price please' })] });
      await say({
        app,
        team,
        changes: [commentChange({ person: JORDAN, text: 'giveaway please' })],
      });
      const waiting = await runOf({ automation: price });
      // Since R14 nothing is queued behind her email: the giveaway comment is logged
      // `waiting_for_other_email` (P132).
      expect(waiting).toMatchObject({ status: 'waiting', waiting_for: 'email' });
      await ageWait({ runId: waiting.id, days: 8 });

      expect(await runWaitCheck()).toEqual({
        scanned: 1,
        cancelled: 1,
        failedOrganizationCount: 0,
      });

      expect(await readRunRow(waiting.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'wait_expired',
        waiting_for: null,
      });
      expect(await readRunEventTrail(waiting.id)).toEqual([
        'status_changed:running',
        'status_changed:waiting',
        'status_changed:cancelled',
      ]);
      const logs = await readCommentLogRows(team.organization.id);
      expect(
        logs.map((log) => [log.automation_id, log.overall_status, log.ignored_reason]),
      ).toEqual([
        [price.id, 'cancelled', null],
        [giveaway.id, 'ignored', 'waiting_for_other_email'],
      ]);

      // The same automation starts again for the contact; the saved one is gone for good.
      await say({ app, team, changes: [commentChange({ person: JORDAN, text: 'price again' })] });
      await say({
        app,
        team,
        messaging: [directMessageItem({ person: JORDAN, text: JORDAN.email })],
      });
      const runs = await readRunRows(team.organization.id);
      expect(runs.map((run) => [run.automation_id, run.status])).toEqual([
        [price.id, 'cancelled'],
        [price.id, 'completed'],
      ]);
    });

    it('leaves a run that got its answer just before, and a repeat changes nothing', async () => {
      const team = await connectInstagramTeam(app);
      await liveAutomation({
        team,
        name: 'Catalog',
        trigger_type: 'dm',
        keywords: ['catalog'],
        is_email_collection_enabled: true,
      });
      mockInstagramConversation({ instagramAppUserId: team.profile.id, people: [JORDAN, MORGAN] });
      await say({
        app,
        team,
        messaging: [JORDAN, MORGAN].map((person) =>
          directMessageItem({ person, text: 'catalog please' }),
        ),
      });
      const [silent, answering] = await readRunRows(team.organization.id);
      for (const run of [silent, answering]) {
        expect(run).toMatchObject({ status: 'waiting', waiting_for: 'email' });
        await ageWait({ runId: run?.id ?? 0, days: 8 });
      }
      // Morgan answers minutes before the hourly check.
      await say({
        app,
        team,
        messaging: [directMessageItem({ person: MORGAN, text: MORGAN.email })],
      });

      expect(await runWaitCheck()).toMatchObject({ scanned: 1, cancelled: 1 });

      expect(await readRunRow(silent?.id ?? 0)).toMatchObject({ cancel_reason: 'wait_expired' });
      expect(await readRunRow(answering?.id ?? 0)).toMatchObject({
        status: 'completed',
        cancel_reason: null,
      });
      expect(await readRunEventTrail(answering?.id ?? 0)).toEqual([
        'status_changed:running',
        'status_changed:waiting',
        'email_received:-',
        'status_changed:running',
        'status_changed:completed',
      ]);
      const before = await readAppRowsOfOrganization(team.organization.id);
      expect(await runWaitCheck()).toMatchObject({ scanned: 0, cancelled: 0 });
      expect(await readAppRowsOfOrganization(team.organization.id)).toEqual(before);
    });

    it("never lists a deleted organization's runs or windows, which would keep their place in every batch", async () => {
      const team = await createInstagramTeam();
      const account = await insertInstagramAccount({ organizationId: team.organization.id });
      const key = { organizationId: team.organization.id, instagramAccountId: account.id };
      const automation = await insertAutomation({ ...key, status: 'live' });
      const contact = await insertContact(key);
      const run = await insertAutomationRun({
        organizationId: team.organization.id,
        automationId: automation.id,
        contactId: contact.id,
        waiting_since_at: daysBefore({ from: new Date(), days: 8 }),
      });
      await insertAutomation({
        ...key,
        status: 'live',
        target_scope: 'next',
        next_post_status: 'waiting',
        next_post_starts_at: daysBefore({ from: new Date(), days: 3 }),
        next_post_ends_at: daysBefore({ from: new Date(), days: 1 }),
      });
      await operatorQuery`
        UPDATE tenancy.organizations SET deleted_at = now() WHERE id = ${team.organization.id}`;

      expect(await runWaitCheck()).toMatchObject({ scanned: 0 });
      expect(await readRunRow(run.id)).toMatchObject({ status: 'waiting' });
    });
  });

  function listWebhookEvents(team: ConnectedInstagramTeam): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      url: `${INSTAGRAM_WEBHOOK_EVENTS_PATH}?limit=100`,
      token: team.ownerToken,
    });
  }

  async function readWebhookEventRows(team: ConnectedInstagramTeam) {
    return (await readAppRowsOfOrganization(team.organization.id)).instagram_webhook_events;
  }

  describe('DELETE /app/contacts/{contact_id} — a contact delete (AC-12.8–AC-12.10)', () => {
    it('cancels the open runs and clears every personal copy in the schema; the ids and everyone else stay (AC-12.8)', async () => {
      const team = await connectInstagramTeam(app);
      mockInstagramConversation({ instagramAppUserId: team.profile.id, people: [JORDAN, MORGAN] });
      const automations = await historyAutomations({ team });
      const jordan = await writeHistory({ app, team, person: JORDAN, automations });
      const morgan = await writeHistory({ app, team, person: MORGAN, automations });
      expect(jordan.waitingRun).toMatchObject({ status: 'waiting' });
      const copies = JSON.stringify(await readRowsOfContact({ team, contact: jordan.contact }));
      for (const value of personalValuesOf(JORDAN)) expect(copies).toContain(value);
      const logsBefore = await readCommentLogRows(team.organization.id);
      const morganBefore = await readRowsOfContact({ team, contact: morgan.contact });

      const response = await deleteContactAsOwner({
        app,
        team,
        contactPublicId: jordan.contact.public_id,
      });

      expect(response.statusCode).toBe(204);
      // The open runs: cancelled, one history entry each, the saved automation dropped.
      for (const run of [jordan.waitingRun, jordan.runningRun]) {
        expect(await readRunRow(run.id)).toMatchObject({
          status: 'cancelled',
          cancel_reason: 'contact_deleted',
          waiting_for: null,
          trigger_instagram_media_id: run.trigger_instagram_media_id,
          trigger_instagram_comment_id: run.trigger_instagram_comment_id,
        });
        const trail = await readRunEventTrail(run.id);
        expect(trail.filter((event) => event === 'status_changed:cancelled')).toHaveLength(1);
      }
      for (const run of jordan.endedRuns) {
        expect(await readRunRow(run.id)).toMatchObject({
          status: run.status,
          trigger_instagram_story_id: run.trigger_instagram_story_id,
        });
      }
      const logsAfter = await readCommentLogRows(team.organization.id);
      expect(logsAfter.find((log) => log.automation_run_id === jordan.waitingRun.id)).toMatchObject(
        { overall_status: 'cancelled', waiting_for: null },
      );
      expect(
        logsAfter.map((log) => [log.id, log.instagram_media_id, log.instagram_comment_id]),
      ).toEqual(
        logsBefore.map((log) => [log.id, log.instagram_media_id, log.instagram_comment_id]),
      );
      // Nothing personal is left anywhere in the schema but the webhook events (AC-12.10).
      const left = JSON.stringify(await readRowsWithoutWebhookEvents(team.organization.id));
      for (const value of [
        ...personalValuesOf(JORDAN),
        ...jordan.texts,
        JORDAN.instagramUserId,
        'Tag of jordan',
      ]) {
        expect(left).not.toContain(value);
      }
      expect(await readRowsOfContact({ team, contact: morgan.contact })).toEqual(morganBefore);
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.contact.delete',
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.metadata).toMatchObject({ contact_public_id: jordan.contact.public_id });
      expect(JSON.stringify(audit)).not.toContain(JORDAN.username);
    });

    it('leaves the person’s webhook events, masked in the list, until their day part is dropped (AC-12.10; 8 days, WC-48)', async () => {
      const team = await connectInstagramTeam(app);
      mockInstagramConversation({ instagramAppUserId: team.profile.id, people: [JORDAN] });
      const automations = await historyAutomations({ team });
      const jordan = await writeHistory({ app, team, person: JORDAN, automations });
      const before = await readWebhookEventRows(team);
      expect(before).toHaveLength(3);

      await deleteContactAsOwner({ app, team, contactPublicId: jordan.contact.public_id });

      expect(await readWebhookEventRows(team)).toEqual(before);
      const listed = await listWebhookEvents(team);
      expect(listed.statusCode).toBe(200);
      expect((listed.json() as { data: unknown[] }).data).toHaveLength(3);
      expect(listed.body).toContain('j***@e***.com');
      expect(listed.body).not.toContain(JORDAN.email);
      expect(listed.body).not.toContain(JORDAN.phone);

      // Today's day part is inside its 8 days: the hourly drop leaves it.
      await runAppPartitionUpkeepJob({ mode: 'drop' });
      expect(await readWebhookEventRows(team)).toEqual(before);

      // Received 9 days ago, the events sit in a day part past its keep time (made through the
      // part maker, as the migration makes them): the hourly drop takes the whole part.
      const nineDaysAgo = daysFromNow(-9).toISOString().slice(0, 10);
      await operatorQuery`SELECT app.fn_create_daily_partitions('app.instagram_webhook_events'::regclass, ${nineDaysAgo}::date, ${nineDaysAgo}::date)`;
      await operatorQuery`
        UPDATE app.instagram_webhook_events
           SET created_at = ${nineDaysAgo}::date + interval '12 hours',
               updated_at = ${nineDaysAgo}::date + interval '12 hours',
               processed_at = CASE WHEN processed_at IS NULL THEN NULL ELSE ${nineDaysAgo}::date + interval '12 hours' END
         WHERE organization_id = ${team.organization.id}
      `;
      await runAppPartitionUpkeepJob({ mode: 'drop' });
      expect(await readWebhookEventRows(team)).toEqual([]);
    });

    it('starts the person afresh: an event still waiting makes a new contact and never touches the erased one (CT9)', async () => {
      const team = await connectInstagramTeam(app);
      mockInstagramConversation({ instagramAppUserId: team.profile.id, people: [JORDAN] });
      const automations = await historyAutomations({ team });
      const jordan = await writeHistory({ app, team, person: JORDAN, automations });
      await deleteContactAsOwner({ app, team, contactPublicId: jordan.contact.public_id });
      const erasedBefore = await readRowsOfContact({ team, contact: jordan.contact });

      await processInstagramEvents({ app, team });

      expect(await readRowsOfContact({ team, contact: jordan.contact })).toEqual(erasedBefore);
      const fresh = await contactOf({ team, person: JORDAN });
      expect(fresh.id).not.toBe(jordan.contact.id);
      expect(fresh).toMatchObject({
        username: JORDAN.username,
        email: null,
        phone: null,
        tags: [],
      });
    });

    it.each([
      {
        part: 'the comment-log copies',
        failingStep: () => vi.spyOn(AutomationCommentLogRepository.prototype, 'eraseContactCopies'),
      },
      {
        part: 'the contact itself',
        failingStep: () => vi.spyOn(ContactRepository.prototype, 'erase'),
      },
    ])(
      'erases nothing when $part fails — no run cancelled, no copy cleared, no audit entry (AC-12.9)',
      async ({ failingStep }) => {
        const team = await connectInstagramTeam(app);
        mockInstagramConversation({ instagramAppUserId: team.profile.id, people: [JORDAN] });
        const automations = await historyAutomations({ team });
        const { contact } = await writeHistory({ app, team, person: JORDAN, automations });
        const before = await readAppRowsOfOrganization(team.organization.id);
        failingStep().mockRejectedValueOnce(new Error('forced failure'));

        const failed = await deleteContactAsOwner({
          app,
          team,
          contactPublicId: contact.public_id,
        });

        expect(failed.statusCode).toBe(500);
        expect(await readAppRowsOfOrganization(team.organization.id)).toEqual(before);
        expect(
          await readStagedAuditRows({
            organizationPublicId: team.organization.public_id,
            action: 'app.contact.delete',
          }),
        ).toEqual([]);

        // The team tries again and everything goes.
        const retried = await deleteContactAsOwner({
          app,
          team,
          contactPublicId: contact.public_id,
        });
        expect(retried.statusCode).toBe(204);
        expect((await readContactRow(contact.id))?.deleted_at).toBeInstanceOf(Date);
      },
    );
  });

  /** The erased person's data is nowhere but in the webhook events, and no contact came back. */
  async function expectNothingPersonalLeft(team: ConnectedInstagramTeam): Promise<void> {
    const rows = await readRowsWithoutWebhookEvents(team.organization.id);
    const left = JSON.stringify(rows);
    for (const value of [...personalValuesOf(JORDAN), 'my-private-trigger']) {
      expect(left).not.toContain(value);
    }
    expect(rows.contacts?.filter((contact) => contact.deleted_at === null)).toEqual([]);
  }

  describe('an erase and an event meeting on the contact (AC-12.8, AC-12.11)', () => {
    /** A point a test opens once something else has happened. */
    function createGate(): { opened: Promise<void>; open: () => void } {
      let open: () => void = () => undefined;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { opened, open };
    }

    /** Long enough for a statement to reach the lock it waits for. */
    const waitForTheLock = () => new Promise<void>((resolve) => setTimeout(resolve, 300));

    it('the erase first: the event waits for it, then starts nothing', async () => {
      const team = await connectInstagramTeam(app);
      await liveAutomation({ team, name: 'Every comment' });
      const isErasing = createGate();
      const mayCommit = createGate();
      const eraseLogCopies = AutomationCommentLogRepository.prototype.eraseContactCopies;
      vi.spyOn(
        AutomationCommentLogRepository.prototype,
        'eraseContactCopies',
      ).mockImplementationOnce(async function holdErase(this: AutomationCommentLogRepository, key) {
        isErasing.open();
        await mayCommit.opened;
        return eraseLogCopies.call(this, key);
      });
      let erase: Promise<InjectHttpResult> | undefined;
      const { sends } = mockInstagramConversation({
        instagramAppUserId: team.profile.id,
        people: [JORDAN],
        // While the comment's post is read: an erase holds the contact, not committed yet.
        onRead: async (read) => {
          if (read !== 'post') return;
          const contact = await contactOf({ team, person: JORDAN });
          erase = deleteContactAsOwner({ app, team, contactPublicId: contact.public_id });
          await isErasing.opened;
        },
      });
      await deliverInstagramEvents({
        app,
        team,
        changes: [commentChange({ person: JORDAN, text: 'my-private-trigger' })],
      });

      const processed = processInstagramEvents({ app, team });
      await isErasing.opened;
      await waitForTheLock();
      mayCommit.open();

      expect((await erase)?.statusCode).toBe(204);
      expect(await processed).toMatchObject({ processedEventCount: 1 });
      expect(sends).toEqual([]);
      expect(await readRunRows(team.organization.id)).toEqual([]);
      expect(await readCommentLogRows(team.organization.id)).toEqual([]);
      await expectNothingPersonalLeft(team);
    });

    it('the event first: the erase waits for it, then cancels the run and clears what was written', async () => {
      const team = await connectInstagramTeam(app);
      await liveAutomation({ team, name: 'Every comment' });
      mockInstagramConversation({ instagramAppUserId: team.profile.id, people: [JORDAN] });
      const areWritten = createGate();
      const mayCommit = createGate();
      const insertLogs = AutomationCommentLogRepository.prototype.insertMany;
      // The run and its log are written, not committed yet.
      vi.spyOn(AutomationCommentLogRepository.prototype, 'insertMany').mockImplementationOnce(
        async function holdUnit(this: AutomationCommentLogRepository, logs) {
          const inserted = await insertLogs.call(this, logs);
          areWritten.open();
          await mayCommit.opened;
          return inserted;
        },
      );

      const said = say({
        app,
        team,
        changes: [commentChange({ person: JORDAN, text: 'my-private-trigger' })],
      });
      await areWritten.opened;
      const contact = await contactOf({ team, person: JORDAN });
      const erase = deleteContactAsOwner({ app, team, contactPublicId: contact.public_id });
      await waitForTheLock();
      mayCommit.open();
      await said;

      expect((await erase).statusCode).toBe(204);
      const runs = await readRunRows(team.organization.id);
      expect(runs.map((run) => [run.status, run.cancel_reason])).toEqual([
        ['cancelled', 'contact_deleted'],
      ]);
      expect(await readCommentLogRows(team.organization.id)).toHaveLength(1);
      await expectNothingPersonalLeft(team);
    });
  });

  /** Meta's signed data-deletion request for the account the team connected (route 8). */
  function requestMetaDataDeletion(team: ConnectedInstagramTeam): Promise<InjectHttpResult> {
    return injectRoute(app, {
      method: 'POST',
      url: META_DATA_DELETION_PATH,
      headers: { 'content-type': FORM_CONTENT_TYPE },
      payload: metaCallbackFormBody(
        buildMetaSignedRequest({
          payload: metaSignedRequestPayload({
            userId: team.profile.id,
            issuedAt: metaIssuedAtAfterConnections(),
          }),
          appSecret: getEnv().META_APP_SECRET ?? '',
        }),
      ),
    });
  }

  describe("Meta's data deletion (AC-12.7; D22, D24)", () => {
    it("erases the account's token, profile and posts, and touches no contact, run, log or event", async () => {
      const team = await connectInstagramTeam(app);
      mockInstagramConversation({ instagramAppUserId: team.profile.id, people: [JORDAN] });
      const automations = await historyAutomations({ team });
      const { waitingRun } = await writeHistory({ app, team, person: JORDAN, automations });
      const {
        instagram_accounts: _account,
        channel_accounts: _channelAccounts,
        channel_connections: _connections,
        channel_connection_tokens: tokensBefore,
        instagram_media: postsBefore,
        instagram_send_lanes: lanesBefore,
        ...before
      } = await readAppRowsOfOrganization(team.organization.id);
      expect(tokensBefore).toHaveLength(1);
      expect(postsBefore).toHaveLength(2);

      const response = await requestMetaDataDeletion(team);

      expect(response.statusCode).toBe(200);
      const after = await readAppRowsOfOrganization(team.organization.id);
      const {
        instagram_accounts: accounts,
        channel_accounts: channelAccounts,
        channel_connections: connections,
        channel_connection_tokens: tokens,
        instagram_media: posts,
        instagram_send_lanes: lanes,
        ...untouched
      } = after;
      // The extension's profile is erased; its status is the channel account's (R6).
      expect(accounts).toEqual([
        expect.objectContaining({ username: null, profile_erased_at: expect.any(String) }),
      ]);
      // The channel account is revoked.
      expect(channelAccounts).toEqual([expect.objectContaining({ connection_status: 'revoked' })]);
      // The connection's last account went, so the connection is revoked with its token (CA8).
      expect(connections).toEqual([expect.objectContaining({ status: 'revoked' })]);
      expect(tokens).toEqual([]);
      expect(posts).toEqual([]);
      // The revoked account's sending lanes stop, as route 8's do (CA8; the R9 × R18 fix).
      expect(lanesBefore?.map((lane) => lane.state)).toEqual(['ready', 'ready', 'ready', 'ready']);
      expect(lanes?.map((lane) => lane.state)).toEqual([
        'stopped',
        'stopped',
        'stopped',
        'stopped',
      ]);
      expect(untouched).toEqual(before);
      expect(await readRunRow(waitingRun.id)).toMatchObject({ status: 'waiting' });

      // Meta repeats itself: nothing is left to do.
      expect((await requestMetaDataDeletion(team)).json()).toEqual(response.json());
      expect(await readAppRowsOfOrganization(team.organization.id)).toEqual(after);
    });
  });

  describe('an organization delete (AC-12.12)', () => {
    it('hides the data at once, and the purge removes every row of it and only of it', async () => {
      const teams: ConnectedInstagramTeam[] = [];
      for (const person of [JORDAN, MORGAN]) {
        const team = await connectInstagramTeam(app);
        mockInstagramConversation({
          instagramAppUserId: team.profile.id,
          people: [JORDAN, MORGAN],
        });
        const automations = await historyAutomations({ team });
        await writeHistory({ app, team, person, automations });
        await writeSendingHistory(team.organization.id);
        await writeSegmentHistory(team.organization.id);
        await writeBroadcastHistory(team.organization.id);
        teams.push(team);
      }
      const [team, otherTeam] = teams as [ConnectedInstagramTeam, ConnectedInstagramTeam];
      const counts = await countAppRowsOfOrganization(team.organization.id);
      // Every table of the schema that holds an organization's rows has some to lose — but Meta's
      // usage, which only answers carrying the usage headers write (the mocks send none).
      expect(Object.keys(counts).length).toBeGreaterThanOrEqual(10);
      expect(
        Object.entries(counts).filter(
          ([table, count]) => count === 0 && table !== 'channel_connection_usages',
        ),
      ).toEqual([]);
      const otherBefore = await readAppRowsOfOrganization(otherTeam.organization.id);
      const token = await generateTestToken({
        userId: team.owner.public_id,
        organizationPublicId: team.organization.public_id,
        stepUp: true,
      });
      mockInstagramUnsubscribe({ instagramUserId: team.profile.id });

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath('/tenancy/organization'),
        token,
      });

      expect(response.statusCode).toBe(204);
      // The account's token and stored posts go at once, its profile is emptied (D54).
      const { instagram_accounts: accounts } = await readAppRowsOfOrganization(
        team.organization.id,
      );
      expect(accounts).toEqual([
        expect.objectContaining({ username: null, profile_erased_at: expect.any(String) }),
      ]);
      const { channel_accounts: channelAccounts } = await readAppRowsOfOrganization(
        team.organization.id,
      );
      expect(channelAccounts).toEqual([expect.objectContaining({ connection_status: 'revoked' })]);
      const list = await injectAuthenticated(app, { url: CONTACTS_PATH, token });
      expect(list.statusCode).toBeGreaterThanOrEqual(400);
      expect(list.body).not.toContain(JORDAN.email);

      const purge = () =>
        withMaintenanceDatabaseContext({
          scope: MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
          callback: (databaseHandle) => runOrganizationTombstoneRetentionJob(databaseHandle),
        });
      // Inside the tombstone window the other rows wait.
      expect(await purge()).toMatchObject({ deletedCount: 0 });
      expect(await countAppRowsOfOrganization(team.organization.id)).toEqual({
        ...counts,
        channel_connection_tokens: 0,
        instagram_media: 0,
      });
      const pastTheWindow = daysBefore({
        from: new Date(),
        days: getEnv().TOMBSTONE_RETENTION_DAYS + 1,
      });
      await operatorQuery`
        UPDATE tenancy.organizations SET deleted_at = ${pastTheWindow}
        WHERE id = ${team.organization.id}`;

      expect(await purge()).toEqual({ deletedCount: 1, blockedCount: 0 });

      const left = Object.values(await countAppRowsOfOrganization(team.organization.id));
      expect(left.every((count) => count === 0)).toBe(true);
      expect(await readAppRowsOfOrganization(otherTeam.organization.id)).toEqual(otherBefore);
    });
  });

  describe('log lines (AC-12.13)', () => {
    /** The worker's paths: every trigger, a public reply, the answers, a refusal quoting the person. */
    async function writeThroughTheWorker(team: ConnectedInstagramTeam): Promise<PersonHistory> {
      const automations = await historyAutomations({
        team,
        price: { is_public_reply_enabled: true, public_reply_texts: ['Sent!'] },
      });
      const history = await writeHistory({ app, team, person: JORDAN, automations });
      await say({
        app,
        team,
        messaging: [
          directMessageItem({ person: JORDAN, text: 'my-private-answer, not an email' }),
          directMessageItem({ person: JORDAN, text: JORDAN.email }),
          directMessageItem({ person: MORGAN, text: 'catalog my-private-question' }),
          directMessageItem({
            person: MORGAN,
            text: 'my-private-story-answer',
            storyId: '17910000000000002',
          }),
        ],
      });
      return history;
    }

    /** The routes' paths: the list searched by the person's data, the events, two deletes. */
    async function readAndDeleteThroughTheRoutes({
      team,
      history,
    }: {
      team: ConnectedInstagramTeam;
      history: PersonHistory;
    }): Promise<void> {
      for (const search of [JORDAN.email, JORDAN.username, JORDAN.fullName]) {
        const found = await injectAuthenticated(app, {
          url: `${CONTACTS_PATH}?channel_account_id=${team.account.public_id}&q=${encodeURIComponent(search)}`,
          token: team.ownerToken,
        });
        expect((found.json() as { data: unknown[] }).data).toHaveLength(1);
      }
      expect((await listWebhookEvents(team)).statusCode).toBe(200);
      // A database failure whose statement binds the person's data, then the delete itself.
      vi.spyOn(ContactRepository.prototype, 'erase').mockRejectedValueOnce(
        new DrizzleQueryError(
          'update "app"."contacts" set "deleted_at" = now() where "email" = $1',
          [...personalValuesOf(JORDAN), ...history.texts],
          new Error('connection terminated'),
        ),
      );
      const contactPublicId = history.contact.public_id;
      const failed = await deleteContactAsOwner({ app, team, contactPublicId });
      expect(failed.statusCode).toBeGreaterThanOrEqual(500);
      const deleted = await deleteContactAsOwner({ app, team, contactPublicId });
      expect(deleted.statusCode).toBe(204);
    }

    async function runEveryTimer(now: Date): Promise<void> {
      await runWaitCheck(now);
      await runAppPartitionUpkeepJob({ mode: 'drop' });
      await runAutomationTombstoneRetentionJob({ now });
    }

    it('carry no email, phone, name, username, picture or message text on any of these paths, failures included', async () => {
      const captured = captureLogLines(app);
      try {
        const team = await connectInstagramTeam(app);
        // Instagram refuses Morgan's messages, quoting the person in its error.
        mockInstagramConversation({
          instagramAppUserId: team.profile.id,
          people: [JORDAN, MORGAN],
          onSend: async ({ body }) =>
            JSON.stringify(body).includes(MORGAN.instagramUserId)
              ? [
                  400,
                  {
                    error: {
                      code: 10,
                      error_subcode: 2534022,
                      message: `Cannot message ${MORGAN.username}`,
                    },
                  },
                ]
              : undefined,
        });
        const history = await writeThroughTheWorker(team);
        const [commentLog] = await readCommentLogRows(team.organization.id);
        const rowProbe = {
          contact: await readContactRow(history.contact.id),
          run: history.runningRun,
          commentLog,
        };
        await readAndDeleteThroughTheRoutes({ team, history });
        await runEveryTimer(daysFromNow(200));
        // A database failure in the worker: a username no column holds, the comment's text bound.
        await deliverInstagramEvents({
          app,
          team,
          changes: [
            commentChange({
              person: { ...JORDAN, username: JORDAN.username.padEnd(80, 'x') },
              text: 'price my-private-failing-comment',
            }),
          ],
        });
        await expect(processInstagramEvents({ app, team })).rejects.toThrow();
        await requestMetaDataDeletion(team);

        const written = captured.lines.join('\n');
        for (const message of [
          'instagram.webhook.delivery_received',
          'app.instagram_webhook.event_processed',
          'app.instagram_webhook.event_retry_scheduled',
          'app.automation_run.comment_matched',
          'app-partition-upkeep.completed',
          'automation-tombstone-retention.completed',
          'request.complete',
        ]) {
          expect(written).toContain(message);
        }
        const personalValues = [
          ...personalValuesOf(JORDAN),
          ...personalValuesOf(MORGAN),
          ...history.texts,
          'my-private',
        ];
        for (const value of personalValues) {
          expect(written).not.toContain(value);
          expect(written).not.toContain(encodeURIComponent(value));
        }

        // Were a whole row ever logged, its personal keys would still be hidden (CT12, AU26).
        const lineCount = captured.lines.length;
        logger.info(rowProbe, 'retention-erasure.row_probe');
        const probe = captured.lines.slice(lineCount).join('\n');
        for (const key of [
          'email',
          'phone',
          'username',
          'full_name',
          'profile_picture_url',
          'comment_text',
          'commenter_username',
        ]) {
          expect(probe).toContain(`"${key}":"${SENSITIVE_REDACTION_PLACEHOLDER}"`);
        }
        for (const value of personalValues) expect(probe).not.toContain(value);
      } finally {
        captured.restore();
      }
    });
  });
});
