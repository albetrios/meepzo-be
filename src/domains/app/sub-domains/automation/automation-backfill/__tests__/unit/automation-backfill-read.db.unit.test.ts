import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  completeAutomationSteps,
  insertAutomation,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationBackfill,
  readAutomationBackfillRows,
} from '@/domains/app/sub-domains/automation/automation-backfill/__tests__/factories/automation-backfill.factory.js';
import { AutomationBackfillRepository } from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.repository.js';
import {
  type AutomationBackfillAutomationReader,
  type AutomationBackfillFeaturePort,
  AutomationBackfillService,
} from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.service.js';
import type { AutomationBackfillRead } from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.types.js';
import { runAutomationBackfillWatchJob } from '@/domains/app/sub-domains/automation/automation-backfill/workers/automation-backfill-watch.processor.js';
import { runAutomationNextPostLinkingSweepJob } from '@/domains/app/sub-domains/automation/workers/automation-next-post-linking.processor.js';
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The past-comments read's state against the database (feat-instagram-dm-sending § 4.C AU32,
 * AUC12; worker-changes WC-41; ROUTE row R41 — AC-8.4): one read at a time per account (the next
 * queued one starts when none runs), a stuck read started again from zero, a resumed job stopped
 * once its read was started again, the counters and the end, the feature check's refusal and the
 * move down's `plan_feature_off`, the 10-minute watch's read across organizations, and the "next
 * post" linking sweep's scan (WC-43, AC-6.23). Every statement runs in the organization's own context
 * or the retention scope, so the suite also holds under `pnpm test:rls-role`.
 */
