import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { automation_runs } from '@/domains/app/sub-domains/automation/automation-run/automation-run.schema.js';
import { runAutomationRunRetentionJob } from '@/domains/app/sub-domains/automation/automation-run/workers/automation-run-retention.processor.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  type AutomationRunFixtureRow,
  insertAutomationCommentLog,
  insertAutomationRun,
  insertAutomationRunEvent,
  readCommentLogRows,
  readRunEventsOfOrganization,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Run retention against the real tables (routes-final § 3.B AU25, AUC14; WC-12, D8): every run
 * that ended — completed, failed or cancelled — more than 180 days ago goes in every organization,
 * its run events with it, while its comment logs stay with the run emptied (AU24). A run that ended
 * since, and an open run however old, stay. It runs under the retention context
 * (`runGlobalRetentionWorkerJob`), the table's `USING` sweep arm.
 */

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

type TestOrganization = { id: number; public_id: string };

describe('runAutomationRunRetentionJob (database)', () => {
  let now: Date;

  function daysBefore(days: number): Date {
    return new Date(now.getTime() - days * DAY_MILLISECONDS);
  }

  beforeEach(async () => {
    await cleanupDatabase();
    now = new Date();
  });

  /** One organization's runs: three ended long ago (with an event and a log each), the rest kept. */
  async function seedOrganization(): Promise<{
    organization: TestOrganization;
    removed: AutomationRunFixtureRow[];
    kept: AutomationRunFixtureRow[];
  }> {
    const organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    const account = await insertInstagramAccount({ organizationId: organization.id });
    const automation = await insertAutomation({
      organizationId: organization.id,
      instagramAccountId: account.id,
      status: 'live',
    });
    const newRun = async (
      overrides: Partial<Parameters<typeof insertAutomationRun>[0]>,
    ): Promise<AutomationRunFixtureRow> => {
      const contact = await insertContact({
        organizationId: organization.id,
        instagramAccountId: account.id,
      });
      return insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
        started_at: daysBefore(200),
        ...overrides,
      });
    };
    const ended = { waiting_for: null, waiting_since_at: null } as const;

    const removed = [
      await newRun({ ...ended, status: 'completed', completed_at: daysBefore(181) }),
      await newRun({ ...ended, status: 'failed', failed_at: daysBefore(181) }),
      await newRun({
        ...ended,
        status: 'cancelled',
        cancelled_at: daysBefore(190),
        cancel_reason: 'wait_expired',
      }),
    ];
    for (const run of removed) {
      await insertAutomationRunEvent({
        organizationId: organization.id,
        runId: run.id,
        status: run.status,
      });
      await insertAutomationCommentLog({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: run.contact_id,
        automation_run_id: run.id,
        overall_status: 'completed',
      });
    }

    const kept = [
      await newRun({ ...ended, status: 'completed', completed_at: daysBefore(179) }),
      // Open runs have no `ended_at` — never removed, however old.
      await newRun({ waiting_since_at: daysBefore(200) }),
      await newRun({ ...ended, status: 'running', current_step: 'final_dm' }),
    ];
    for (const run of kept) {
      await insertAutomationRunEvent({
        organizationId: organization.id,
        runId: run.id,
        status: run.status,
      });
    }
    return { organization, removed, kept };
  }

  async function remainingRunIds(organizationId: number): Promise<number[]> {
    const rows = await getOperatorDatabase()
      .select({ id: automation_runs.id })
      .from(automation_runs)
      .where(eq(automation_runs.organization_id, organizationId))
      .orderBy(asc(automation_runs.id));
    return rows.map((row) => row.id);
  }

  it('deletes the runs ended more than 180 days ago in every organization, keeps the rest and every open run', async () => {
    const first = await seedOrganization();
    const second = await seedOrganization();

    const result = await runAutomationRunRetentionJob({ now });

    expect(result).toEqual({ deletedCount: 6, blockedCount: 0, hasMore: false });
    for (const { organization, removed, kept } of [first, second]) {
      expect(await remainingRunIds(organization.id)).toEqual(kept.map((run) => run.id));
      // Their run events went with them (ON DELETE CASCADE); the kept runs keep theirs.
      expect(await readRunEventsOfOrganization(organization.id)).toEqual(
        kept.map((run) => `${run.id}:status_changed:${run.status}`),
      );
      // Their comment logs stay, the run emptied (ON DELETE SET NULL (automation_run_id), AU24).
      const logs = await readCommentLogRows(organization.id);
      expect(logs).toHaveLength(removed.length);
      expect(logs.map((log) => log.automation_run_id)).toEqual(removed.map(() => null));
      expect(logs.map((log) => log.contact_id)).toEqual(removed.map((run) => run.contact_id));
    }
  });

  it('is safe to run twice — the second run deletes nothing', async () => {
    const { organization, kept } = await seedOrganization();

    await runAutomationRunRetentionJob({ now });
    const repeat = await runAutomationRunRetentionJob({ now });

    expect(repeat).toEqual({ deletedCount: 0, blockedCount: 0, hasMore: false });
    expect(await remainingRunIds(organization.id)).toEqual(kept.map((run) => run.id));
  });
});
