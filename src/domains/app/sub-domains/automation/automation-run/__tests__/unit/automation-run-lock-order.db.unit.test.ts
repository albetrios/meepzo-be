import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { runOrganizationScopedWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { InstagramAutomationAccountAccess } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import type { ContactErasureStep } from '@/domains/app/sub-domains/contact/contact.types.js';
import { AutomationRepository } from '@/domains/app/sub-domains/automation/automation.repository.js';
import { AutomationService } from '@/domains/app/sub-domains/automation/automation.service.js';
import type {
  AutomationDeleteResult,
  AutomationOpenRunCancelStep,
} from '@/domains/app/sub-domains/automation/automation.types.js';
import { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import {
  type AutomationInstagramClient,
  AutomationRunMessageService,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run-message.service.js';
import { AutomationPublicReplySafetyService } from '@/domains/app/sub-domains/automation/automation-run/automation-public-reply-safety.service.js';
import type { AutomationRunHandlingResult } from '@/domains/app/sub-domains/automation/automation-run/automation-run.types.js';
import {
  type ContactFixtureRow,
  insertContact,
  insertInstagramAccount,
  readContactRow,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  type AutomationFixtureRow,
  insertAutomation,
  readAutomationRow,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  type AutomationRunFixtureRow,
  insertAutomationCommentLog,
  insertAutomationRun,
  nextInstagramObjectId,
  readCommentLogRows,
  readRunEventTrail,
  readRunRow,
  readRunRows,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import {
  operatorQuery,
  withOperatorTransaction,
  type OperatorQuery,
} from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The one lock order of the automation delete (route 15), the contact erase (route 10) and the run
 * engine (routes-final § 3.B rev 2 AU12, D47): the contact, then the automation, then its runs. Each
 * test runs the two on two database connections and holds one of them at an exact point — a promise
 * the code under test waits for, or a table lock of a third connection — until the other waits for
 * a lock, so the order never rests on a sleep. Before the fix each of them ended in Postgres's
 * `deadlock detected`, or left an open run on a deleted automation.
 */

/** A point the code under test reaches (`open`) and the test waits for (`opened`), or the reverse. */
function createGate(): { open: () => void; opened: Promise<void> } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** Resolves once `count` connections of this database wait for a lock another one holds. */
async function waitForBlockedConnections(count: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const [row] = await operatorQuery<Array<{ blocked: number }>>`
      SELECT count(*)::int AS blocked
      FROM pg_stat_activity
      WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
    if ((row?.blocked ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error(`no ${count} connections wait for a lock`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('the lock order of the delete, the erase and the run engine (database, two connections)', () => {
  let organization: { id: number; public_id: string; type: string };
  let account: { id: number; public_id: string };
  let contact: ContactFixtureRow;
  let sendInstagramMessage: ReturnType<
    typeof vi.fn<AutomationInstagramClient['sendInstagramMessage']>
  >;
  let cancelSteps: AutomationOpenRunCancelStep[];
  let erasureSteps: ContactErasureStep[];
  let contactService: ContactService;
  let automationService: AutomationService;
  let engine: AutomationRunService;

  beforeAll(async () => {
    await initializeI18nextForBackgroundWork();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      username: 'jordan.lee',
      // Inside the messaging window, so every message is a normal DM (3.B.10).
      last_direct_message_received_at: new Date(),
    });
    const organizationService = {
      requireOrganizationByPublicId: async () => organization,
      resolveUserInternalIdByPublicId: async () => null,
    } as unknown as OrganizationService;
    const access: InstagramAutomationAccountAccess = {
      instagramAccount: { organizationId: organization.id, instagramAccountId: account.id },
      instagramAccountPublicId: account.public_id,
      instagramUserId: '17841400000000999',
      username: 'acme.shop',
      connectionStatus: 'connected',
      encryptedAccessToken: 'v1:fake-ciphertext',
      settings: null,
    };
    const accountService = {
      findAutomationAccountAccess: async () => access,
      markConnectionBroken: async () => null,
    } as unknown as InstagramAccountService;
    erasureSteps = [];
    contactService = new ContactService(
      new ContactRepository(),
      organizationService,
      erasureSteps,
      async () => null,
    );
    sendInstagramMessage = vi.fn(async () => ({ messageId: 'm_sent', recipientId: null }));
    engine = new AutomationRunService(
      accountService,
      contactService,
      new AutomationRunMessageService(
        {
          sendInstagramMessage,
          replyToInstagramComment: async () => ({ instagramCommentReplyId: '1' }),
          readInstagramUserProfile: async () => ({
            name: null,
            username: null,
            profilePictureUrl: null,
            followerCount: null,
            isUserFollowingBusiness: null,
          }),
        },
        async () => {},
        () => 0,
      ),
      new AutomationPublicReplySafetyService(() => 0),
    );
    cancelSteps = [(input) => engine.cancelAutomationOpenRuns(input)];
    erasureSteps.push((input) => engine.eraseContactRunCopies(input));
    automationService = new AutomationService(
      new AutomationRepository(),
      accountService,
      organizationService,
      cancelSteps,
    );
  });

  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id });

  /** A live automation on `keyword` whose flow is the final message only. */
  function liveAutomation(
    overrides: Partial<
      Omit<AutomationFixtureRow, 'id' | 'organization_id' | 'instagram_account_id'>
    > = {},
  ): Promise<AutomationFixtureRow> {
    return insertAutomation({
      organizationId: organization.id,
      instagramAccountId: account.id,
      status: 'live',
      trigger_type: 'dm',
      keywords: ['catalog'],
      is_opening_message_enabled: false,
      opening_message: null,
      ...overrides,
    });
  }

  function triggerOf(eventKey: string) {
    return {
      scope: scope(),
      instagramAccountPublicId: account.public_id,
      contact,
      event: { eventKey, occurredAt: new Date(), isLastAttempt: false },
    };
  }

  function directMessage(text: string): Promise<AutomationRunHandlingResult> {
    return engine.handleDirectMessage({
      ...triggerOf(`message:m_${nextInstagramObjectId()}`),
      text,
      quickReplyPayload: null,
      attachmentEmail: null,
    });
  }

  function comment(text: string): Promise<AutomationRunHandlingResult> {
    const commentId = nextInstagramObjectId();
    return engine.startCommentRun({
      ...triggerOf(`comment:${commentId}`),
      instagramCommentId: commentId,
      instagramMediaId: nextInstagramObjectId(),
      text,
      commenterUsername: 'jordan.lee',
    });
  }

  function storyReply(text: string): Promise<AutomationRunHandlingResult> {
    return engine.startStoryReplyRun({
      ...triggerOf(`message:m_${nextInstagramObjectId()}`),
      instagramStoryId: nextInstagramObjectId(),
      text,
    });
  }

  function deleteAutomation(automation: AutomationFixtureRow): Promise<AutomationDeleteResult> {
    return automationService.deleteAutomation({
      scope: scope(),
      automationPublicId: automation.public_id,
      removal: { reason: 'not_needed', note: null },
      deletedByUserPublicId: undefined,
    });
  }

  function eraseContact(): Promise<{ contactPublicId: string }> {
    return contactService.deleteContact({
      scope: scope(),
      contactPublicId: contact.public_id,
    });
  }

  /** The delete stops right after it locked and soft-deleted the automation, its runs not cancelled yet. */
  function holdDeleteBeforeItsCancel() {
    const reached = createGate();
    const goOn = createGate();
    cancelSteps.unshift(async () => {
      reached.open();
      await goOn.opened;
      return 0;
    });
    return { reached: reached.opened, goOn: goOn.open };
  }

  /** The delete stops right before it commits, its open runs already cancelled. */
  function holdDeleteBeforeItsCommit() {
    const reached = createGate();
    const goOn = createGate();
    cancelSteps.push(async () => {
      reached.open();
      await goOn.opened;
      return 0;
    });
    return { reached: reached.opened, goOn: goOn.open };
  }

  /** Every run-event insert waits (its transaction holding what it locked so far) until released. */
  async function holdRunEventInserts(work: () => Promise<void>): Promise<void> {
    await withOperatorTransaction(async (transaction: OperatorQuery) => {
      await transaction`LOCK TABLE app.automation_run_events IN SHARE MODE`;
      await work();
    });
  }

  async function expectNoOpenRunOf(automation: AutomationFixtureRow): Promise<void> {
    const runs = await readRunRows(organization.id);
    expect(
      runs.filter(
        (run) =>
          run.automation_id === automation.id &&
          (run.status === 'running' || run.status === 'waiting'),
      ),
    ).toEqual([]);
  }

  async function onlyRun(): Promise<AutomationRunFixtureRow> {
    const runs = await readRunRows(organization.id);
    expect(runs).toHaveLength(1);
    return runs[0] as AutomationRunFixtureRow;
  }

  describe('a delete and the unit that completes a run of that automation', () => {
    it('the unit first: the delete waits, then finds the run completed and cancels none', async () => {
      const automation = await liveAutomation();
      const unitHoldsRun = createGate();
      const goOn = createGate();
      const recordMessageSent = contactService.recordContactMessageSent.bind(contactService);
      // The record unit has locked the run; the completion and the count come next.
      vi.spyOn(contactService, 'recordContactMessageSent').mockImplementationOnce(async (input) => {
        unitHoldsRun.open();
        await goOn.opened;
        return recordMessageSent(input);
      });

      const handled = directMessage('catalog');
      await unitHoldsRun.opened;
      const deleted = deleteAutomation(automation);
      await waitForBlockedConnections(1);
      goOn.open();

      expect(await Promise.all([handled, deleted])).toMatchObject([
        { outcome: 'run_started', failedErrorType: null },
        { cancelledRunCount: 0 },
      ]);
      const run = await onlyRun();
      expect(run).toMatchObject({ status: 'completed', cancel_reason: null });
      expect(await readRunEventTrail(run.id)).toEqual([
        'status_changed:running',
        'status_changed:completed',
      ]);
      expect(await readAutomationRow(automation.public_id)).toMatchObject({
        completed_run_count: 1,
        deleted_at: expect.any(Date),
      });
    });

    it('the delete first: the unit waits, then finds the run cancelled and completes nothing', async () => {
      const automation = await liveAutomation();
      const held = holdDeleteBeforeItsCancel();
      let deleted: Promise<AutomationDeleteResult> | undefined;
      // The delete takes its lock while the message is on its way.
      sendInstagramMessage.mockImplementationOnce(async () => {
        deleted = deleteAutomation(automation);
        await held.reached;
        return { messageId: 'm_sent', recipientId: null };
      });

      const handled = directMessage('catalog');
      await held.reached;
      await waitForBlockedConnections(1);
      held.goOn();

      expect(await handled).toMatchObject({ outcome: 'run_started', failedErrorType: null });
      expect(await deleted).toMatchObject({ cancelledRunCount: 1 });
      const run = await onlyRun();
      expect(run).toMatchObject({ status: 'cancelled', cancel_reason: 'automation_deleted' });
      expect(await readRunEventTrail(run.id)).toEqual([
        'status_changed:running',
        'status_changed:cancelled',
      ]);
      expect(await readAutomationRow(automation.public_id)).toMatchObject({
        completed_run_count: 0,
        deleted_at: expect.any(Date),
      });
    });
  });

  describe('a delete and the unit that starts a run of that automation', () => {
    it.each([
      ['a comment', 'comment', () => comment('catalog')],
      ['a DM', 'dm', () => directMessage('catalog')],
      ['a story reply', 'story_reply', () => storyReply('catalog')],
    ] as const)(
      '%s that meets the delete starts nothing: ignored, no run, no comment log',
      async (_case, triggerType, trigger) => {
        const automation = await liveAutomation({ trigger_type: triggerType });
        const held = holdDeleteBeforeItsCommit();
        const deleted = deleteAutomation(automation);
        await held.reached;

        // The automation still reads live: the delete has not committed.
        const handled = trigger();
        await waitForBlockedConnections(1);
        held.goOn();

        expect(await deleted).toMatchObject({ cancelledRunCount: 0 });
        expect(await handled).toEqual({
          outcome: 'ignored',
          runPublicIds: [],
          failedErrorType: null,
        });
        expect(await readRunRows(organization.id)).toEqual([]);
        expect(await readCommentLogRows(organization.id)).toEqual([]);
        expect(sendInstagramMessage).not.toHaveBeenCalled();
        expect((await readAutomationRow(automation.public_id))?.last_triggered_at).toBeNull();
      },
    );

    it('a queued automation deleted while the email arrives is skipped; the answered run goes on', async () => {
      const emailFirst = await liveAutomation({
        keywords: ['price'],
        is_email_collection_enabled: true,
      });
      const queued = await liveAutomation();
      const waiting = await insertAutomationRun({
        organizationId: organization.id,
        automationId: emailFirst.id,
        contactId: contact.id,
        queued_automations: [
          {
            automation_id: queued.public_id,
            queued_at: new Date().toISOString(),
            trigger: { type: 'dm', text: 'catalog' },
          },
        ],
      });
      const held = holdDeleteBeforeItsCommit();
      const deleted = deleteAutomation(queued);
      await held.reached;

      const handled = directMessage('jordan@example.com');
      await waitForBlockedConnections(1);
      held.goOn();

      expect(await deleted).toMatchObject({ cancelledRunCount: 0 });
      expect(await handled).toMatchObject({
        outcome: 'run_continued',
        runPublicIds: [waiting.public_id],
      });
      expect(await onlyRun()).toMatchObject({ status: 'completed', queued_automations: [] });
      await expectNoOpenRunOf(queued);
    });

    it('a run that started first is found by the delete: no open run stays on the deleted automation', async () => {
      const automation = await liveAutomation();
      let handled: Promise<AutomationRunHandlingResult> | undefined;
      let deleted: Promise<AutomationDeleteResult> | undefined;
      await holdRunEventInserts(async () => {
        handled = directMessage('catalog');
        // The unit inserted the run and waits with it; the delete then waits for the unit.
        await waitForBlockedConnections(1);
        deleted = deleteAutomation(automation);
        await waitForBlockedConnections(2);
      });

      expect(await handled).toMatchObject({ outcome: 'run_started', failedErrorType: null });
      const run = await onlyRun();
      expect(['completed', 'cancelled']).toContain(run.status);
      expect(await deleted).toMatchObject({
        cancelledRunCount: run.status === 'cancelled' ? 1 : 0,
      });
      await expectNoOpenRunOf(automation);
      expect((await readAutomationRow(automation.public_id))?.completed_run_count).toBe(
        run.status === 'completed' ? 1 : 0,
      );
    });
  });

  describe('a delete and the erase of a contact with a run of that automation', () => {
    let automation: AutomationFixtureRow;
    let run: AutomationRunFixtureRow;

    beforeEach(async () => {
      automation = await liveAutomation({ trigger_type: 'comment' });
      run = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
      });
      await insertAutomationCommentLog({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
        automation_run_id: run.id,
        overall_status: 'waiting',
        waiting_for: 'email',
      });
    });

    /** Both done: every copy cleared, the automation gone, the run cancelled once. */
    async function expectErasedAndDeleted(
      cancelReason: 'contact_deleted' | 'automation_deleted',
    ): Promise<void> {
      expect(await readRunRow(run.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: cancelReason,
        trigger_text: null,
      });
      expect(await readRunEventTrail(run.id)).toEqual(['status_changed:cancelled']);
      expect(await readCommentLogRows(organization.id)).toEqual([
        expect.objectContaining({ overall_status: 'cancelled', comment_text: null }),
      ]);
      expect(await readContactRow(contact.id)).toMatchObject({
        username: null,
        deleted_at: expect.any(Date),
      });
      expect((await readAutomationRow(automation.public_id))?.deleted_at).not.toBeNull();
    }

    it('the erase first: the delete waits, then finds the run cancelled and cancels none', async () => {
      let erased: Promise<unknown> | undefined;
      let deleted: Promise<AutomationDeleteResult> | undefined;
      await holdRunEventInserts(async () => {
        // The erase has cancelled the run and waits; its other writes to the run come next.
        erased = eraseContact();
        await waitForBlockedConnections(1);
        deleted = deleteAutomation(automation);
        await waitForBlockedConnections(2);
      });

      await expect(erased).resolves.toMatchObject({ contactPublicId: contact.public_id });
      expect(await deleted).toMatchObject({ cancelledRunCount: 0 });
      await expectErasedAndDeleted('contact_deleted');
    });

    it('the delete first: the erase waits, then clears the copies of the run it cancelled', async () => {
      const held = holdDeleteBeforeItsCancel();
      const deleted = deleteAutomation(automation);
      await held.reached;
      const erased = eraseContact();
      await waitForBlockedConnections(1);
      held.goOn();

      expect(await deleted).toMatchObject({ cancelledRunCount: 1 });
      await expect(erased).resolves.toMatchObject({ contactPublicId: contact.public_id });
      await expectErasedAndDeleted('automation_deleted');
    });
  });

  it('a run starts only on a live automation of its organization: deleted, turned off or another’s is none', async () => {
    const live = await liveAutomation();
    const refused = [
      await liveAutomation({ status: 'inactive' }),
      await liveAutomation({ deleted_at: new Date(), delete_reason: 'not_needed' }),
    ];
    const lockForStart = ({
      automationId,
      organizationId = organization.id,
    }: {
      automationId: number;
      organizationId?: number;
    }) =>
      withAppDatabaseContext({
        scope: scope(),
        callback: () =>
          new AutomationRepository().lockLiveForRunStart({ organizationId, automationId }),
      });

    expect(await lockForStart({ automationId: live.id })).toMatchObject({ id: live.id });
    for (const { id } of refused) expect(await lockForStart({ automationId: id })).toBeNull();
    expect(
      await lockForStart({ automationId: live.id, organizationId: organization.id + 1 }),
    ).toBeNull();
  });

  it('the 7-day wait cancel never waits for a run another transaction holds: it stays due', async () => {
    const automation = await liveAutomation();
    const otherContact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    const waitingSince = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const insertWaiting = (contactId: number) =>
      insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId,
        waiting_since_at: waitingSince,
      });
    const taken = await insertWaiting(contact.id);
    const free = await insertWaiting(otherContact.id);
    const cancelExpired = () =>
      runOrganizationScopedWorkerJob({
        job: { organizationPublicId: organization.public_id },
        processor: (databaseHandle) =>
          engine.cancelExpiredWaitingRuns({
            databaseHandle,
            organizationId: organization.id,
            runIds: [taken.id, free.id],
            waitingSinceBefore: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          }),
      });

    await withOperatorTransaction(async (transaction) => {
      await transaction`SELECT id FROM app.automation_runs WHERE id = ${taken.id} FOR UPDATE`;
      expect(await cancelExpired()).toBe(1);
    });
    expect((await readRunRow(taken.id))?.status).toBe('waiting');
    expect((await readRunRow(free.id))?.status).toBe('cancelled');

    expect(await cancelExpired()).toBe(1);
    expect((await readRunRow(taken.id))?.status).toBe('cancelled');
  });
});
