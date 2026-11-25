import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import { automation_runs } from '@/domains/app/sub-domains/automation/automation-run/automation-run.schema.js';
import { automation_counts } from '@/domains/app/sub-domains/automation/automation-count.schema.js';
import { runAutomationTombstoneRetentionJob } from '@/domains/app/sub-domains/automation/workers/automation-tombstone-retention.processor.js';
import {
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
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The deleted-automation purge against the real tables (routes-final § 3.B AU25, AQ7, AUC14;
 * WC-15, WC-47): an automation deleted more than 180 days ago that nothing points at goes, in every
 * organization; one a run or a comment log still points at is skipped (`RESTRICT`, the batch
 * delete's per-row fallback) and goes on a later hour once they are gone; a younger delete and a
 * live automation stay. It runs under the retention context (`runGlobalRetentionWorkerJob`), hourly
 * within the time budget, with the oldest-row gauge (P92); its counters go with it only (its file
 * links: `app-table-clean-up.db.unit.test.ts`).
 */

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

type TestOrganization = { id: number; public_id: string };

describe('runAutomationTombstoneRetentionJob (database)', () => {
  let now: Date;

  function daysBefore(days: number): Date {
    return new Date(now.getTime() - days * DAY_MILLISECONDS);
  }

  beforeEach(async () => {
    await cleanupDatabase();
    now = new Date();
  });

  async function remainingAutomationIds(organizationId: number): Promise<number[]> {
    const rows = await getOperatorDatabase()
      .select({ id: automations.id })
      .from(automations)
      .where(eq(automations.organization_id, organizationId))
      .orderBy(asc(automations.id));
    return rows.map((row) => row.id);
  }

  /** One organization: a purgeable automation, two still referenced, a young delete and a live one. */
  async function seedOrganization(): Promise<{
    organization: TestOrganization;
    purgeable: AutomationFixtureRow;
    referencedByRun: AutomationFixtureRow;
    referencedByLog: AutomationFixtureRow;
    kept: AutomationFixtureRow[];
    runId: number;
    contactId: number;
  }> {
    const organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    const account = await insertInstagramAccount({ organizationId: organization.id });
    const contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    const newAutomation = (deletedDaysAgo: number | null) =>
      insertAutomation({
        organizationId: organization.id,
        instagramAccountId: account.id,
        created_at: daysBefore(400),
        ...(deletedDaysAgo === null
          ? {}
          : { deleted_at: daysBefore(deletedDaysAgo), delete_reason: 'not_needed' as const }),
      });

    const purgeable = await newAutomation(181);
    const referencedByRun = await newAutomation(200);
    const referencedByLog = await newAutomation(190);
    const youngDelete = await newAutomation(179);
    const live = await newAutomation(null);

    const run = await insertAutomationRun({
      organizationId: organization.id,
      automationId: referencedByRun.id,
      contactId: contact.id,
      status: 'cancelled',
      cancel_reason: 'automation_deleted',
      cancelled_at: daysBefore(170),
      waiting_for: null,
      waiting_since_at: null,
    });
    await insertAutomationCommentLog({
      organizationId: organization.id,
      automationId: referencedByLog.id,
      contactId: contact.id,
      overall_status: 'cancelled',
    });

    return {
      organization,
      purgeable,
      referencedByRun,
      referencedByLog,
      kept: [youngDelete, live],
      runId: run.id,
      contactId: contact.id,
    };
  }

  it('purges the unreferenced automations deleted more than 180 days ago in every organization and skips the referenced ones', async () => {
    const first = await seedOrganization();
    const second = await seedOrganization();

    const result = await runAutomationTombstoneRetentionJob({ now });

    expect(result).toEqual([
      {
        table: 'app.automations',
        deletedCount: 2,
        blockedCount: 4,
        stoppedBy: 'done',
        // The oldest still-referenced one was deleted 200 days ago: 20 days past its keep time.
        oldestOverdueSeconds: expect.any(Number),
      },
    ]);
    expect(result[0]?.oldestOverdueSeconds).toBeGreaterThan(19 * 24 * 60 * 60);
    expect(result[0]?.oldestOverdueSeconds).toBeLessThan(21 * 24 * 60 * 60);
    for (const { organization, referencedByRun, referencedByLog, kept } of [first, second]) {
      expect(await remainingAutomationIds(organization.id)).toEqual(
        [referencedByRun, referencedByLog, ...kept].map((automation) => automation.id),
      );
    }
  });

  it('tries a still-referenced automation again the next hour and purges it once nothing points at it', async () => {
    const { organization, referencedByRun, referencedByLog, kept, runId } =
      await seedOrganization();

    await runAutomationTombstoneRetentionJob({ now });
    const [repeat] = await runAutomationTombstoneRetentionJob({ now });
    expect(repeat).toMatchObject({ deletedCount: 0, blockedCount: 2, stoppedBy: 'done' });

    // Run retention removed the run meanwhile (WC-12).
    await getOperatorDatabase().delete(automation_runs).where(eq(automation_runs.id, runId));
    const [nextHour] = await runAutomationTombstoneRetentionJob({ now });

    expect(nextHour).toMatchObject({ deletedCount: 1, blockedCount: 1, stoppedBy: 'done' });
    const remaining = await remainingAutomationIds(organization.id);
    expect(remaining).not.toContain(referencedByRun.id);
    expect(remaining).toEqual([referencedByLog, ...kept].map((automation) => automation.id));
  });

  it("keeps a live automation's counters the same after the runs they counted are gone; a purged one's go with it (AC-18.8)", async () => {
    const { organization, purgeable, kept, contactId } = await seedOrganization();
    const live = kept[1]!;
    const liveRun = await insertAutomationRun({
      organizationId: organization.id,
      automationId: live.id,
      contactId,
      status: 'cancelled',
      cancel_reason: 'automation_deleted',
      cancelled_at: daysBefore(100),
      waiting_for: null,
      waiting_since_at: null,
    });
    await getOperatorDatabase()
      .insert(automation_counts)
      .values([
        { organization_id: organization.id, automation_id: purgeable.id, slot: 0, runs_started: 5 },
        { organization_id: organization.id, automation_id: live.id, slot: 0, runs_started: 7 },
      ]);
    // The run's part is dropped (R49) — the counter is never recounted from runs.
    await getOperatorDatabase().delete(automation_runs).where(eq(automation_runs.id, liveRun.id));

    await runAutomationTombstoneRetentionJob({ now });

    const counts = await getOperatorDatabase()
      .select({
        automationId: automation_counts.automation_id,
        runs: automation_counts.runs_started,
      })
      .from(automation_counts)
      .where(eq(automation_counts.organization_id, organization.id));
    expect(counts).toEqual([{ automationId: live.id, runs: 7 }]);
  });
});
