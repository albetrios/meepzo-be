import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelSendingPort } from '@/domains/app/app.channel-ports.js';
import type { ChannelAccountPlanAccessService } from '@/domains/app/sub-domains/channel-account/channel-account.service.js';
import type { AutomationRunChannelAccount } from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import type { ContactRow } from '@/domains/app/sub-domains/contact/contact.repository.js';
import type { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import type { AutomationCountService } from '@/domains/app/sub-domains/automation/automation-count.service.js';
import type { AutomationReplyStateService } from '@/domains/app/sub-domains/automation/automation-reply-state.service.js';
import { AUTOMATION_TAG_CHAIN_MAX } from '@/domains/app/sub-domains/automation/automation-run/automation-run.constants.js';
import type { AutomationEndedRun } from '@/domains/app/sub-domains/automation/automation-run/automation-run.repository.js';
import { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import type { AutomationTagRunInput } from '@/domains/app/sub-domains/automation/automation-run/automation-run.types.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

const { runs, runEvents, commentLogs, openKeys, automations, retentionOpenKeys } = vi.hoisted(
  () => ({
    runs: {
      cancelOpenRunsOfAutomation: vi.fn(),
      cancelOpenRunsOfContact: vi.fn(),
      cancelExpiredWaitingRuns: vi.fn(),
      hasRunMovedByEvent: vi.fn(),
    },
    runEvents: { insertMany: vi.fn() },
    commentLogs: { markRunsCancelled: vi.fn(), eraseContactCopies: vi.fn() },
    openKeys: { deleteForRuns: vi.fn(), listAutomationIdsOfContact: vi.fn() },
    automations: {
      lockForRunChanges: vi.fn(),
      findByIdIncludingDeleted: vi.fn(),
      listRunCandidates: vi.fn(),
    },
    retentionOpenKeys: { deleteKeysOfEndedRuns: vi.fn() },
  }),
);

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

// Every repository the engine binds is faked; their SQL is in the `*.repository.db.unit.test.ts`
// files and the engine's flows in `automation-run.service.db.unit.test.ts`.
vi.mock('@/domains/app/sub-domains/automation/automation-run/automation-run.repository.js', () => ({
  AutomationRunRepository: vi.fn(function fakeRepository() {
    return runs;
  }),
  createWorkerAutomationRunRepository: vi.fn(function fakeRepository() {
    return runs;
  }),
}));
vi.mock(
  '@/domains/app/sub-domains/automation/automation-run/automation-run-event.repository.js',
  () => ({
    AutomationRunEventRepository: vi.fn(function fakeRepository() {
      return runEvents;
    }),
    createWorkerAutomationRunEventRepository: vi.fn(function fakeRepository() {
      return runEvents;
    }),
  }),
);
vi.mock(
  '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.repository.js',
  () => ({
    AutomationCommentLogRepository: vi.fn(function fakeRepository() {
      return commentLogs;
    }),
    createWorkerAutomationCommentLogRepository: vi.fn(function fakeRepository() {
      return commentLogs;
    }),
  }),
);
vi.mock(
  '@/domains/app/sub-domains/automation/automation-run/automation-run-open-key.repository.js',
  () => ({
    AutomationRunOpenKeyRepository: vi.fn(function fakeRepository() {
      return openKeys;
    }),
    createWorkerAutomationRunOpenKeyRepository: vi.fn(function fakeRepository() {
      return openKeys;
    }),
    createRetentionAutomationRunOpenKeyRepository: vi.fn(function fakeRepository() {
      return retentionOpenKeys;
    }),
  }),
);
vi.mock('@/domains/app/sub-domains/automation/automation.repository.js', () => ({
  AutomationRepository: vi.fn(function fakeRepository() {
    return automations;
  }),
  createWorkerAutomationRepository: vi.fn(function fakeRepository() {
    return automations;
  }),
}));

/**
 * The run engine's own decisions with every repository, the channel account, contact and plan
 * services and the channel's sending port faked (routes-final § 4.B — AU21–AU29, AU34, AU35): an
 * event for an unavailable account or another account's contact does no work, a channel with no
 * wired port fails loudly, an erased contact or a too-long tag chain is held back, and the bulk
 * cancels (automation delete, contact erase and pause, the 7-day wait) end runs with their keys,
 * events, logs and the port's waiting-message cancel. The engine's flows over Postgres are in
 * `automation-run.service.db.unit.test.ts`.
 */

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const ACCOUNT_PUBLIC_ID = 'cha_k7x9m2pqr4w8n1v3a1b2c';
const ORGANIZATION_ID = 7;
const ACCOUNT_ID = 11;
const CONTACT_ID = 21;
const STARTED_AT = new Date('2026-11-20T09:00:00.000Z');
const scope: OrganizationPrincipalDatabaseScope = PRINCIPAL_SCOPE.VERIFIED({
  organizationPublicId: ORGANIZATION_PUBLIC_ID,
});

function accountRow(
  overrides: Partial<AutomationRunChannelAccount> = {},
): AutomationRunChannelAccount {
  return {
    organizationId: ORGANIZATION_ID,
    id: ACCOUNT_ID,
    public_id: ACCOUNT_PUBLIC_ID,
    channel: 'instagram',
    connection_status: 'connected',
    is_automation_enabled: true,
    time_zone: 'UTC',
    is_comment_reply_trigger_enabled: true,
    is_once_per_person_per_post_enabled: true,
    ...overrides,
  };
}

function contactRow(overrides: Partial<ContactRow> = {}): ContactRow {
  return { id: CONTACT_ID, channel_account_id: ACCOUNT_ID, ...overrides } as ContactRow;
}

function tagInput(overrides: Partial<AutomationTagRunInput> = {}): AutomationTagRunInput {
  return {
    scope,
    channelAccountPublicId: ACCOUNT_PUBLIC_ID,
    contact: contactRow(),
    event: {
      eventKey: 'tag:vip:5',
      eventId: '5',
      occurredAt: STARTED_AT,
      isLastAttempt: false,
    },
    change: 'added',
    tag: 'vip',
    tagEventId: 5,
    chainNumber: 0,
    sourceAutomationId: null,
    ...overrides,
  };
}

function endedRun(id: number, automationId = 3): AutomationEndedRun {
  return { id, started_at: STARTED_AT, automation_id: automationId, contact_id: CONTACT_ID };
}

function createHarness() {
  const readAutomationRunAccount = vi.fn(
    async (): Promise<AutomationRunChannelAccount | null> => accountRow(),
  );
  const lockLiveContact = vi.fn(async (): Promise<ContactRow | null> => contactRow());
  const getPlanAccess = vi.fn(async () => ({ features: { feature_switches: null } }));
  const port = {
    saveWaitingMessage: vi.fn(),
    cancelWaitingMessages: vi.fn(async () => 1),
    skipWaitingMessages: vi.fn(async () => 0),
  } as unknown as ChannelSendingPort;
  const service = new AutomationRunService({
    channelAccountService: { readAutomationRunAccount },
    contactService: { lockLiveContact } as unknown as ContactService,
    planAccessService: { getPlanAccess } as unknown as ChannelAccountPlanAccessService,
    countService: {} as AutomationCountService,
    replyStateService: {} as AutomationReplyStateService,
    sendingPorts: { instagram: port },
  });
  return { service, readAutomationRunAccount, lockLiveContact, getPlanAccess, port };
}

describe('AutomationRunService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openKeys.listAutomationIdsOfContact.mockResolvedValue([]);
    runs.hasRunMovedByEvent.mockResolvedValue(false);
    automations.listRunCandidates.mockResolvedValue([]);
  });

  describe('an event unit (AU34)', () => {
    it.each([
      ['an unknown account', null],
      // An `error` account still decides — its messages wait in its stopped lanes (WH3, R38).
      ['a revoked account', accountRow({ connection_status: 'revoked' })],
    ])('answers account_unavailable for %s, with no unit of work', async (_label, account) => {
      const harness = createHarness();
      harness.readAutomationRunAccount.mockResolvedValueOnce(account);

      const result = await harness.service.startTagRun(tagInput());

      expect(result).toEqual({
        outcome: 'account_unavailable',
        runPublicIds: [],
        failedErrorType: null,
      });
      expect(withAppDatabaseContext).not.toHaveBeenCalled();
      expect(harness.getPlanAccess).not.toHaveBeenCalled();
    });

    it("answers account_unavailable for another account's contact", async () => {
      const harness = createHarness();

      const result = await harness.service.startTagRun(
        tagInput({ contact: contactRow({ channel_account_id: ACCOUNT_ID + 1 }) }),
      );

      expect(result.outcome).toBe('account_unavailable');
      expect(harness.lockLiveContact).not.toHaveBeenCalled();
    });

    it('fails loudly when no sending port is wired for the channel', async () => {
      const harness = createHarness();
      const service = new AutomationRunService({
        channelAccountService: { readAutomationRunAccount: harness.readAutomationRunAccount },
        contactService: {} as ContactService,
        planAccessService: {} as ChannelAccountPlanAccessService,
        countService: {} as AutomationCountService,
        replyStateService: {} as AutomationReplyStateService,
        sendingPorts: {},
      });

      await expect(service.startTagRun(tagInput())).rejects.toThrow(
        'no sending port wired for instagram',
      );
    });

    it('holds back an erased contact (CT9) before any automation lock', async () => {
      const harness = createHarness();
      harness.lockLiveContact.mockResolvedValueOnce(null);

      const result = await harness.service.startTagRun(tagInput());

      expect(result.outcome).toBe('ignored');
      expect(harness.getPlanAccess).toHaveBeenCalledWith({
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
      });
      expect(automations.lockForRunChanges).not.toHaveBeenCalled();
    });

    it('locks the automations of her open runs, then ignores a tag chain at its limit (D45)', async () => {
      const harness = createHarness();
      openKeys.listAutomationIdsOfContact.mockResolvedValueOnce([3, 4]);

      const result = await harness.service.startTagRun(
        tagInput({ chainNumber: AUTOMATION_TAG_CHAIN_MAX }),
      );

      expect(result.outcome).toBe('ignored');
      expect(automations.lockForRunChanges).toHaveBeenCalledWith({
        organizationId: ORGANIZATION_ID,
        automationIds: [3, 4],
      });
      expect(runs.hasRunMovedByEvent).not.toHaveBeenCalled();
    });

    it('answers already_handled for a retried event, and nothing_matched with no candidate', async () => {
      const harness = createHarness();
      runs.hasRunMovedByEvent.mockResolvedValueOnce(true);

      expect((await harness.service.startTagRun(tagInput())).outcome).toBe('already_handled');
      expect(automations.listRunCandidates).not.toHaveBeenCalled();

      expect((await harness.service.startTagRun(tagInput())).outcome).toBe('nothing_matched');
      expect(automations.listRunCandidates).toHaveBeenCalledWith({
        organizationId: ORGANIZATION_ID,
        channelAccountId: ACCOUNT_ID,
      });
    });
  });

  describe('the bulk cancels (AU29)', () => {
    it('an automation delete cancels its open runs with their keys, events and logs', async () => {
      const { service } = createHarness();
      runs.cancelOpenRunsOfAutomation.mockResolvedValueOnce([endedRun(1), endedRun(2)]);

      const cancelled = await service.cancelAutomationOpenRuns({
        organizationId: ORGANIZATION_ID,
        automationId: 3,
      });

      expect(cancelled).toBe(2);
      expect(openKeys.deleteForRuns).toHaveBeenCalledWith({
        organizationId: ORGANIZATION_ID,
        runs: [endedRun(1), endedRun(2)],
      });
      expect(runEvents.insertMany).toHaveBeenCalledWith([
        expect.objectContaining({ runId: 1, eventType: 'status_changed', status: 'cancelled' }),
        expect.objectContaining({ runId: 2, runStartedAt: STARTED_AT, status: 'cancelled' }),
      ]);
      expect(commentLogs.markRunsCancelled).toHaveBeenCalledWith({
        organizationId: ORGANIZATION_ID,
        runIds: [1, 2],
      });
    });

    it('writes nothing more when no run was open', async () => {
      const { service } = createHarness();
      runs.cancelOpenRunsOfAutomation.mockResolvedValueOnce([]);

      expect(
        await service.cancelAutomationOpenRuns({
          organizationId: ORGANIZATION_ID,
          automationId: 3,
        }),
      ).toBe(0);
      expect(openKeys.deleteForRuns).not.toHaveBeenCalled();
      expect(runEvents.insertMany).not.toHaveBeenCalled();
    });

    it("a contact erase locks her runs' automations, cancels them and clears her log copies", async () => {
      const { service } = createHarness();
      openKeys.listAutomationIdsOfContact.mockResolvedValueOnce([3]);
      runs.cancelOpenRunsOfContact.mockResolvedValueOnce([endedRun(9)]);

      await service.eraseContactRunCopies({
        organizationId: ORGANIZATION_ID,
        contactId: CONTACT_ID,
        instagramUserId: '17841400000000021',
      });

      expect(automations.lockForRunChanges).toHaveBeenCalledWith({
        organizationId: ORGANIZATION_ID,
        automationIds: [3],
      });
      expect(runs.cancelOpenRunsOfContact).toHaveBeenCalledWith({
        organizationId: ORGANIZATION_ID,
        contactId: CONTACT_ID,
        reason: 'contact_deleted',
      });
      expect(commentLogs.eraseContactCopies).toHaveBeenCalledWith({
        organizationId: ORGANIZATION_ID,
        contactId: CONTACT_ID,
      });
    });

    it('a contact pause cancels with its own reason and never erases her copies', async () => {
      const { service } = createHarness();
      runs.cancelOpenRunsOfContact.mockResolvedValueOnce([]);

      await service.cancelContactOpenRuns({
        organizationId: ORGANIZATION_ID,
        contactId: CONTACT_ID,
        reason: 'opted_out',
        databaseHandle: {} as WorkerDatabaseHandle,
      });

      expect(runs.cancelOpenRunsOfContact).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'opted_out' }),
      );
      expect(commentLogs.eraseContactCopies).not.toHaveBeenCalled();
    });

    it("the 7-day wait cancels each run's waiting messages through its channel's port (WC-45)", async () => {
      const { service, port } = createHarness();
      const databaseHandle = {} as WorkerDatabaseHandle;
      runs.cancelExpiredWaitingRuns.mockResolvedValueOnce([endedRun(5, 3), endedRun(6, 4)]);
      automations.findByIdIncludingDeleted
        .mockResolvedValueOnce({ id: 3, channel: 'instagram' })
        .mockResolvedValueOnce(null);
      const cutoff = new Date('2026-11-13T09:00:00.000Z');

      const cancelled = await service.cancelExpiredWaitingRuns({
        databaseHandle,
        organizationId: ORGANIZATION_ID,
        runIds: [5, 6],
        waitingSinceBefore: cutoff,
      });

      expect(cancelled).toBe(2);
      expect(runs.cancelExpiredWaitingRuns).toHaveBeenCalledWith({
        organizationId: ORGANIZATION_ID,
        runIds: [5, 6],
        waitingSinceBefore: cutoff,
      });
      // The purged automation's run has no channel left to reach: only run 5 goes to the port.
      expect(port.cancelWaitingMessages).toHaveBeenCalledTimes(1);
      expect(port.cancelWaitingMessages).toHaveBeenCalledWith({
        databaseHandle,
        organizationId: ORGANIZATION_ID,
        by: 'run',
        id: 5,
        reason: 'wait_expired',
      });
    });
  });

  it("the open keys' repair deletes through the retention handle (WC-67)", async () => {
    const { service } = createHarness();
    retentionOpenKeys.deleteKeysOfEndedRuns.mockResolvedValueOnce(4);

    expect(
      await service.repairOpenRunKeys({ databaseHandle: {} as WorkerDatabaseHandle, limit: 500 }),
    ).toBe(4);
    expect(retentionOpenKeys.deleteKeysOfEndedRuns).toHaveBeenCalledWith({ limit: 500 });
  });
});
