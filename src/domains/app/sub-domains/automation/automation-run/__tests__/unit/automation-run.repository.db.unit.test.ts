import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runGlobalRetentionWorkerJob,
  runOrganizationScopedWorkerJob,
  type WorkerDatabaseHandle,
} from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { createWorkerAutomationRunRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-run.repository.js';
import {
  createRetentionAutomationRunOpenKeyRepository,
  createWorkerAutomationRunOpenKeyRepository,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run-open-key.repository.js';
import { createWorkerAutomationCommentLogRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.repository.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationCommentLog,
  insertAutomationRun,
  readOpenRunKeys,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The run sub-domain's repositories against the split tables (feat-instagram-dm-sending routes-final
 * § 4.B.3 — AUC9, AUC14, AUC15): the once rule's read across the kept parts (AU22), the open key's
 * insert as the guard and its delete when a run ends (AU37), the repair duty removing a key whose run
 * ended (WC-67), a cancel answering its runs with their start months, and a comment's logs read in
 * the last two month parts (AU28). Every statement runs in the organization's own job scope.
 */
describe('automation-run repositories (database)', () => {
  let organization: { id: number; public_id: string };
  let automationId: number;
  let contactId: number;

  const inJob = <T>(work: (databaseHandle: WorkerDatabaseHandle) => Promise<T>) =>
    runOrganizationScopedWorkerJob({
      job: { organizationPublicId: organization.public_id },
      processor: work,
    });

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    const account = await insertInstagramAccount({ organizationId: organization.id });
    automationId = (
      await insertAutomation({
        organizationId: organization.id,
        instagramAccountId: account.id,
        status: 'live',
      })
    ).id;
    contactId = (
      await insertContact({ organizationId: organization.id, instagramAccountId: account.id })
    ).id;
  });

  it('the once rule reads a DM sent under the key in any kept month part (AU22)', async () => {
    await insertAutomationRun({
      organizationId: organization.id,
      automationId,
      contactId,
      status: 'completed',
      current_step: 'messages',
      waiting_for: null,
      waiting_since_at: null,
      completed_at: new Date('2026-10-05T10:00:00Z'),
      started_at: new Date('2026-10-05T09:00:00Z'),
      once_key: '17900000000000001',
      direct_message_sent_at: new Date('2026-10-05T09:00:05Z'),
    });
    const found = await inJob((databaseHandle) =>
      createWorkerAutomationRunRepository(databaseHandle).hasDirectMessageForOnceKey({
        organizationId: organization.id,
        automationId,
        contactId,
        onceKey: '17900000000000001',
      }),
    );
    const other = await inJob((databaseHandle) =>
      createWorkerAutomationRunRepository(databaseHandle).hasDirectMessageForOnceKey({
        organizationId: organization.id,
        automationId,
        contactId,
        onceKey: '17900000000000002',
      }),
    );
    expect([found, other]).toEqual([true, false]);
  });

  it('the open key insert is the guard; a second insert of the pair answers false (AU37)', async () => {
    const first = await insertAutomationRun({
      organizationId: organization.id,
      automationId,
      contactId,
      isOpenKeyLeftOut: true,
    });
    const second = await insertAutomationRun({
      organizationId: organization.id,
      automationId,
      contactId,
      isOpenKeyLeftOut: true,
      started_at: new Date('2026-12-02T00:00:00Z'),
    });
    const inserted = await inJob(async (databaseHandle) => {
      const keys = createWorkerAutomationRunOpenKeyRepository(databaseHandle);
      const values = { organizationId: organization.id, automationId, contactId };
      return [
        await keys.insert({ ...values, runId: first.id, runStartedAt: first.started_at }),
        await keys.insert({ ...values, runId: second.id, runStartedAt: second.started_at }),
      ];
    });
    expect(inserted).toEqual([true, false]);
    expect(await readOpenRunKeys(organization.id)).toEqual([
      `${automationId}:${contactId}:${first.id}`,
    ]);
  });

  it('a cancel answers its runs with their start months, and their keys go with deleteForRuns', async () => {
    const run = await insertAutomationRun({
      organizationId: organization.id,
      automationId,
      contactId,
    });
    const deleted = await inJob(async (databaseHandle) => {
      const ended = await createWorkerAutomationRunRepository(
        databaseHandle,
      ).cancelOpenRunsOfContact({
        organizationId: organization.id,
        contactId,
        reason: 'opted_out',
      });
      expect(ended).toEqual([
        {
          id: run.id,
          started_at: run.started_at,
          automation_id: automationId,
          contact_id: contactId,
        },
      ]);
      return createWorkerAutomationRunOpenKeyRepository(databaseHandle).deleteForRuns({
        organizationId: organization.id,
        runs: ended,
      });
    });
    expect(deleted).toBe(1);
    expect(await readOpenRunKeys(organization.id)).toEqual([]);
  });

  it('the repair duty removes a key whose run ended and keeps an open run’s key (WC-67, P100)', async () => {
    const open = await insertAutomationRun({
      organizationId: organization.id,
      automationId,
      contactId,
    });
    const otherContact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: (await insertInstagramAccount({ organizationId: organization.id })).id,
    });
    // A key a missed delete left behind: its run completed, the key still there.
    await insertAutomationRun({
      organizationId: organization.id,
      automationId,
      contactId: otherContact.id,
      status: 'completed',
      current_step: 'messages',
      waiting_for: null,
      waiting_since_at: null,
      completed_at: new Date(),
    });
    const ended = await insertAutomationRun({
      organizationId: organization.id,
      automationId,
      contactId: otherContact.id,
      isOpenKeyLeftOut: true,
    });
    await inJob((databaseHandle) =>
      createWorkerAutomationRunOpenKeyRepository(databaseHandle).insert({
        organizationId: organization.id,
        automationId,
        contactId: otherContact.id,
        runId: ended.id,
        runStartedAt: ended.started_at,
      }),
    );
    await inJob((databaseHandle) =>
      createWorkerAutomationRunRepository(databaseHandle).update({
        organizationId: organization.id,
        runId: ended.id,
        runStartedAt: ended.started_at,
        changes: {
          status: 'failed',
          failed_at: new Date(),
          waiting_for: null,
          waiting_since_at: null,
        },
      }),
    );
    const removed = await runGlobalRetentionWorkerJob((databaseHandle) =>
      createRetentionAutomationRunOpenKeyRepository(databaseHandle).deleteKeysOfEndedRuns({
        limit: 100,
      }),
    );
    expect(removed).toBe(1);
    expect(await readOpenRunKeys(organization.id)).toEqual([
      `${automationId}:${contactId}:${open.id}`,
    ]);
  });

  it('a comment’s logs are read from `since` on — the last two month parts (AU28)', async () => {
    const commentId = '17950000000000042';
    await insertAutomationCommentLog({
      organizationId: organization.id,
      automationId,
      contactId,
      instagram_comment_id: commentId,
      created_at: new Date('2026-08-01T00:00:00Z'),
      updated_at: new Date('2026-08-01T00:00:00Z'),
    });
    await insertAutomationCommentLog({
      organizationId: organization.id,
      automationId,
      contactId,
      instagram_comment_id: commentId,
    });
    const logs = await inJob((databaseHandle) =>
      createWorkerAutomationCommentLogRepository(databaseHandle).listForComment({
        organizationId: organization.id,
        commentId,
        since: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      }),
    );
    expect(logs).toHaveLength(1);
  });
});
