import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAutomationCommentLogRetentionJob } from '@/domains/app/sub-domains/automation/automation-run/workers/automation-comment-log-retention.processor.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  type AutomationCommentLogFixtureRow,
  insertAutomationCommentLog,
  insertAutomationRun,
  readCommentLogRows,
  readRunRow,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Comment-log retention against the real table (routes-final § 3.B AU25, AUC14; WC-9, D8): every
 * log written more than 180 days ago goes — any status, every organization, its run kept — and
 * every younger one stays. It runs under the retention context (`runGlobalRetentionWorkerJob`),
 * the table's `USING` sweep arm.
 */

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

type TestOrganization = { id: number; public_id: string };

describe('runAutomationCommentLogRetentionJob (database)', () => {
  let now: Date;

  function daysBefore(days: number): Date {
    return new Date(now.getTime() - days * DAY_MILLISECONDS);
  }

  beforeEach(async () => {
    await cleanupDatabase();
    now = new Date();
  });

  /** One organization's logs: old ones of every kind (one with its run) and young ones. */
  async function seedOrganization(): Promise<{
    organization: TestOrganization;
    old: AutomationCommentLogFixtureRow[];
    young: AutomationCommentLogFixtureRow[];
    runId: number;
  }> {
    const organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    const account = await insertInstagramAccount({ organizationId: organization.id });
    const automation = await insertAutomation({
      organizationId: organization.id,
      instagramAccountId: account.id,
      status: 'live',
    });
    const contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    const run = await insertAutomationRun({
      organizationId: organization.id,
      automationId: automation.id,
      contactId: contact.id,
      status: 'completed',
      waiting_for: null,
      waiting_since_at: null,
      completed_at: daysBefore(100),
    });
    const newLog = (overrides: Partial<Parameters<typeof insertAutomationCommentLog>[0]>) =>
      insertAutomationCommentLog({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
        ...overrides,
      });

    const old = [
      await newLog({
        created_at: daysBefore(181),
        automation_run_id: run.id,
        overall_status: 'completed',
      }),
      await newLog({
        created_at: daysBefore(200),
        overall_status: 'ignored',
        ignored_reason: 'comment_already_answered',
      }),
      await newLog({ created_at: daysBefore(181), overall_status: 'cancelled' }),
    ];
    const young = [
      await newLog({ created_at: daysBefore(179), overall_status: 'completed' }),
      await newLog({ overall_status: 'started' }),
    ];
    return { organization, old, young, runId: run.id };
  }

  it('deletes the logs written more than 180 days ago in every organization and keeps the rest', async () => {
    const first = await seedOrganization();
    const second = await seedOrganization();

    const result = await runAutomationCommentLogRetentionJob({ now });

    expect(result).toEqual({ deletedCount: 6, blockedCount: 0, hasMore: false });
    for (const { organization, young, runId } of [first, second]) {
      expect((await readCommentLogRows(organization.id)).map((log) => log.id)).toEqual(
        young.map((log) => log.id),
      );
      // The run of a removed log stays — runs have their own clean-up (WC-12).
      expect(await readRunRow(runId)).toBeDefined();
    }
  });

  it('is safe to run twice — the second run deletes nothing', async () => {
    const { organization, young } = await seedOrganization();

    await runAutomationCommentLogRetentionJob({ now });
    const repeat = await runAutomationCommentLogRetentionJob({ now });

    expect(repeat).toEqual({ deletedCount: 0, blockedCount: 0, hasMore: false });
    expect((await readCommentLogRows(organization.id)).map((log) => log.id)).toEqual(
      young.map((log) => log.id),
    );
  });
});
