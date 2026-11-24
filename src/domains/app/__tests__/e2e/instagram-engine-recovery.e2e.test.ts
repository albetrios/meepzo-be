import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import { INSTAGRAM_WEBHOOK_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import { readStagedAuditRows } from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  nextInstagramObjectId,
  readCommentLogRows,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  type DeliveredEvent,
  FOLLOW_REQUEST_MESSAGE,
  closeMessagingWindow,
  commentAutomation,
  commentEvent,
  deleteAutomation,
  editAutomation,
  useUpAttemptsOfLatestEvent,
} from './instagram-engine-recovery.helper.js';
import {
  InstagramMessageFlow,
  directMessageAutomation,
  storyReplyAutomation,
  throttledSend,
} from './instagram-message-flow.helper.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The run engine after things went wrong or changed under it, end to end (D47, D48, D50, D51 —
 * routes-final § 3.B rev 2 AU12, AU14, AU19; § 4 rev 4 WH14): an event that ends `failed`, or is
 * skipped on a retry, fails the runs it left running; a run waiting for a step the team has since
 * turned off (route 14) goes on at the contact's next event inside the messaging window, the
 * automations queued behind its email with it; an automation deleted (route 15) while its message is
 * on its way leaves no open run. The account, its settings and the automations are
 * made over the real routes, Meta's events delivered signed to route 17 and worked through by the
 * real processing job and engine, with the fake Instagram client of the message flow.
 */
