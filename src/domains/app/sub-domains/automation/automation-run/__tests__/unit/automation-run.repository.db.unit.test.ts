import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import { AutomationRunRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-run.repository.js';
import { AutomationCommentLogRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.repository.js';
import { AutomationRunMessageService } from '@/domains/app/sub-domains/automation/automation-run/automation-run-message.service.js';
import { AutomationPublicReplySafetyService } from '@/domains/app/sub-domains/automation/automation-run/automation-public-reply-safety.service.js';
import {
  type ContactFixtureRow,
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  type AutomationFixtureRow,
  insertAutomation,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationCommentLog,
  insertAutomationRun,
  readCommentLogRows,
  readRunEventTrail,
  readRunRow,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { getPostgresConstraintName } from '@/shared/utils/infrastructure/postgres-error.util.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The run sub-domain's own SQL against the database (routes-final § 3.B.3 — AU12, AU17, AU19, AU20,
 * AU24, AU26, D47): one open run per automation × contact, the runs a retried event moved, the ones a
 * failed event left running, the automations of a contact's open runs, the two hooks other sub-domains
 * run inside their own transactions (the automation delete's open-run cancel and the contact erase's
 * step), and the comment-log counts reply safety reads. Every statement runs in the organization's own
 * context, so the suite also holds under `pnpm test:rls-role`.
 */

type TestOrganization = { id: number; public_id: string };

describe('automation runs and comment logs (database)', () => {
  let organization: TestOrganization;
  let account: { id: number; public_id: string };
  let automation: AutomationFixtureRow;
  let contact: ContactFixtureRow;
  let otherContact: ContactFixtureRow;
  let service: AutomationRunService;

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    automation = await insertAutomation({
      organizationId: organization.id,
      instagramAccountId: account.id,
      status: 'live',
    });
    contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    otherContact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    service = new AutomationRunService(
      {} as InstagramAccountService,
      {} as ContactService,
      new AutomationRunMessageService(),
      new AutomationPublicReplySafetyService(),
    );
  });

  /** Runs `work` in the organization's own unit of work, as a route or a job would. */
  function inOrganization<T>(work: () => Promise<T>): Promise<T> {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id }),
      callback: work,
    });
  }

  describe('one open run per automation × contact (AU17)', () => {
    it('refuses a second open run, and allows one once the first is final', async () => {
      const first = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
      });
      const insertSecond = () =>
        inOrganization(() =>
          new AutomationRunRepository().insert({
            organizationId: organization.id,
            automationId: automation.id,
            contactId: contact.id,
            triggerType: 'dm',
            triggerInstagramMediaId: null,
            triggerInstagramCommentId: null,
            triggerInstagramStoryId: null,
            triggerText: 'again',
            lastInstagramEventKey: 'message:again',
          }),
        );

      const failure = await insertSecond().catch((error: unknown) => error);
      expect(getPostgresConstraintName(failure)).toBe('idx_automation_runs_one_open');

      await inOrganization(() =>
        new AutomationRunRepository().update({
          organizationId: organization.id,
          runId: first.id,
          changes: {
            status: 'completed',
            completed_at: new Date(),
            waiting_for: null,
            waiting_since_at: null,
          },
        }),
      );
      await expect(insertSecond()).resolves.toMatchObject({ status: 'running' });
    });

    it('finds the runs an event last moved, oldest first (AU19)', async () => {
      const moved = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
        last_instagram_event_key: 'message:m-1',
      });
      await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: otherContact.id,
        last_instagram_event_key: 'message:m-1',
      });

      const found = await inOrganization(() =>
        new AutomationRunRepository().findRunsMovedByEvent({
          organizationId: organization.id,
          contactId: contact.id,
          eventKey: 'message:m-1',
        }),
      );

      expect(found.map((run) => run.id)).toEqual([moved.id]);
    });
  });

  describe('what the lock order and a failed event read (AU12, AU19, D47)', () => {
    const running = {
      status: 'running',
      waiting_for: null,
      waiting_since_at: null,
    } as const;
    const ended = {
      status: 'completed',
      waiting_for: null,
      waiting_since_at: null,
      completed_at: new Date(),
    } as const;

    it('lists the automations of the contact’s open runs, each once', async () => {
      const second = await insertAutomation({
        organizationId: organization.id,
        instagramAccountId: account.id,
      });
      const owner = { organizationId: organization.id, contactId: contact.id };
      await insertAutomationRun({ ...owner, automationId: automation.id, ...ended });
      await insertAutomationRun({ ...owner, automationId: automation.id });
      await insertAutomationRun({ ...owner, automationId: second.id, ...running });
      await insertAutomationRun({
        ...owner,
        automationId: (
          await insertAutomation({
            organizationId: organization.id,
            instagramAccountId: account.id,
          })
        ).id,
        ...ended,
      });
      await insertAutomationRun({
        organizationId: organization.id,
        contactId: otherContact.id,
        automationId: automation.id,
      });

      const listed = await inOrganization(() =>
        new AutomationRunRepository().listOpenRunAutomationIds(owner),
      );

      expect(listed.sort((left, right) => left - right)).toEqual([automation.id, second.id]);
    });

    it('lists the running runs an event last moved, whoever’s they are', async () => {
      const insertMoved = (values: Partial<Parameters<typeof insertAutomationRun>[0]>) =>
        insertAutomationRun({
          organizationId: organization.id,
          automationId: automation.id,
          contactId: contact.id,
          ...running,
          last_instagram_event_key: 'message:dead',
          ...values,
        });
      const first = await insertMoved({});
      const second = await insertMoved({ contactId: otherContact.id });
      const otherAutomationId = (
        await insertAutomation({ organizationId: organization.id, instagramAccountId: account.id })
      ).id;
      await insertMoved({ automationId: otherAutomationId, ...ended });
      await insertMoved({
        automationId: otherAutomationId,
        last_instagram_event_key: 'message:later',
      });

      const listed = await inOrganization(() =>
        new AutomationRunRepository().listRunningMovedByEvent({
          organizationId: organization.id,
          eventKey: 'message:dead',
        }),
      );

      expect(listed.map((run) => run.id)).toEqual([first.id, second.id]);
    });
  });

  describe('cancelAutomationOpenRuns — the automation delete (AU12)', () => {
    it("cancels the automation's open runs with an event each and their logs, leaving final runs", async () => {
      const waiting = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
        queued_automations: [
          {
            automation_id: 'aut_a1b2c3d4e5f6g7h8i9j0k',
            queued_at: new Date().toISOString(),
            trigger: { type: 'dm', text: 'hi' },
          },
        ],
      });
      const completed = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: otherContact.id,
        status: 'completed',
        waiting_for: null,
        waiting_since_at: null,
        completed_at: new Date(),
      });
      await insertAutomationCommentLog({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
        automation_run_id: waiting.id,
        overall_status: 'waiting',
        waiting_for: 'email',
      });

      const cancelled = await inOrganization(() =>
        service.cancelAutomationOpenRuns({
          organizationId: organization.id,
          automationId: automation.id,
        }),
      );

      expect(cancelled).toBe(1);
      const run = await readRunRow(waiting.id);
      expect(run).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'automation_deleted',
        waiting_for: null,
        queued_automations: [],
      });
      expect(run?.ended_at).toEqual(run?.cancelled_at);
      expect(await readRunEventTrail(waiting.id)).toEqual(['status_changed:cancelled']);
      expect((await readRunRow(completed.id))?.status).toBe('completed');
      const [log] = await readCommentLogRows(organization.id);
      expect(log).toMatchObject({ overall_status: 'cancelled', waiting_for: null });
    });
  });

  describe('eraseContactRunCopies — the contact erase (AU26, CT8)', () => {
    it("cancels the contact's open runs and clears every copy of its personal data", async () => {
      const open = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
      });
      const final = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
        status: 'failed',
        waiting_for: null,
        waiting_since_at: null,
        failed_at: new Date(),
        last_instagram_event_key: 'message:earlier',
      });
      const othersRun = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: otherContact.id,
      });
      const log = await insertAutomationCommentLog({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
        automation_run_id: final.id,
        overall_status: 'failed',
        error_at: new Date(),
        email_received: 'jordan@example.com',
        phone_received: '+15550100123',
      });
      const othersLog = await insertAutomationCommentLog({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: otherContact.id,
      });

      await inOrganization(() =>
        service.eraseContactRunCopies({
          organizationId: organization.id,
          contactId: contact.id,
          instagramUserId: contact.instagram_user_id ?? '',
        }),
      );

      expect(await readRunRow(open.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'contact_deleted',
        trigger_text: null,
      });
      expect(await readRunEventTrail(open.id)).toEqual(['status_changed:cancelled']);
      expect(await readRunRow(final.id)).toMatchObject({ status: 'failed', trigger_text: null });
      expect(await readRunRow(othersRun.id)).toMatchObject({
        status: 'waiting',
        trigger_text: 'catalog please',
      });
      const logs = await readCommentLogRows(organization.id);
      expect(logs.find((row) => row.id === log.id)).toMatchObject({
        comment_text: null,
        commenter_username: null,
        commenter_instagram_user_id: null,
        email_received: null,
        phone_received: null,
        instagram_comment_id: log.instagram_comment_id,
      });
      expect(logs.find((row) => row.id === othersLog.id)).toMatchObject({
        comment_text: 'link please',
        commenter_username: 'jordan.lee',
      });
    });
  });

  describe('the comment-log counts of reply safety (AU20)', () => {
    it('reads the duplicate, the hour count, the last reply time and the last text', async () => {
      const now = Date.now();
      const sent = (minutesAgo: number, text: string, instagramCommentId?: string) =>
        insertAutomationCommentLog({
          organizationId: organization.id,
          automationId: automation.id,
          contactId: contact.id,
          public_reply_status: 'sent',
          public_reply_text: text,
          public_reply_at: new Date(now - minutesAgo * 60_000),
          ...(instagramCommentId === undefined ? {} : { instagram_comment_id: instagramCommentId }),
        });
      await sent(90, 'Old');
      await sent(30, 'Newer', '17950000000000777');
      await sent(5, 'Newest');
      const repository = new AutomationCommentLogRepository();

      // One query at a time: the unit of work holds one connection.
      const [duplicate, notDuplicate, lastHour, lastAt, lastText] = await inOrganization(
        async () =>
          [
            await repository.hasSentPublicReply({
              organizationId: organization.id,
              instagramCommentId: '17950000000000777',
            }),
            await repository.hasSentPublicReply({
              organizationId: organization.id,
              instagramCommentId: '17950000000000778',
            }),
            await repository.countSentPublicRepliesSince({
              organizationId: organization.id,
              since: new Date(now - 60 * 60_000),
            }),
            await repository.findLastSentPublicReplyAt({ organizationId: organization.id }),
            await repository.findLastSentPublicReplyText({
              organizationId: organization.id,
              automationId: automation.id,
            }),
          ] as const,
      );

      expect(duplicate).toBe(true);
      expect(notDuplicate).toBe(false);
      expect(lastHour).toBe(2);
      expect(lastAt?.getTime()).toBe(now - 5 * 60_000);
      expect(lastText).toBe('Newest');
    });

    it('keeps one log per comment × automation (AU24)', async () => {
      const commentId = '17950000000000901';
      await insertAutomationCommentLog({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
        instagram_comment_id: commentId,
      });

      await expect(
        insertAutomationCommentLog({
          organizationId: organization.id,
          automationId: automation.id,
          contactId: otherContact.id,
          instagram_comment_id: commentId,
        }),
      ).rejects.toThrow();
    });
  });
});
