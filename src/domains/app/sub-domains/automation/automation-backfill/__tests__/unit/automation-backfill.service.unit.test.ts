import { describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { ConflictError, ForbiddenError, NotFoundError } from '@/shared/errors/index.js';
import type { ChannelFeatureCheckResult } from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import type { AutomationWithAccountRow } from '@/domains/app/sub-domains/automation/automation.repository.js';
import type {
  AutomationBackfillRepository,
  AutomationBackfillRow,
} from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.repository.js';
import {
  AutomationBackfillService,
  type AutomationBackfillAutomationReader,
  type AutomationBackfillFeaturePort,
} from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.service.js';
import type { AutomationBackfillReadQueue } from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.types.js';

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // The unit lane has no Postgres: the unit of work runs the callback directly.
    withAppDatabaseContext: vi.fn(
      async ({ callback }: { callback: (databaseHandle: unknown) => Promise<unknown> }) =>
        callback({}),
    ),
  };
});

/**
 * Route 38's decisions (feat-instagram-dm-sending routes-final § 4.C, AU31) with the repositories,
 * the feature check and the organization service faked: the feature check before the status and
 * kind checks, the race loser of the open index mapped to `409 automation_backfill_in_progress`, and
 * the read job enqueued (when wired — ROUTE row R41) with the account's and the read's ids. The rows
 * themselves are in the integration suite.
 */

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: ORGANIZATION_PUBLIC_ID });
const TEAM = { id: 7, public_id: ORGANIZATION_PUBLIC_ID, type: 'TEAM' };
const AUTOMATION = {
  id: 12,
  public_id: 'aut_m4q8x2k7p9r3t1v5a1b2c',
  organization_id: TEAM.id,
  channel_account_id: 5,
  channel_account_public_id: 'cha_k7x9m2pqr4w8n1v3a1b2c',
  status: 'live',
  trigger_type: 'comment',
} as unknown as AutomationWithAccountRow;
const QUEUED_ROW: AutomationBackfillRow = {
  id: 41,
  public_id: 'abf_q7w2e9r4t1y6u3i8a1b2c',
  organization_id: TEAM.id,
  channel_account_id: 5,
  automation_id: 12,
  days: 3,
  status: 'queued',
  posts_read: 0,
  found: 0,
  matched: 0,
  queued_count: 0,
  fail_reason: null,
  last_error: null,
  requested_by_user_id: 3,
  started_at: null,
  done_at: null,
  created_at: new Date('2026-11-21T09:00:00.000Z'),
  updated_at: new Date('2026-11-21T09:00:00.000Z'),
};

function build({
  automation = AUTOMATION,
  feature = { isAllowed: true } as ChannelFeatureCheckResult,
  insert = async () => QUEUED_ROW,
  readQueue,
}: {
  automation?: AutomationWithAccountRow | null;
  feature?: ChannelFeatureCheckResult;
  insert?: () => Promise<AutomationBackfillRow>;
  readQueue?: AutomationBackfillReadQueue;
} = {}) {
  const repository = {
    findOpenByAutomation: vi.fn(async () => null),
    findByPublicId: vi.fn(async () => null),
    insertQueued: vi.fn(insert),
  };
  const automationReader = {
    lockLiveByPublicId: vi.fn(async () => automation),
    findLiveByPublicId: vi.fn(async () => automation),
  };
  const featurePort = { canChannelAccountUseFeature: vi.fn(async () => feature) };
  const organizationService = {
    requireOrganizationByPublicId: vi.fn(async () => TEAM),
    resolveUserInternalIdByPublicId: vi.fn(async () => 3),
    resolveUserPublicIdByInternalId: vi.fn(async () => 'usr_a1b2c3d4e5f6g7h8i9j0k'),
  };
  const service = new AutomationBackfillService(
    repository as unknown as AutomationBackfillRepository,
    automationReader as unknown as AutomationBackfillAutomationReader,
    featurePort as unknown as AutomationBackfillFeaturePort,
    organizationService as unknown as OrganizationService,
    readQueue,
  );
  return { service, repository, featurePort };
}

const startInput = {
  scope,
  automationPublicId: AUTOMATION.public_id,
  days: 3,
  requestedByUserPublicId: 'usr_a1b2c3d4e5f6g7h8i9j0k',
};

describe('AutomationBackfillService.startAutomationBackfill', () => {
  it('asks the feature check for past_comments on the automation’s account before its status', async () => {
    const { service, featurePort, repository } = build({
      automation: { ...AUTOMATION, status: 'paused' } as AutomationWithAccountRow,
      feature: { isAllowed: false, reason: 'plan_lacks_feature' },
    });
    await expect(service.startAutomationBackfill(startInput)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(featurePort.canChannelAccountUseFeature).toHaveBeenCalledWith(
      expect.objectContaining({ channelAccountId: 5, feature: 'past_comments' }),
    );
    expect(repository.insertQueued).not.toHaveBeenCalled();
  });

  it('answers 404 automation_not_found before any feature check', async () => {
    const { service, featurePort } = build({ automation: null });
    await expect(service.startAutomationBackfill(startInput)).rejects.toBeInstanceOf(NotFoundError);
    expect(featurePort.canChannelAccountUseFeature).not.toHaveBeenCalled();
  });

  it('maps the open index’s race loser to 409 automation_backfill_in_progress', async () => {
    const raceLoser = Object.assign(new Error('duplicate key'), {
      cause: { code: '23505', constraint: 'idx_automation_backfills_open' },
    });
    const { service } = build({
      insert: async () => {
        throw raceLoser;
      },
    });
    const refusal = await service.startAutomationBackfill(startInput).catch((error) => error);
    expect(refusal).toBeInstanceOf(ConflictError);
    expect((refusal as ConflictError & { reason?: string }).reason).toBe(
      'automation_backfill_in_progress',
    );
  });

  it('enqueues the account’s read with the account’s and the read’s public ids when wired', async () => {
    const readQueue = { enqueueAutomationBackfillRead: vi.fn(async () => undefined) };
    const { service } = build({ readQueue });
    const output = await service.startAutomationBackfill(startInput);
    expect(output).toMatchObject({ id: QUEUED_ROW.public_id, status: 'queued', days: 3 });
    expect(readQueue.enqueueAutomationBackfillRead).toHaveBeenCalledWith({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: AUTOMATION.channel_account_public_id,
      automationBackfillPublicId: QUEUED_ROW.public_id,
    });
  });
});