describe('Instagram run engine — failed events, steps turned off, deletes (e2e)', () => {
  let app: FastifyInstance;
  let flow: InstagramMessageFlow;
  /** The queue route 17 adds the processing jobs to — emptied at the end, never worked here. */
  let processingQueue: Queue;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    await initializeI18nextForBackgroundWork();
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
    flow = await InstagramMessageFlow.start(app);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    nock.cleanAll();
    await metaGraphCircuit.reset();
  });

  const sentTexts = () => flow.instagram.sentMessages.map((message) => message.text);

  describe('an event that ends failed (AU19, WH14, D47)', () => {
    it('five attempts dead from an error that is not Instagram’s: the event and the run it started are failed', async () => {
      const automation = await flow.createAutomation(directMessageAutomation());
      const other = await flow.createAutomation(
        directMessageAutomation({ name: 'Price list', keywords: ['price'] }),
      );
      const databaseGone = vi
        .spyOn(app.appDomain.contactService, 'findLiveContact')
        .mockRejectedValue(new Error('connection terminated unexpectedly'));
      await flow.deliver(flow.directMessage({ text: 'catalog please' }));
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await expect(flow.runJob()).rejects.toThrow('connection terminated');
        expect(await flow.latestEvent()).toMatchObject({
          status: 'queued',
          attempt_count: attempt,
        });
        expect((await flow.runOf(automation)).status).toBe('running');
      }

      expect(await flow.runJob()).toMatchObject({ failedEventCount: 1, processedEventCount: 0 });

      expect(await flow.latestEvent()).toMatchObject({
        status: 'failed',
        attempt_count: 5,
        error_message: 'processing_error:Error',
      });
      const run = await flow.runOf(automation);
      expect(run).toMatchObject({
        status: 'failed',
        error_message: 'code:processing_error:Error',
        sending_message_kind: null,
      });
      expect(await flow.trailOf(run)).toEqual(['status_changed:running', 'status_changed:failed']);
      expect(flow.instagram.sentMessages).toEqual([]);

      // The contact is not stuck behind it: its next events are handled as ever (AU17).
      databaseGone.mockRestore();
      expect(await flow.receive(flow.directMessage({ text: 'catalog again' }))).toEqual([]);
      await flow.receive(flow.directMessage({ text: 'price' }));
      expect((await flow.runOf(automation)).status).toBe('failed');
      expect((await flow.runOf(other)).status).toBe('completed');
    });

    it('crashes that used up every attempt: the next job fails the event, its run and its comment log', async () => {
      const automation = await flow.createAutomation(commentAutomation());
      flow.instagram.sendFailures.push(throttledSend());
      await flow.deliver(commentEvent({ text: 'guide please' }));
      await expect(flow.runJob()).rejects.toThrow();
      expect((await flow.runOf(automation)).status).toBe('running');
      await useUpAttemptsOfLatestEvent(flow);

      expect(await flow.runJob()).toMatchObject({ failedEventCount: 1, processedEventCount: 0 });

      expect(await flow.latestEvent()).toMatchObject({
        status: 'failed',
        error_message: 'processing_attempts_exhausted',
      });
      expect(await flow.runOf(automation)).toMatchObject({
        status: 'failed',
        error_message: 'code:processing_attempts_exhausted',
      });
      expect(await readCommentLogRows(flow.team.organization.id)).toEqual([
        expect.objectContaining({
          overall_status: 'failed',
          failed_step: 'final_dm',
          error_type: 'code',
          error_message: 'code:processing_attempts_exhausted',
          error_at: expect.any(Date),
        }),
      ]);
    });
  });

  describe('an event skipped on a retry (WH12, D51)', () => {
    it.each([
      ['automation_disabled', () => flow.saveSettings({ is_automation_enabled: false })],
      ['account_disconnected', () => flow.disconnect()],
    ] as const)(
      '%s between two tries: the run the first one started is failed, its comment log too',
      async (skipReason, change) => {
        const automation = await flow.createAutomation(commentAutomation());
        flow.instagram.sendFailures.push(throttledSend());
        await flow.deliver(commentEvent({ text: 'guide please' }));
        await expect(flow.runJob()).rejects.toThrow();
        expect((await flow.runOf(automation)).status).toBe('running');
        await change();

        expect(await flow.runJob()).toMatchObject({ skippedEventCount: 1, failedEventCount: 0 });

        expect(await flow.latestEvent()).toMatchObject({ status: 'skipped', error_message: null });
        const run = await flow.runOf(automation);
        expect(run).toMatchObject({ status: 'failed', error_message: `code:${skipReason}` });
        expect(await flow.trailOf(run)).toEqual([
          'status_changed:running',
          'status_changed:failed',
        ]);
        expect(await readCommentLogRows(flow.team.organization.id)).toEqual([
          expect.objectContaining({
            overall_status: 'failed',
            error_type: 'code',
            error_message: `code:${skipReason}`,
          }),
        ]);
        expect(flow.instagram.sentMessages).toEqual([]);
      },
    );

    it('skipped on its first try: no run, nothing failed', async () => {
      await flow.createAutomation(commentAutomation());
      await flow.deliver(commentEvent({ text: 'guide please' }));
      await flow.saveSettings({ is_automation_enabled: false });

      expect(await flow.runJob()).toMatchObject({ skippedEventCount: 1, failedEventCount: 0 });

      expect(await flow.latestEvent()).toMatchObject({ status: 'skipped', attempt_count: 1 });
      expect(await flow.runs()).toEqual([]);
      expect(await flow.commentLogCount()).toBe(0);
    });
  });

  describe('a step turned off while a run waits for it (AU14, D48)', () => {
    /**
     * A run of the DM automation waiting for the email, the story automation queued behind it; then
     * the email step turned off (route 14) — nothing is sent at that moment.
     */
    async function waitForEmailThenTurnItOff(): Promise<{ automation: string; queued: string }> {
      const automation = await flow.createAutomation(
        directMessageAutomation({ is_email_collection_enabled: true, tags: ['catalog'] }),
      );
      const queued = await flow.createAutomation(
        storyReplyAutomation({ keywords: ['vip'], is_phone_collection_enabled: true }),
      );
      await flow.receive(flow.directMessage({ text: 'catalog' }));
      await flow.receive(flow.storyReply({ storyId: nextInstagramObjectId(), text: 'vip please' }));
      const waiting = await flow.runOf(automation);
      expect(waiting).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
        queued_automations: [expect.objectContaining({ automation_id: queued })],
      });
      const sentBefore = flow.instagram.sentMessages.length;
      await editAutomation({
        app,
        flow,
        automationPublicId: automation,
        changes: { is_email_collection_enabled: false },
      });
      expect(flow.instagram.sentMessages).toHaveLength(sentBefore);
      expect(await flow.runOf(automation)).toEqual(waiting);
      return { automation, queued };
    }

    it.each<[string, (automation: string) => Promise<DeliveredEvent>]>([
      ['a comment', async () => commentEvent({ text: 'lovely post' })],
      ['a DM', async () => flow.directMessage({ text: 'hello?' })],
      [
        'a story reply',
        async () => flow.storyReply({ storyId: nextInstagramObjectId(), text: 'lovely story' }),
      ],
      [
        'a button click',
        // A click naming the waiting run itself, which waits for no button.
        async (automation) =>
          flow.buttonClick({
            payload: `${automation}::${(await flow.runOf(automation)).public_id}`,
          }),
      ],
    ])(
      'the run goes on at %s, and the automation queued behind its email starts with its own settings',
      async (_case, nextEvent) => {
        const { automation, queued } = await waitForEmailThenTurnItOff();

        const sent = await flow.receive(await nextEvent(automation));

        expect(sent.map((message) => message.text)).toEqual([
          'Here is the catalog',
          expect.any(String),
        ]);
        expect(sent[1]?.quickReplyTypes).toEqual(['user_phone_number']);
        const run = await flow.runOf(automation);
        expect(run).toMatchObject({ status: 'completed', queued_automations: [] });
        expect(await flow.trailOf(run)).toEqual([
          'status_changed:running',
          'status_changed:waiting',
          'status_changed:running',
          'status_changed:completed',
        ]);
        expect(await flow.runOf(queued)).toMatchObject({
          trigger_type: 'story_reply',
          trigger_text: 'vip please',
          status: 'waiting',
          waiting_for: 'phone',
        });
        expect(await flow.contact()).toMatchObject({ email: null, tags: ['catalog'] });
      },
    );

    it('a DM that looks like an email is not taken as the answer; it starts the automation it names', async () => {
      const { automation } = await waitForEmailThenTurnItOff();
      const named = await flow.createAutomation(
        directMessageAutomation({
          name: 'By address',
          keywords: ['jordan@example.com'],
          final_message: { text: 'You wrote an address', links: [] },
        }),
      );

      await flow.receive(flow.directMessage({ text: 'jordan@example.com' }));

      expect((await flow.runOf(named)).status).toBe('completed');
      expect((await flow.runOf(automation)).status).toBe('completed');
      expect((await flow.contact()).email).toBeNull();
      expect(sentTexts()).toContain('You wrote an address');
    });

    it.each([
      {
        waitingFor: 'phone',
        stepOn: { is_phone_collection_enabled: true },
        stepOff: { is_phone_collection_enabled: false },
      },
      {
        waitingFor: 'follow',
        stepOn: { is_follow_required: true, follow_request_message: FOLLOW_REQUEST_MESSAGE },
        stepOff: { is_follow_required: false },
      },
    ])(
      'the same for the $waitingFor step: skipped, and the run goes on to its final message',
      async ({ waitingFor, stepOn, stepOff }) => {
        const automation = await flow.createAutomation(directMessageAutomation(stepOn));
        flow.instagram.followAnswers.push(false);
        await flow.receive(flow.directMessage({ text: 'catalog' }));
        expect(await flow.runOf(automation)).toMatchObject({ waiting_for: waitingFor });
        await editAutomation({ app, flow, automationPublicId: automation, changes: stepOff });

        const sent = await flow.receive(flow.directMessage({ text: 'hello?' }));

        expect(sent.map((message) => message.text)).toEqual(['Here is the catalog']);
        expect((await flow.runOf(automation)).status).toBe('completed');
        expect(await flow.contact()).toMatchObject({ phone: null });
      },
    );

    it('a comment outside the messaging window moves nothing on: Instagram takes one private reply per comment (D50)', async () => {
      const automation = await flow.createAutomation(
        commentAutomation({ is_email_collection_enabled: true }),
      );
      const commentId = nextInstagramObjectId();
      await flow.receive(commentEvent({ text: 'guide', commentId }));
      expect(flow.instagram.sentMessages[0]?.recipient).toEqual({ comment_id: commentId });
      await editAutomation({
        app,
        flow,
        automationPublicId: automation,
        changes: { is_email_collection_enabled: false },
      });

      expect(await flow.receive(commentEvent({ text: 'guide, please' }))).toEqual([]);
      expect(await flow.runOf(automation)).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
      });

      // The DM opens the window: the final message goes as a normal DM.
      const [finalMessage] = await flow.receive(flow.directMessage({ text: 'hello?' }));
      expect(finalMessage).toMatchObject({
        text: 'Here is the guide',
        recipient: { id: expect.any(String) },
      });
      expect((await flow.runOf(automation)).status).toBe('completed');
      expect(await readCommentLogRows(flow.team.organization.id)).toEqual([
        expect.objectContaining({ overall_status: 'completed', email_status: 'skipped' }),
        expect.objectContaining({ overall_status: 'ignored', ignored_reason: 'already_waiting' }),
      ]);
    });

    it('a window that closed meanwhile holds it too, until the next DM', async () => {
      const { automation } = await waitForEmailThenTurnItOff();
      await closeMessagingWindow(flow);

      expect(await flow.receive(commentEvent({ text: 'lovely post' }))).toEqual([]);
      expect(await flow.runOf(automation)).toMatchObject({ status: 'waiting' });

      await flow.receive(flow.directMessage({ text: 'hello?' }));
      expect(await flow.runOf(automation)).toMatchObject({ status: 'completed' });
    });

    it('a deleted automation’s run stays cancelled: the step it had does not matter (AU12)', async () => {
      const { automation } = await waitForEmailThenTurnItOff();
      expect(
        (await deleteAutomation({ app, flow, automationPublicId: automation })).statusCode,
      ).toBe(204);

      expect(await flow.receive(flow.directMessage({ text: 'hello?' }))).toEqual([]);

      expect(await flow.runOf(automation)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'automation_deleted',
      });
    });
  });

  describe('an automation deleted while its message is on its way (AU12, D47)', () => {
    it('answers 204, cancels the run, counts it once, and nothing more is sent or counted', async () => {
      const automation = await flow.createAutomation(
        directMessageAutomation({ is_email_collection_enabled: true }),
      );
      const send = flow.instagram.engineClient.sendInstagramMessage;
      let deleteStatus: number | undefined;
      flow.instagram.engineClient.sendInstagramMessage = async (input) => {
        flow.instagram.engineClient.sendInstagramMessage = send;
        deleteStatus = (await deleteAutomation({ app, flow, automationPublicId: automation }))
          .statusCode;
        return send(input);
      };

      await flow.receive(flow.directMessage({ text: 'catalog' }));

      expect(deleteStatus).toBe(204);
      const run = await flow.runOf(automation);
      expect(run).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'automation_deleted',
        waiting_for: null,
        sending_message_kind: null,
      });
      expect(await flow.trailOf(run)).toEqual([
        'status_changed:running',
        'status_changed:cancelled',
      ]);
      expect(
        await readStagedAuditRows({
          organizationPublicId: flow.team.organization.public_id,
          action: 'app.automation.delete',
        }),
      ).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({ cancelled_run_count: 1 }),
        }),
      ]);
      // The answer to the question that went finds no run to move (D18).
      expect(await flow.receive(flow.directMessage({ text: 'jordan@example.com' }))).toEqual([]);
      expect((await flow.contact()).email).toBeNull();
    });
  });
});
