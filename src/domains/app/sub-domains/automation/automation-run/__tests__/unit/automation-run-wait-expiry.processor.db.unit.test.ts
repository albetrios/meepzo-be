import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { runOrganizationScopedWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import type { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import { RecordingSendingPort } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/recording-sending-port.factory.js';
import { automation_runs } from '@/domains/app/sub-domains/automation/automation-run/automation-run.schema.js';
import {
  type AutomationRunWaitExpiryService,
  runAutomationRunWaitExpiryJob,
} from '@/domains/app/sub-domains/automation/automation-run/workers/automation-run-wait-expiry.processor.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  type AutomationRunFixtureRow,
  insertAutomationCommentLog,
  insertAutomationRun,
  readCommentLogRows,
  readOpenRunKeys,
  readRunEventTrail,
  readRunRow,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { entitlementServiceOf } from '@/domains/app/__tests__/factories/entitlement.factory.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The 7-day wait check against the real tables (feat-instagram-dm-sending routes-final § 4.B AU30,
 * AUC11; WC-45 CHANGED — P99, P100): the cross-organization scan under the retention context, then
 * each organization's cancel in its own job scope through the run service. A run waiting more than
 * 7 days is cancelled `wait_expired` with one `status_changed` event, its comment log `cancelled`,
 * **its open-run key deleted in the same commit** and its waiting messages cancelled through the
 * channel's port; a younger wait, a run that got its answer just before, and another organization's
 * rows are left alone; a repeat changes nothing.
 */

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

type TestOrganization = { id: number; public_id: string };

/** One organization with a connected account and a live automation. */
interface OrganizationFixture {
  organization: TestOrganization;
  accountId: number;
  automationId: number;
}

async function createOrganizationFixture(): Promise<OrganizationFixture> {
  const organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
  const account = await insertInstagramAccount({ organizationId: organization.id });
  const automation = await insertAutomation({
    organizationId: organization.id,
    instagramAccountId: account.id,
    status: 'live',
  });
  return { organization, accountId: account.id, automationId: automation.id };
}

/** A run of the fixture's automation for a new contact, waiting for an email since `waitingSince`. */
async function insertWaitingRun({
  fixture,
  waitingSince,
}: {
  fixture: OrganizationFixture;
  waitingSince: Date;
}): Promise<AutomationRunFixtureRow> {
  const contact = await insertContact({
    organizationId: fixture.organization.id,
    instagramAccountId: fixture.accountId,
  });
  return insertAutomationRun({
    organizationId: fixture.organization.id,
    automationId: fixture.automationId,
    contactId: contact.id,
    waiting_since_at: waitingSince,
  });
}

/** The run engine with a recording port — the 7-day cancel needs nothing else. */
function createRunService(port: RecordingSendingPort): AutomationRunService {
  return new AutomationRunService({
    channelAccountService: { readAutomationRunAccount: async () => null },
    contactService: {} as ContactService,
    entitlementService: entitlementServiceOf({ features: null }),
    countService: {} as never,
    replyStateService: {} as never,
    sendingPorts: { instagram: port },
  });
}

describe('runAutomationRunWaitExpiryJob (database)', () => {
  let now: Date;
  let first: OrganizationFixture;
  let second: OrganizationFixture;
  let runService: AutomationRunService;
  let port: RecordingSendingPort;

  function daysBefore(days: number): Date {
    return new Date(now.getTime() - days * DAY_MILLISECONDS);
  }

  beforeEach(async () => {
    await cleanupDatabase();
    now = new Date();
    first = await createOrganizationFixture();
    second = await createOrganizationFixture();
    port = new RecordingSendingPort();
    runService = createRunService(port);
  });

  it('cancels every run waiting more than 7 days, each in its own organization — event, log, key and messages included', async () => {
    const expired = await insertWaitingRun({ fixture: first, waitingSince: daysBefore(8) });
    const expiredLog = await insertAutomationCommentLog({
      organizationId: first.organization.id,
      automationId: first.automationId,
      contactId: expired.contact_id,
      run: expired,
      overall_status: 'waiting',
      waiting_for: 'email',
      email_status: 'waiting',
    });
    const young = await insertWaitingRun({ fixture: first, waitingSince: daysBefore(6) });
    const otherExpired = await insertWaitingRun({ fixture: second, waitingSince: daysBefore(10) });
    const otherYoung = await insertWaitingRun({ fixture: second, waitingSince: daysBefore(1) });

    const result = await runAutomationRunWaitExpiryJob({ runService, now });

    expect(result).toEqual({ scanned: 2, cancelled: 2, failedOrganizationCount: 0 });

    const cancelled = await readRunRow(expired.id);
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'wait_expired',
      waiting_for: null,
      waiting_since_at: null,
    });
    expect(cancelled?.cancelled_at).toBeInstanceOf(Date);
    expect(cancelled?.ended_at).toEqual(cancelled?.cancelled_at);
    expect(await readRunEventTrail(expired.id)).toEqual(['status_changed:cancelled']);
    const [log] = (await readCommentLogRows(first.organization.id)).filter(
      (row) => row.id === expiredLog.id,
    );
    expect(log).toMatchObject({ overall_status: 'cancelled', waiting_for: null });

    expect(await readRunRow(otherExpired.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'wait_expired',
    });
    expect(await readRunEventTrail(otherExpired.id)).toEqual(['status_changed:cancelled']);
    // The open keys of the cancelled runs went in their commits; the young waits keep theirs.
    expect(await readOpenRunKeys(first.organization.id)).toEqual([
      `${first.automationId}:${young.contact_id}:${young.id}`,
    ]);
    expect(
      port.cancelled.map((selection) => [selection.by, selection.id, selection.reason]).sort(),
    ).toEqual(
      [
        ['run', expired.id, 'wait_expired'],
        ['run', otherExpired.id, 'wait_expired'],
      ].sort(),
    );

    for (const untouched of [young, otherYoung]) {
      expect(await readRunRow(untouched.id)).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
        cancel_reason: null,
      });
      expect(await readRunEventTrail(untouched.id)).toEqual([]);
    }
  });

  it('does not cancel a run that got its answer just before — moved on, or waiting again since', async () => {
    const answered = await insertWaitingRun({ fixture: first, waitingSince: daysBefore(8) });
    const waitingAgain = await insertWaitingRun({ fixture: first, waitingSince: daysBefore(9) });
    // The answers arrive between the scan and the organization's cancel.
    const answeringService: AutomationRunWaitExpiryService = {
      async cancelExpiredWaitingRuns(options) {
        await getOperatorDatabase()
          .update(automation_runs)
          .set({
            status: 'running',
            current_step: 'phone_collect',
            waiting_for: null,
            waiting_since_at: null,
          })
          .where(eq(automation_runs.id, answered.id));
        await getOperatorDatabase()
          .update(automation_runs)
          .set({
            current_step: 'phone_collect',
            waiting_for: 'phone',
            waiting_since_at: new Date(),
          })
          .where(eq(automation_runs.id, waitingAgain.id));
        return runService.cancelExpiredWaitingRuns(options);
      },
    };

    const result = await runAutomationRunWaitExpiryJob({ runService: answeringService, now });

    expect(result).toEqual({ scanned: 2, cancelled: 0, failedOrganizationCount: 0 });
    expect(await readRunRow(answered.id)).toMatchObject({ status: 'running', cancel_reason: null });
    expect(await readRunRow(waitingAgain.id)).toMatchObject({
      status: 'waiting',
      waiting_for: 'phone',
      cancel_reason: null,
    });
    expect(await readRunEventTrail(answered.id)).toEqual([]);
    expect(await readRunEventTrail(waitingAgain.id)).toEqual([]);
  });

  it('is safe to run twice — the second check finds and changes nothing', async () => {
    const expired = await insertWaitingRun({ fixture: first, waitingSince: daysBefore(30) });

    await runAutomationRunWaitExpiryJob({ runService, now });
    const before = await readRunRow(expired.id);
    const repeat = await runAutomationRunWaitExpiryJob({ runService, now });

    expect(repeat).toEqual({ scanned: 0, cancelled: 0, failedOrganizationCount: 0 });
    expect(await readRunRow(expired.id)).toEqual(before);
    expect(await readRunEventTrail(expired.id)).toEqual(['status_changed:cancelled']);
  });

  it('cancels nothing of another organization, even when handed its run ids', async () => {
    const otherExpired = await insertWaitingRun({ fixture: second, waitingSince: daysBefore(20) });

    const cancelled = await runOrganizationScopedWorkerJob({
      job: { organizationPublicId: first.organization.public_id },
      processor: (databaseHandle) =>
        runService.cancelExpiredWaitingRuns({
          databaseHandle,
          organizationId: first.organization.id,
          runIds: [otherExpired.id],
          waitingSinceBefore: daysBefore(7),
        }),
    });

    expect(cancelled).toBe(0);
    expect(await readRunRow(otherExpired.id)).toMatchObject({ status: 'waiting' });
    expect(await readRunEventTrail(otherExpired.id)).toEqual([]);
  });
});