describe('Past-comments read state and the two sweeps (database)', () => {
  let organization: { id: number; public_id: string };
  let account: { id: number; public_id: string; channel_account_id: number };
  let featureAnswer: Awaited<
    ReturnType<AutomationBackfillFeaturePort['canChannelAccountUseFeature']>
  >;
  let service: AutomationBackfillService;

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    featureAnswer = { isAllowed: true };
    service = new AutomationBackfillService(
      new AutomationBackfillRepository(),
      {} as AutomationBackfillAutomationReader,
      { canChannelAccountUseFeature: async () => featureAnswer },
      {} as OrganizationService,
    );
  });

  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id });
  const channelAccount = () => ({
    organizationId: organization.id,
    channelAccountId: account.channel_account_id,
  });

  async function liveCommentAutomation(overrides: Record<string, unknown> = {}) {
    return insertAutomation({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
      status: 'live',
      steps: completeAutomationSteps(),
      keywords: ['price'],
      ...overrides,
    });
  }

  async function queuedRead(automationId: number, createdAt = new Date()) {
    return insertAutomationBackfill({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
      automationId,
      created_at: createdAt,
      updated_at: createdAt,
    });
  }

  async function begin(
    resume: { automationBackfillPublicId: string; startedAt: Date } | null = null,
  ) {
    return service.beginAutomationBackfillRead({
      scope: scope(),
      channelAccount: channelAccount(),
      resume,
    });
  }

  async function startedRead(): Promise<AutomationBackfillRead> {
    const begun = await begin();
    if (begun.kind !== 'reading') throw new Error(`expected a read, got ${begun.kind}`);
    return begun.read;
  }

  it('starts the account oldest queued read, then leaves a second job idle while it reads (AU32, AC-8.4)', async () => {
    const first = await liveCommentAutomation();
    const second = await liveCommentAutomation({
      target_scope: 'specific',
      target_instagram_media_id: '17900000000000001',
    });
    const older = await queuedRead(first.id, new Date(Date.now() - 5 * MILLISECONDS_PER_MINUTE));
    const newer = await queuedRead(second.id);

    const read = await startedRead();
    expect(read.automationBackfillPublicId).toBe(older.public_id);
    expect(read.days).toBe(3);
    expect(read.target).toMatchObject({
      automationPublicId: first.public_id,
      status: 'live',
      trigger_type: 'comment',
      target_scope: 'any',
      keywords: ['price'],
    });
    expect(await begin()).toEqual({ kind: 'busy' });
    expect((await readAutomationBackfillRows(second.id))[0]).toMatchObject({
      public_id: newer.public_id,
      status: 'queued',
      started_at: null,
    });

    // Its numbers move as it reads, then it ends `done` and the next one starts.
    expect(
      await service.recordAutomationBackfillProgress({
        scope: scope(),
        read,
        postsRead: 1,
        found: 4,
        matched: 2,
        queuedCount: 1,
      }),
    ).toBe(true);
    expect(
      await service.finishAutomationBackfillRead({ scope: scope(), read, failure: null }),
    ).toBe(true);
    expect((await readAutomationBackfillRows(first.id))[0]).toMatchObject({
      status: 'done',
      posts_read: 1,
      found: 4,
      matched: 2,
      queued_count: 1,
      fail_reason: null,
      done_at: expect.any(Date),
    });
    expect((await startedRead()).automationBackfillPublicId).toBe(newer.public_id);
    expect(await begin()).toEqual({ kind: 'busy' });
  });

  it('answers none with nothing queued and keeps a resumed job to its own read and start', async () => {
    expect(await begin()).toEqual({ kind: 'none' });
    const automation = await liveCommentAutomation();
    await queuedRead(automation.id);
    const read = await startedRead();

    expect(
      await begin({
        automationBackfillPublicId: read.automationBackfillPublicId,
        startedAt: read.startedAt,
      }),
    ).toMatchObject({
      kind: 'reading',
      read: { automationBackfillPublicId: read.automationBackfillPublicId },
    });
    expect(
      await begin({
        automationBackfillPublicId: read.automationBackfillPublicId,
        startedAt: new Date(read.startedAt.getTime() - 1000),
      }),
    ).toEqual({ kind: 'ended' });
  });

  it('starts a read with no page for 30 minutes again from zero; the old job writes nothing more (AU32 — the watch)', async () => {
    const automation = await liveCommentAutomation();
    await queuedRead(automation.id);
    const stale = await startedRead();
    await service.recordAutomationBackfillProgress({
      scope: scope(),
      read: stale,
      postsRead: 2,
      found: 9,
      matched: 3,
      queuedCount: 3,
    });
    // Not stuck yet: a fresh page.
    expect(await begin()).toEqual({ kind: 'busy' });
    await operatorQuery`
      UPDATE app.automation_backfills
      SET updated_at = now() - interval '31 minutes', created_at = now() - interval '40 minutes',
          started_at = now() - interval '40 minutes'
      WHERE automation_id = ${automation.id}`;
    const staleStartedAt = (await readAutomationBackfillRows(automation.id))[0]?.started_at as Date;

    const restarted = await startedRead();
    expect(restarted.automationBackfillPublicId).toBe(stale.automationBackfillPublicId);
    expect(restarted.startedAt.getTime()).toBeGreaterThan(staleStartedAt.getTime());
    expect((await readAutomationBackfillRows(automation.id))[0]).toMatchObject({
      status: 'reading',
      posts_read: 0,
      found: 0,
      matched: 0,
      queued_count: 0,
    });
    const oldJob = { ...stale, startedAt: staleStartedAt };
    expect(
      await service.recordAutomationBackfillProgress({
        scope: scope(),
        read: oldJob,
        postsRead: 1,
        found: 1,
        matched: 1,
        queuedCount: 1,
      }),
    ).toBe(false);
    expect(
      await service.finishAutomationBackfillRead({ scope: scope(), read: oldJob, failure: null }),
    ).toBe(false);
    expect((await readAutomationBackfillRows(automation.id))[0]?.status).toBe('reading');
  });

  it('ends a read the plan no longer allows `plan_feature_off`, another refusal `meta_error` with its code (P50, P83)', async () => {
    const automation = await liveCommentAutomation();
    await queuedRead(automation.id);
    featureAnswer = { isAllowed: false, reason: 'plan_lacks_feature' };
    expect(await begin()).toEqual({ kind: 'refused', failReason: 'plan_feature_off' });
    expect((await readAutomationBackfillRows(automation.id))[0]).toMatchObject({
      status: 'failed',
      fail_reason: 'plan_feature_off',
      last_error: null,
    });

    await queuedRead(automation.id);
    featureAnswer = { isAllowed: false, reason: 'permission_not_granted' };
    expect(await begin()).toEqual({ kind: 'refused', failReason: 'meta_error' });
    expect((await readAutomationBackfillRows(automation.id))[1]).toMatchObject({
      status: 'failed',
      fail_reason: 'meta_error',
      last_error: 'feature:permission_not_granted',
    });
  });

  it('a move down ends the open reads `failed` · `plan_feature_off`; a running job then stops (WC-38, AC-8.7 groundwork)', async () => {
    const first = await liveCommentAutomation();
    const second = await liveCommentAutomation();
    const done = await liveCommentAutomation();
    await queuedRead(first.id);
    await queuedRead(second.id);
    await insertAutomationBackfill({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
      automationId: done.id,
      status: 'done',
    });
    const running = await startedRead();

    const failed = await service.failAutomationBackfillsForPlanFeatureOff({
      scope: scope(),
      organizationId: organization.id,
    });
    expect(failed).toHaveLength(2);
    for (const automation of [first, second]) {
      expect((await readAutomationBackfillRows(automation.id))[0]).toMatchObject({
        status: 'failed',
        fail_reason: 'plan_feature_off',
      });
    }
    expect((await readAutomationBackfillRows(done.id))[0]?.status).toBe('done');
    expect(
      await service.recordAutomationBackfillProgress({
        scope: scope(),
        read: running,
        postsRead: 1,
        found: 0,
        matched: 0,
        queuedCount: 0,
      }),
    ).toBe(false);
  });

  it('the watch wakes each account with a stuck read once, across organizations, and not a fresh one (AU32)', async () => {
    const automation = await liveCommentAutomation();
    const otherOrganization = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    const otherAccount = await insertInstagramAccount({ organizationId: otherOrganization.id });
    const otherAutomation = await insertAutomation({
      organizationId: otherOrganization.id,
      channelAccountId: otherAccount.channel_account_id,
      status: 'live',
      steps: completeAutomationSteps(),
    });
    const freshAccount = await insertInstagramAccount({ organizationId: organization.id });
    const freshAutomation = await insertAutomation({
      organizationId: organization.id,
      channelAccountId: freshAccount.channel_account_id,
      status: 'live',
      steps: completeAutomationSteps(),
    });
    const longAgo = new Date(Date.now() - 45 * MILLISECONDS_PER_MINUTE);
    // A reading read with no page for 45 minutes, and a queued one of the same account.
    await insertAutomationBackfill({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
      automationId: automation.id,
      status: 'reading',
      started_at: longAgo,
      created_at: longAgo,
      updated_at: longAgo,
    });
    const secondAutomation = await liveCommentAutomation();
    await queuedRead(secondAutomation.id, longAgo);
    // Another organization's queued read whose job was lost 15 minutes ago.
    await insertAutomationBackfill({
      organizationId: otherOrganization.id,
      channelAccountId: otherAccount.channel_account_id,
      automationId: otherAutomation.id,
      created_at: new Date(Date.now() - 15 * MILLISECONDS_PER_MINUTE),
      updated_at: new Date(Date.now() - 15 * MILLISECONDS_PER_MINUTE),
    });
    // A queued read of 2 minutes — its job is still on its way.
    await insertAutomationBackfill({
      organizationId: organization.id,
      channelAccountId: freshAccount.channel_account_id,
      automationId: freshAutomation.id,
      created_at: new Date(Date.now() - 2 * MILLISECONDS_PER_MINUTE),
      updated_at: new Date(Date.now() - 2 * MILLISECONDS_PER_MINUTE),
    });
    const enqueueAutomationBackfillRead = vi.fn(
      async (_input: Record<string, unknown>) => undefined,
    );

    const result = await runAutomationBackfillWatchJob({
      readQueue: { enqueueAutomationBackfillRead },
    });

    expect(result).toEqual({ stuckAccountCount: 2, failedWakeCount: 0 });
    expect(enqueueAutomationBackfillRead.mock.calls.map(([input]) => input)).toEqual(
      expect.arrayContaining([
        { organizationPublicId: organization.public_id, channelAccountPublicId: account.public_id },
        {
          organizationPublicId: otherOrganization.public_id,
          channelAccountPublicId: otherAccount.public_id,
        },
      ]),
    );
  });

  it('the linking sweep adds one task per connected account with a waiting "my next post" automation, from its oldest go-live (WC-43, AC-6.23)', async () => {
    const goLive = new Date(Date.now() - 3 * 24 * 60 * MILLISECONDS_PER_MINUTE);
    const nextPost = (overrides: Record<string, unknown>) =>
      insertAutomation({
        organizationId: organization.id,
        channelAccountId: account.channel_account_id,
        status: 'live',
        steps: completeAutomationSteps(),
        target_scope: 'next',
        next_post_status: 'waiting',
        ...overrides,
      });
    // Two waiting ones (no end date — P12: one went live long ago and still waits), a linked one,
    // a paused one and a deleted one.
    await nextPost({ target_starts_at: goLive });
    await nextPost({ target_starts_at: new Date() });
    await nextPost({
      target_starts_at: goLive,
      next_post_status: 'linked',
      target_instagram_media_id: '17900000000000009',
      next_post_linked_at: new Date(),
    });
    await nextPost({ target_starts_at: goLive, status: 'paused' });
    await nextPost({ target_starts_at: goLive, deleted_at: new Date() });
    const revoked = await insertInstagramAccount({
      organizationId: organization.id,
      connectionStatus: 'revoked',
    });
    await insertAutomation({
      organizationId: organization.id,
      channelAccountId: revoked.channel_account_id,
      status: 'live',
      steps: completeAutomationSteps(),
      target_scope: 'next',
      next_post_status: 'waiting',
      target_starts_at: goLive,
    });
    const enqueue = vi.fn(async () => undefined);

    const result = await runAutomationNextPostLinkingSweepJob({
      enqueueByChannel: { instagram: enqueue },
    });

    expect(result).toEqual({
      listedCount: 1,
      addedCount: 1,
      unsupportedChannelCount: 0,
      failedAddCount: 0,
    });
    expect(enqueue).toHaveBeenCalledWith({
      organizationPublicId: organization.public_id,
      channelAccountPublicId: account.public_id,
      postsSince: goLive,
    });
  });
});
