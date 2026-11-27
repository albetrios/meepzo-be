import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import {
  RESOURCE_QUOTA_LOCK_NAMESPACE,
  acquireResourceQuotaLock,
} from '@/infrastructure/database/resource-quota-lock.util.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { insertAutomationRun } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { insertInstagramOutgoingMessage } from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/__tests__/factories/instagram-outgoing-message.factory.js';
import {
  insertLanes,
  setMonthCount,
} from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import { InstagramSendGateService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-gate.service.js';
import { InstagramSendLaneRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.repository.js';
import { InstagramSendLaneService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.service.js';
import { InstagramSendStopRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-stop.repository.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.mock('@/infrastructure/database/resource-quota-lock.util.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/infrastructure/database/resource-quota-lock.util.js')>();
  return { ...actual, acquireResourceQuotaLock: vi.fn(actual.acquireResourceQuotaLock) };
});

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ACCOUNT_COUNT = 4;

/**
 * The hard month cap (feat-instagram-dm-sending SN8 — owner 2026-11-26, superseding D34's soft
 * cap): parallel claims of several accounts never push the month over the plan's limit, and the
 * organization's month lock is taken only in the month's last messages. Real claims against
 * Postgres in the organization's job scope (`pnpm test:rls-role` safe).
 */
describe('InstagramSendGateService — the hard month cap (database)', () => {
  let organization: { id: number; public_id: string };
  let messages: Array<{ public_id: string; automation_run_started_at: Date }>;
  let gate: InstagramSendGateService;

  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id });

  /** One claim of a waiting counted DM on the slow lane under the given month limit. */
  function claim(message: (typeof messages)[number], monthLimit: number) {
    return gate.claimSend({
      scope: scope(),
      key: {
        organizationId: organization.id,
        publicId: message.public_id,
        automationRunStartedAt: message.automation_run_started_at,
      },
      lane: 'slow',
      channel: 'private_reply',
      countGroup: 'open',
      hourLimit: 600,
      personHourLimit: null,
      monthLimit,
    });
  }

  async function monthUsed(): Promise<number> {
    const [row] = await operatorQuery<{ used: number }[]>`
      SELECT COALESCE(sum(count), 0)::int AS used FROM app.message_month_counts
      WHERE organization_id = ${organization.id}`;
    return Number(row?.used ?? 0);
  }

  function monthLockCalls(): number {
    return vi
      .mocked(acquireResourceQuotaLock)
      .mock.calls.filter(
        ([options]) => options.namespace === RESOURCE_QUOTA_LOCK_NAMESPACE.MESSAGE_MONTH_LIMIT,
      ).length;
  }

  beforeEach(async () => {
    await cleanupDatabase();
    vi.mocked(acquireResourceQuotaLock).mockClear();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    messages = [];
    for (let index = 0; index < ACCOUNT_COUNT; index += 1) {
      const account = await insertInstagramAccount({ organizationId: organization.id });
      await insertLanes({
        organizationId: organization.id,
        channelAccountId: account.channel_account_id,
      });
      const contact = await insertContact({
        organizationId: organization.id,
        instagramAccountId: account.id,
        last_direct_message_received_at: new Date(),
      });
      const automation = await insertAutomation({
        organizationId: organization.id,
        channelAccountId: account.channel_account_id,
        status: 'live',
      });
      const run = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
      });
      messages.push(
        await insertInstagramOutgoingMessage({
          run,
          channelAccountId: account.channel_account_id,
          message_type: 'opening_message',
          message_number: null,
          lane: 'slow',
          channel: 'private_reply',
          is_counted_as_direct_message: true,
          status: 'waiting',
          reason: null,
        }),
      );
    }
    gate = new InstagramSendGateService({
      laneService: new InstagramSendLaneService(
        new InstagramSendLaneRepository(),
        new InstagramSendStopRepository(),
      ),
      redis: null,
    });
  });

  it('one place left: claims of every account at once — exactly one passes, the month ends at its limit', async () => {
    const monthLimit = 50;
    await setMonthCount({ organizationId: organization.id, count: monthLimit - 1 });

    const claims = await Promise.all(messages.map((message) => claim(message, monthLimit)));

    expect(claims.filter((result) => result.kind === 'claimed')).toHaveLength(1);
    expect(claims.filter((result) => result.kind === 'refused')).toEqual(
      Array.from({ length: ACCOUNT_COUNT - 1 }, () => ({ kind: 'refused', reason: 'month_limit' })),
    );
    expect(await monthUsed()).toBe(monthLimit);
    // Every claim was near the limit, so each took the organization's month lock.
    expect(monthLockCalls()).toBe(ACCOUNT_COUNT);
  });

  it('two places left: claims of every account at once — exactly two pass', async () => {
    const monthLimit = 50;
    await setMonthCount({ organizationId: organization.id, count: monthLimit - 2 });

    const claims = await Promise.all(messages.map((message) => claim(message, monthLimit)));

    expect(claims.filter((result) => result.kind === 'claimed')).toHaveLength(2);
    expect(await monthUsed()).toBe(monthLimit);
  });

  it('far from the limit the claims take no month lock and all pass', async () => {
    const monthLimit = 1000;
    await setMonthCount({ organizationId: organization.id, count: 10 });

    const claims = await Promise.all(messages.map((message) => claim(message, monthLimit)));

    expect(claims.every((result) => result.kind === 'claimed')).toBe(true);
    expect(await monthUsed()).toBe(10 + ACCOUNT_COUNT);
    expect(monthLockCalls()).toBe(0);
  });

  it("the lock starts within the organization's lanes of the limit: a lane count of room is still lock-free", async () => {
    const lanes = ACCOUNT_COUNT * 4;
    const monthLimit = 100;
    await setMonthCount({ organizationId: organization.id, count: monthLimit - lanes });
    expect((await claim(messages[0]!, monthLimit)).kind).toBe('claimed');
    expect(monthLockCalls()).toBe(0);
    // One more makes the room smaller than the lanes: the next claim locks.
    expect((await claim(messages[1]!, monthLimit)).kind).toBe('claimed');
    expect(monthLockCalls()).toBe(1);
  });

  it('a message with no month limit or not counted never locks', async () => {
    await setMonthCount({ organizationId: organization.id, count: 999_999 });
    const claimed = await gate.claimSend({
      scope: scope(),
      key: {
        organizationId: organization.id,
        publicId: messages[0]!.public_id,
        automationRunStartedAt: messages[0]!.automation_run_started_at,
      },
      lane: 'slow',
      channel: 'private_reply',
      countGroup: 'open',
      hourLimit: 600,
      personHourLimit: null,
      monthLimit: null,
    });
    expect(claimed.kind).toBe('claimed');
    expect(monthLockCalls()).toBe(0);
  });
});
