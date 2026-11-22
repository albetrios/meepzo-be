import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { InstagramApiError } from '@/infrastructure/social/instagram-error.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { InstagramAutomationAccountAccess } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import type { InstagramAccountSettingsRow } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import type { ContactRow } from '@/domains/app/sub-domains/contact/contact.repository.js';
import type { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import type { ContactCollectedValueResult } from '@/domains/app/sub-domains/contact/contact.types.js';
import type { AutomationRow } from '@/domains/app/sub-domains/automation/automation.repository.js';
import type {
  AutomationCommentLogInsertValues,
  AutomationCommentLogRow,
} from '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.repository.js';
import { createWorkerAutomationCommentLogRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.repository.js';
import type {
  AutomationPublicReplyDecision,
  AutomationPublicReplySafetyService,
} from '@/domains/app/sub-domains/automation/automation-run/automation-public-reply-safety.service.js';
import type { AutomationRunEventValues } from '@/domains/app/sub-domains/automation/automation-run/automation-run-event.repository.js';
import { createWorkerAutomationRunEventRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-run-event.repository.js';
import type {
  AutomationFollowReadResult,
  AutomationRunMessageService,
  AutomationSendResult,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run-message.service.js';
import type {
  AutomationRunInsertValues,
  AutomationRunRow,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run.repository.js';
import { createWorkerAutomationRunRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-run.repository.js';
import { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import type {
  AutomationQueuedEntry,
  AutomationRunEvent,
  AutomationRunHandlingResult,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run.types.js';

const { fakes, unitOfWork, loggerInfo, loggerWarn } = vi.hoisted(() => ({
  /** The fake repositories every factory and constructor below hands out. */
  fakes: {} as { runs: unknown; runEvents: unknown; commentLogs: unknown; automations: unknown },
  /** How many units of work are open — an Instagram call must see none — and each one's handle. */
  unitOfWork: { openCount: 0, handles: [] as unknown[] },
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // The unit lane has no Postgres: the unit of work runs the callback directly, counted open.
    withAppDatabaseContext: vi.fn(
      async ({ callback }: { callback: (databaseHandle: unknown) => Promise<unknown> }) => {
        unitOfWork.openCount += 1;
        const databaseHandle = { unitNumber: unitOfWork.handles.length };
        unitOfWork.handles.push(databaseHandle);
        try {
          return await callback(databaseHandle);
        } finally {
          unitOfWork.openCount -= 1;
        }
      },
    ),
  };
});

vi.mock('@/domains/app/sub-domains/automation/automation-run/automation-run.repository.js', () => ({
  AutomationRunRepository: vi.fn(function AutomationRunRepositoryMock() {
    return fakes.runs;
  }),
  createWorkerAutomationRunRepository: vi.fn(() => fakes.runs),
}));

vi.mock(
  '@/domains/app/sub-domains/automation/automation-run/automation-run-event.repository.js',
  () => ({
    AutomationRunEventRepository: vi.fn(function AutomationRunEventRepositoryMock() {
      return fakes.runEvents;
    }),
    createWorkerAutomationRunEventRepository: vi.fn(() => fakes.runEvents),
  }),
);

vi.mock(
  '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.repository.js',
  () => ({
    AutomationCommentLogRepository: vi.fn(function AutomationCommentLogRepositoryMock() {
      return fakes.commentLogs;
    }),
    createWorkerAutomationCommentLogRepository: vi.fn(() => fakes.commentLogs),
  }),
);

vi.mock('@/domains/app/sub-domains/automation/automation.repository.js', () => ({
  AutomationRepository: vi.fn(function AutomationRepositoryMock() {
    return fakes.automations;
  }),
  createWorkerAutomationRepository: vi.fn(() => fakes.automations),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { warn: loggerWarn, info: loggerInfo, error: vi.fn(), debug: vi.fn() },
}));

/**
 * The run engine's own decisions (routes-final § 3.B — AU12, AU14, AU16–AU21, AU25–AU27, AQ5, CT8,
 * CT9, D16, D18, D47, D48) with every repository kept in memory and the account, contact, message
 * and reply-safety services faked: which events it takes at all, that an erase wins, what AU17 holds
 * back, what it queues, when it asks again and what a retry still sends, how each send, public reply
 * and follow read that goes wrong is recorded, how a run waiting for a step now off goes on, and the
 * four hooks other callers run. Every unit of work locks the contact, then the automations of its
 * open runs, before any run, and every Instagram call is made with none open. The flows end to end
 * against Postgres are in `automation-run.service.db.unit.test.ts`, the locks on two connections in
 * `automation-run-lock-order.db.unit.test.ts`.
 */

const ORGANIZATION_ID = 7;
const ACCOUNT_ID = 3;
const OTHER_ACCOUNT_ID = 4;
const CONTACT_ID = 41;
const EMAIL_FIRST_ID = 16;
const ACCOUNT_PUBLIC_ID = generatePublicId('instagramAccount');
const ORGANIZATION_PUBLIC_ID = generatePublicId('organization');
const CONTACT_INSTAGRAM_ID = '17841455500000001';
const POST = '17900000000000001';
const COMMENT = '17950000000000001';
const STORY = '17910000000000001';
const REQUEST_ID = 'job-instagram-webhook';
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const scope: OrganizationPrincipalDatabaseScope = PRINCIPAL_SCOPE.JOB({
  organizationPublicId: ORGANIZATION_PUBLIC_ID,
});
const instagramAccount = { organizationId: ORGANIZATION_ID, instagramAccountId: ACCOUNT_ID };

/** The final message only, on a comment; every step off. */
function automationRow(overrides: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: 17,
    public_id: generatePublicId('automation'),
    organization_id: ORGANIZATION_ID,
    instagram_account_id: ACCOUNT_ID,
    name: 'Comment for the link',
    status: 'live',
    trigger_type: 'comment',
    target_scope: 'any',
    target_instagram_media_id: null,
    target_instagram_story_id: null,
    next_post_starts_at: null,
    next_post_ends_at: null,
    next_post_status: null,
    next_post_linked_at: null,
    is_dm_keyword_trigger_enabled: true,
    keywords: ['link'],
    tags: [],
    is_public_reply_enabled: false,
    public_reply_texts: [],
    is_opening_message_enabled: false,
    opening_message: null,
    is_follow_required: false,
    follow_request_message: null,
    is_email_collection_enabled: false,
    email_request_message: null,
    is_phone_collection_enabled: false,
    phone_request_message: null,
    final_message: { text: 'Here you go', links: [] },
    completed_run_count: 0,
    last_triggered_at: null,
    created_by_user_id: null,
    updated_by_user_id: null,
    deleted_at: null,
    delete_reason: null,
    delete_note: null,
    created_at: new Date('2026-11-01T08:00:00.000Z'),
    updated_at: new Date('2026-11-01T08:00:00.000Z'),
    ...overrides,
  };
}

/** The contact, inside the messaging window unless overridden. */
function contactRow(overrides: Partial<ContactRow> = {}): ContactRow {
  const now = new Date();
  return {
    id: CONTACT_ID,
    public_id: generatePublicId('contact'),
    organization_id: ORGANIZATION_ID,
    instagram_account_id: ACCOUNT_ID,
    instagram_user_id: CONTACT_INSTAGRAM_ID,
    username: 'jordan.lee',
    full_name: null,
    profile_picture_url: null,
    followers_count: null,
    is_following_account: null,
    follow_checked_at: null,
    email: null,
    email_collected_at: null,
    phone: null,
    phone_collected_at: null,
    tags: [],
    first_seen_at: now,
    last_message_received_at: now,
    last_direct_message_received_at: now,
    last_message_sent_at: null,
    deleted_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** A `waiting` DM run of automation 17 that waits for an email. */
function runRow(overrides: Partial<AutomationRunRow> = {}): AutomationRunRow {
  const now = new Date();
  return {
    id: 501,
    public_id: generatePublicId('automationRun'),
    organization_id: ORGANIZATION_ID,
    automation_id: 17,
    contact_id: CONTACT_ID,
    trigger_type: 'dm',
    trigger_instagram_media_id: null,
    trigger_instagram_comment_id: null,
    trigger_instagram_story_id: null,
    trigger_text: 'link please',
    status: 'waiting',
    current_step: 'email_collect',
    waiting_for: 'email',
    queued_automations: [],
    last_instagram_event_key: 'message:earlier',
    sending_message_kind: null,
    sending_started_at: null,
    error_message: null,
    cancel_reason: null,
    started_at: now,
    last_step_at: now,
    waiting_since_at: now,
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    ended_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** The log of one comment × automation 17, `started` on run 501. */
function commentLogRow(overrides: Partial<AutomationCommentLogRow> = {}): AutomationCommentLogRow {
  const now = new Date();
  return {
    id: 901,
    public_id: generatePublicId('automationCommentLog'),
    organization_id: ORGANIZATION_ID,
    automation_id: 17,
    automation_name: 'Comment for the link',
    automation_run_id: 501,
    contact_id: CONTACT_ID,
    instagram_media_id: POST,
    instagram_comment_id: COMMENT,
    comment_text: 'link please',
    commenter_username: 'jordan.lee',
    commenter_instagram_user_id: CONTACT_INSTAGRAM_ID,
    public_reply_status: 'off',
    public_reply_text: null,
    public_reply_skip_reason: null,
    public_reply_at: null,
    opening_dm_status: 'off',
    opening_dm_at: null,
    button_clicked_at: null,
    follow_status: 'off',
    follow_at: null,
    follow_confirmed_at: null,
    email_status: 'off',
    email_at: null,
    email_received: null,
    phone_status: 'off',
    phone_at: null,
    phone_received: null,
    final_dm_status: 'off',
    final_dm_at: null,
    overall_status: 'started',
    current_step: null,
    failed_step: null,
    waiting_for: null,
    ignored_reason: null,
    error_type: null,
    http_status: null,
    error_code: null,
    error_subcode: null,
    error_message: null,
    error_reason: null,
    error_stack: null,
    fbtrace_id: null,
    error_response: null,
    error_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** A row as a read returns it: a copy, so a later write never changes what was read. */
function copyOf<T extends object>(row: T | undefined): T | null {
  return row === undefined ? null : { ...row };
}

/** The sub-domain's tables in memory, behind the repositories' own method names. */
function createStore() {
  const rows = {
    runs: [] as AutomationRunRow[],
    commentLogs: [] as AutomationCommentLogRow[],
    automations: [] as AutomationRow[],
    /** Appended run events: `<run id>:<event type>:<status>`. */
    runEvents: [] as string[],
  };
  let identifierSequence = 1000;
  const nextIdentifier = () => {
    identifierSequence += 1;
    return identifierSequence;
  };
  const isOpen = (run: AutomationRunRow) => run.status === 'running' || run.status === 'waiting';
  const cancel = (runs: AutomationRunRow[]): number[] =>
    runs.map((run) => {
      Object.assign(run, { status: 'cancelled', waiting_for: null, waiting_since_at: null });
      return run.id;
    });
  const updateRun = ({
    runId,
    changes,
  }: {
    runId: number;
    changes: Partial<AutomationRunRow>;
  }): AutomationRunRow | null => {
    const run = rows.runs.find((candidate) => candidate.id === runId);
    return run === undefined ? null : { ...Object.assign(run, changes) };
  };
  const runs = {
    insert: vi.fn(async (values: AutomationRunInsertValues) => {
      const run = runRow({
        id: nextIdentifier(),
        automation_id: values.automationId,
        contact_id: values.contactId,
        trigger_type: values.triggerType,
        trigger_instagram_media_id: values.triggerInstagramMediaId,
        trigger_instagram_comment_id: values.triggerInstagramCommentId,
        trigger_instagram_story_id: values.triggerInstagramStoryId,
        trigger_text: values.triggerText,
        last_instagram_event_key: values.lastInstagramEventKey,
        status: 'running',
        current_step: 'keyword_match',
        waiting_for: null,
        waiting_since_at: null,
      });
      rows.runs.push(run);
      return { ...run };
    }),
    lockById: vi.fn(async ({ runId }: { runId: number }) =>
      copyOf(rows.runs.find((run) => run.id === runId)),
    ),
    lockContactRunByPublicId: vi.fn(
      async ({ contactId, runPublicId }: { contactId: number; runPublicId: string }) =>
        copyOf(
          rows.runs.find((run) => run.contact_id === contactId && run.public_id === runPublicId),
        ),
    ),
    findLatestRunOfAutomationForContact: vi.fn(
      async ({ automationId, contactId }: { automationId: number; contactId: number }) =>
        copyOf(
          rows.runs
            .filter((run) => run.automation_id === automationId && run.contact_id === contactId)
            .at(-1),
        ),
    ),
    lockWaitingRunsOfContact: vi.fn(
      async ({ contactId, waitingFor }: { contactId: number; waitingFor: readonly string[] }) =>
        rows.runs
          .filter(
            (run) =>
              run.contact_id === contactId &&
              run.status === 'waiting' &&
              run.waiting_for !== null &&
              waitingFor.includes(run.waiting_for),
          )
          .map((run) => ({ ...run })),
    ),
    findRunsMovedByEvent: vi.fn(
      async ({ contactId, eventKey }: { contactId: number; eventKey: string }) =>
        rows.runs
          .filter(
            (run) => run.contact_id === contactId && run.last_instagram_event_key === eventKey,
          )
          .map((run) => ({ ...run })),
    ),
    listOpenRunAutomationIds: vi.fn(async ({ contactId }: { contactId: number }) => [
      ...new Set(
        rows.runs
          .filter((run) => run.contact_id === contactId && isOpen(run))
          .map((run) => run.automation_id),
      ),
    ]),
    listRunningMovedByEvent: vi.fn(async ({ eventKey }: { eventKey: string }) =>
      rows.runs
        .filter((run) => run.status === 'running' && run.last_instagram_event_key === eventKey)
        .map((run) => ({ ...run })),
    ),
    update: vi.fn(async (input: { runId: number; changes: Partial<AutomationRunRow> }) =>
      updateRun(input),
    ),
    replaceQueuedAutomations: vi.fn(
      async ({ runId, entries }: { runId: number; entries: AutomationQueuedEntry[] }) =>
        updateRun({ runId, changes: { queued_automations: entries } }),
    ),
    cancelOpenRunsOfAutomation: vi.fn(async ({ automationId }: { automationId: number }) =>
      cancel(rows.runs.filter((run) => run.automation_id === automationId && isOpen(run))),
    ),
    cancelOpenRunsOfContact: vi.fn(async ({ contactId }: { contactId: number }) =>
      cancel(rows.runs.filter((run) => run.contact_id === contactId && isOpen(run))),
    ),
    cancelExpiredWaitingRuns: vi.fn(async ({ runIds }: { runIds: readonly number[] }) =>
      cancel(rows.runs.filter((run) => runIds.includes(run.id) && run.status === 'waiting')),
    ),
    eraseContactCopies: vi.fn(async () => 1),
  };
  const runEvents = {
    insertMany: vi.fn(async (events: readonly AutomationRunEventValues[]) => {
      for (const event of events) {
        rows.runEvents.push(`${event.runId}:${event.eventType}:${event.status ?? '-'}`);
      }
    }),
  };
  const commentLogs = {
    insertMany: vi.fn(async (values: readonly AutomationCommentLogInsertValues[]) => {
      for (const value of values) {
        rows.commentLogs.push(
          commentLogRow({
            id: nextIdentifier(),
            automation_id: value.automationId,
            automation_name: value.automationName,
            automation_run_id: value.automationRunId,
            instagram_comment_id: value.instagramCommentId,
            overall_status: value.overallStatus,
            ignored_reason: value.ignoredReason,
          }),
        );
      }
      return [];
    }),
    listForComment: vi.fn(async ({ instagramCommentId }: { instagramCommentId: string }) =>
      rows.commentLogs.filter((log) => log.instagram_comment_id === instagramCommentId),
    ),
    findForRun: vi.fn(async ({ runId }: { runId: number }) =>
      copyOf(rows.commentLogs.find((log) => log.automation_run_id === runId)),
    ),
    findForAutomationComment: vi.fn(
      async (input: { automationId: number; instagramCommentId: string }) =>
        copyOf(
          rows.commentLogs.find(
            (log) =>
              log.automation_id === input.automationId &&
              log.instagram_comment_id === input.instagramCommentId,
          ),
        ),
    ),
    update: vi.fn(
      async (input: { commentLogId: number; changes: Partial<AutomationCommentLogRow> }) => {
        const log = rows.commentLogs.find((candidate) => candidate.id === input.commentLogId);
        return log === undefined ? null : { ...Object.assign(log, input.changes) };
      },
    ),
    markRunsCancelled: vi.fn(async ({ runIds }: { runIds: readonly number[] }) => runIds.length),
    eraseContactCopies: vi.fn(async () => 1),
  };
  const automations = {
    listLiveAutomationsOfAccount: vi.fn(
      async (input: {
        instagramAccountId: number;
        triggerType: string | null;
        isDmKeywordTriggerRequired: boolean;
      }) =>
        rows.automations.filter(
          (automation) =>
            automation.status === 'live' &&
            automation.deleted_at === null &&
            automation.instagram_account_id === input.instagramAccountId &&
            (input.triggerType === null || automation.trigger_type === input.triggerType) &&
            (!input.isDmKeywordTriggerRequired || automation.is_dm_keyword_trigger_enabled),
        ),
    ),
    findByIdIncludingDeleted: vi.fn(async ({ automationId }: { automationId: number }) =>
      copyOf(rows.automations.find((automation) => automation.id === automationId)),
    ),
    findByPublicIdIncludingDeleted: vi.fn(
      async ({ automationPublicId }: { automationPublicId: string }) =>
        copyOf(rows.automations.find((automation) => automation.public_id === automationPublicId)),
    ),
    lockForRunChanges: vi.fn(
      async (_input: { organizationId: number; automationIds: readonly number[] }) => {},
    ),
    lockLiveForRunStart: vi.fn(async ({ automationId }: { automationId: number }) =>
      copyOf(
        rows.automations.find(
          (automation) =>
            automation.id === automationId &&
            automation.status === 'live' &&
            automation.deleted_at === null,
        ),
      ),
    ),
    markRunStarted: vi.fn(async () => {}),
    incrementCompletedRunCount: vi.fn(async () => {}),
  };
  return { rows, runs, runEvents, commentLogs, automations };
}

/** An Instagram error as a send result carries it. */
function instagramError(
  overrides: Partial<ConstructorParameters<typeof InstagramApiError>[0]> = {},
): InstagramApiError {
  return new InstagramApiError({
    errorClass: 'refused',
    category: 'http_4xx',
    httpStatus: 400,
    details: {
      code: 10,
      subcode: 2534022,
      type: 'OAuthException',
      fbtraceId: 'trace-acme',
    },
    fallbackMessage: 'Instagram failed',
    ...overrides,
  });
}

const delivered: AutomationSendResult = { outcome: 'delivered' };
const refused = (): AutomationSendResult => ({ outcome: 'refused', error: instagramError() });
const throttled = (): Extract<AutomationSendResult, { outcome: 'temporary' }> => ({
  outcome: 'temporary',
  error: instagramError({ errorClass: 'throttled' }),
  errorType: 'instagram_api',
});
const unknownOutcome = (): AutomationSendResult => ({
  outcome: 'unknown',
  error: instagramError({ errorClass: 'outage', category: 'timeout' }),
  errorType: 'network',
});
const deadToken = (connectionStatus: 'expired' | 'error' | null = 'expired') => ({
  outcome: 'token' as const,
  error: instagramError({ errorClass: 'auth', connectionStatus }),
});

/** The settings row reply safety reads (AU20). */
const settings = { is_public_reply_safety_enabled: true } as InstagramAccountSettingsRow;

function setup() {
  const store = createStore();
  Object.assign(fakes, {
    runs: store.runs,
    runEvents: store.runEvents,
    commentLogs: store.commentLogs,
    automations: store.automations,
  });
  const access: InstagramAutomationAccountAccess = {
    instagramAccount,
    instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
    instagramAppUserId: '8724000000000001',
    username: 'acme.shop',
    connectionStatus: 'connected',
    encryptedAccessToken: 'v1:ciphertext',
    settings,
  };
  const contact = contactRow();
  const accountService = {
    findAutomationAccountAccess: vi.fn(
      async (): Promise<InstagramAutomationAccountAccess | null> => access,
    ),
    markConnectionBroken: vi.fn(async () => null),
  };
  const contactService = {
    lockLiveContact: vi.fn(
      async (_key: {
        databaseHandle: unknown;
        organizationId: number;
        contactId: number;
      }): Promise<ContactRow | null> => ({ ...contact }),
    ),
    findLiveContact: vi.fn(async (): Promise<ContactRow | null> => ({ ...contact })),
    recordContactEmail: vi.fn(
      async ({ email }: { email: string }): Promise<ContactCollectedValueResult | null> => {
        contact.email = email;
        return { outcome: 'saved', contact: { ...contact } };
      },
    ),
    recordContactPhone: vi.fn(
      async ({ phone }: { phone: string }): Promise<ContactCollectedValueResult | null> => {
        contact.phone = phone;
        return { outcome: 'saved', contact: { ...contact } };
      },
    ),
    recordContactMessageSent: vi.fn(async () => null),
    recordContactProfile: vi.fn(async () => null),
    addContactTags: vi.fn(async () => null),
  };
  /** The outcomes the next sends, public replies and follow reads get; delivered / following after. */
  const outcomes = {
    sends: [] as AutomationSendResult[],
    publicReplies: [] as AutomationSendResult[],
    followReads: [] as AutomationFollowReadResult[],
  };
  /** What each Instagram call saw: the units open, and the claims set on the runs (AU19). */
  const instagramCalls: Array<{ openUnits: number; claims: Array<string | null> }> = [];
  const noteInstagramCall = () => {
    instagramCalls.push({
      openUnits: unitOfWork.openCount,
      claims: store.rows.runs.map((run) => run.sending_message_kind),
    });
  };
  const messageService = {
    composeMessage: vi.fn(({ messageKind }: { messageKind: string }) => ({
      message: { text: messageKind },
      plainTextFallback: null,
    })),
    sendDirectMessage: vi.fn(
      async (_input: {
        recipient: unknown;
        composed: { message: { text?: string } };
      }): Promise<AutomationSendResult> => {
        noteInstagramCall();
        return outcomes.sends.shift() ?? delivered;
      },
    ),
    sendPublicReply: vi.fn(
      async (_input: {
        instagramCommentId: string;
        text: string;
      }): Promise<AutomationSendResult> => {
        noteInstagramCall();
        return outcomes.publicReplies.shift() ?? delivered;
      },
    ),
    readFollowStatus: vi.fn(async (): Promise<AutomationFollowReadResult> => {
      noteInstagramCall();
      return outcomes.followReads.shift() ?? { outcome: 'read', isFollowing: true, profile: null };
    }),
  };
  const replySafetyService = {
    decide: vi.fn(
      async (): Promise<AutomationPublicReplyDecision> => ({ kind: 'reply', text: 'Sent!' }),
    ),
  };
  const service = new AutomationRunService(
    accountService as unknown as InstagramAccountService,
    contactService as unknown as ContactService,
    messageService as unknown as AutomationRunMessageService,
    replySafetyService as unknown as AutomationPublicReplySafetyService,
  );
  return {
    service,
    store,
    rows: store.rows,
    access,
    contact,
    accountService,
    contactService,
    messageService,
    replySafetyService,
    outcomes,
    instagramCalls,
  };
}

type Engine = ReturnType<typeof setup>;

let engine: Engine;

beforeEach(() => {
  vi.clearAllMocks();
  unitOfWork.openCount = 0;
  unitOfWork.handles = [];
  engine = setup();
});

function eventOf(eventKey: string, isLastAttempt = false): AutomationRunEvent {
  return { eventKey, occurredAt: new Date(), isLastAttempt, requestId: REQUEST_ID };
}

function triggerInput(event: AutomationRunEvent) {
  return {
    scope,
    instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
    contact: { ...engine.contact },
    event,
  };
}

function comment({
  text = 'link please',
  instagramCommentId = COMMENT,
  isLastAttempt = false,
}: {
  text?: string;
  instagramCommentId?: string;
  isLastAttempt?: boolean;
} = {}): Promise<AutomationRunHandlingResult> {
  return engine.service.startCommentRun({
    ...triggerInput(eventOf(`comment:${instagramCommentId}`, isLastAttempt)),
    instagramCommentId,
    instagramMediaId: POST,
    text,
    commenterUsername: 'jordan.lee',
  });
}

function directMessage({
  text = 'link please',
  quickReplyPayload = null,
  eventKey = 'message:now',
  isLastAttempt = false,
}: {
  text?: string | null;
  quickReplyPayload?: string | null;
  eventKey?: string;
  isLastAttempt?: boolean;
} = {}): Promise<AutomationRunHandlingResult> {
  return engine.service.handleDirectMessage({
    ...triggerInput(eventOf(eventKey, isLastAttempt)),
    text,
    quickReplyPayload,
    attachmentEmail: null,
  });
}

function storyReply({
  isLastAttempt = false,
}: {
  isLastAttempt?: boolean;
} = {}): Promise<AutomationRunHandlingResult> {
  return engine.service.startStoryReplyRun({
    ...triggerInput(eventOf('message:story', isLastAttempt)),
    instagramStoryId: STORY,
    text: 'link please',
  });
}

function click({
  automationPublicId,
  runPublicId,
}: {
  automationPublicId: string;
  runPublicId: string;
}): Promise<AutomationRunHandlingResult> {
  return engine.service.handleButtonClick({
    ...triggerInput(eventOf('postback:now')),
    automationPublicId,
    runPublicId,
  });
}

/** Adds an automation to the store. */
function addAutomation(overrides: Partial<AutomationRow> = {}): AutomationRow {
  const automation = automationRow(overrides);
  engine.rows.automations.push(automation);
  return automation;
}

/** Adds another automation, on a keyword no test sends, whose run waits for the contact's email. */
function addEmailFirst(): AutomationRow {
  return addAutomation({
    id: EMAIL_FIRST_ID,
    name: 'Email first',
    keywords: ['catalog'],
    is_email_collection_enabled: true,
  });
}

/** Adds a run to the store. */
function addRun(overrides: Partial<AutomationRunRow> = {}): AutomationRunRow {
  const run = runRow(overrides);
  engine.rows.runs.push(run);
  return run;
}

/** Adds a comment log to the store. */
function addCommentLog(overrides: Partial<AutomationCommentLogRow> = {}): AutomationCommentLogRow {
  const log = commentLogRow(overrides);
  engine.rows.commentLogs.push(log);
  return log;
}

/**
 * The contact is erased by another request: every later unit reads it gone, and its open runs are
 * cancelled as the erase's own step leaves them (CT8).
 */
function eraseContact(): void {
  engine.contactService.lockLiveContact.mockResolvedValue(null);
  engine.contactService.findLiveContact.mockResolvedValue(null);
  engine.contactService.recordContactEmail.mockResolvedValue(null);
  engine.contactService.recordContactPhone.mockResolvedValue(null);
  for (const run of engine.rows.runs) {
    if (run.status === 'running' || run.status === 'waiting') {
      Object.assign(run, { status: 'cancelled', waiting_for: null, waiting_since_at: null });
    }
  }
}

/** The run's events, oldest first: `<event type>:<status>`. */
function eventTrail(runId: number): string[] {
  return engine.rows.runEvents
    .filter((event) => event.startsWith(`${runId}:`))
    .map((event) => event.slice(`${runId}:`.length));
}

/** The texts of the DMs that went out — the fake composes each kind as its own name. */
function sentKinds(): Array<string | undefined> {
  return engine.messageService.sendDirectMessage.mock.calls.map(
    ([input]) => input.composed.message.text,
  );
}

const queuedEntry = (automation: AutomationRow): AutomationQueuedEntry => ({
  automation_id: automation.public_id,
  queued_at: '2026-11-21T09:00:00.000Z',
  trigger: { type: 'dm', text: 'price' },
});

/** An opening message with its button, on. */
const openingOn = {
  is_opening_message_enabled: true,
  opening_message: { text: 'Welcome!', button_title: 'Send it' },
};

const followRequest = {
  text: 'Follow us first',
  following_button_title: "I'm following",
  profile_button_title: 'Profile',
};

describe('the event’s account (AU27)', () => {
  it.each<[string, (access: InstagramAutomationAccountAccess, contact: ContactRow) => void]>([
    ['is expired', (access) => Object.assign(access, { connectionStatus: 'expired' })],
    ['has no token', (access) => Object.assign(access, { encryptedAccessToken: null })],
    [
      'is not the contact’s',
      (_access, contact) => Object.assign(contact, { instagram_account_id: OTHER_ACCOUNT_ID }),
    ],
    [
      'has no Instagram id for the contact (erased)',
      (_access, contact) => Object.assign(contact, { instagram_user_id: null }),
    ],
  ])('takes no event when it %s: nothing is read or written', async (_case, change) => {
    addAutomation();
    const run = addRun();
    change(engine.access, engine.contact);

    const results = [
      await comment(),
      await directMessage(),
      await storyReply(),
      await click({ automationPublicId: 'aut_unused', runPublicId: run.public_id }),
    ];

    expect(results).toEqual(
      Array.from({ length: 4 }, () => ({
        outcome: 'account_unavailable',
        runPublicIds: [],
        failedErrorType: null,
      })),
    );
    expect(withAppDatabaseContext).not.toHaveBeenCalled();
    expect(engine.messageService.sendDirectMessage).not.toHaveBeenCalled();
  });

  it('is read once per event, in the job’s scope, and every unit relays that scope', async () => {
    addAutomation();

    await directMessage();

    expect(engine.accountService.findAutomationAccountAccess).toHaveBeenCalledTimes(1);
    expect(engine.accountService.findAutomationAccountAccess).toHaveBeenCalledWith({
      scope,
      instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
    });
    expect(engine.store.automations.listLiveAutomationsOfAccount).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      instagramAccountId: ACCOUNT_ID,
      triggerType: null,
      isDmKeywordTriggerRequired: true,
    });
    for (const [unit] of vi.mocked(withAppDatabaseContext).mock.calls) {
      expect(unit.scope).toBe(scope);
    }
  });
});

describe('claim → send → record (AU19)', () => {
  it('sends with no unit of work open, the claim set before and cleared after', async () => {
    addAutomation({ is_public_reply_enabled: true, public_reply_texts: ['Sent!'] });

    const result = await comment();

    expect(result).toMatchObject({ outcome: 'run_started', failedErrorType: null });
    expect(engine.instagramCalls).toEqual([
      { openUnits: 0, claims: ['public_reply'] },
      { openUnits: 0, claims: ['final_message'] },
    ]);
    expect(engine.rows.runs[0]).toMatchObject({
      status: 'completed',
      current_step: 'final_dm',
      sending_message_kind: null,
      sending_started_at: null,
      last_instagram_event_key: `comment:${COMMENT}`,
    });
    expect(result.runPublicIds).toEqual([engine.rows.runs[0]?.public_id]);
  });

  it('never logs what the person wrote (K7)', async () => {
    addAutomation();
    engine.outcomes.sends.push(refused());

    await comment({ text: 'link — my private words' });

    const logged = JSON.stringify([loggerInfo.mock.calls, loggerWarn.mock.calls]);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: 'instagram_api', reason: 'refused' }),
      'app.automation_run.failed',
    );
    expect(logged).not.toContain('my private words');
  });

  it.each([
    ['its automation’s tags', { tags: ['spring', 'vip'] }, ['spring', 'vip']],
    ['its automation’s name when it has no tags', { tags: [] }, ['Comment for the link']],
  ])(
    'a completed run tags the contact with %s, and counts once (AU10, CT10)',
    async (_case, overrides, tags) => {
      const automation = addAutomation(overrides);

      await directMessage();

      expect(engine.contactService.addContactTags).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: CONTACT_ID, tags }),
      );
      expect(engine.store.automations.incrementCompletedRunCount).toHaveBeenCalledTimes(1);
      expect(engine.store.automations.markRunStarted).toHaveBeenCalledWith({
        organizationId: ORGANIZATION_ID,
        automationId: automation.id,
      });
    },
  );

  it('stops before sending when the automation was deleted since the match (AU12)', async () => {
    const automation = addAutomation();
    engine.store.automations.findByIdIncludingDeleted.mockResolvedValue({
      ...automation,
      deleted_at: new Date(),
    });

    await directMessage();

    expect(engine.messageService.sendDirectMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['delivered', delivered, 1],
    ['refused', refused(), 0],
  ] as const)(
    'a run cancelled while its message went stays cancelled when the message is %s',
    async (_case, result, messagesRecorded) => {
      addAutomation();
      engine.messageService.sendDirectMessage.mockImplementationOnce(async () => {
        Object.assign(engine.rows.runs[0] as AutomationRunRow, { status: 'cancelled' });
        return result;
      });

      const handled = await directMessage();

      const run = engine.rows.runs[0] as AutomationRunRow;
      expect(handled.failedErrorType).toBeNull();
      expect(run.status).toBe('cancelled');
      expect(eventTrail(run.id)).toEqual(['status_changed:running']);
      expect(engine.contactService.recordContactMessageSent).toHaveBeenCalledTimes(
        messagesRecorded,
      );
    },
  );

  it('moves past the email and the phone a contact already gave (AU18)', async () => {
    addAutomation({ is_email_collection_enabled: true, is_phone_collection_enabled: true });
    Object.assign(engine.contact, { email: 'jordan@example.com', phone: '+14155550100' });

    await comment();

    expect(sentKinds()).toEqual(['final_message']);
    expect(engine.rows.commentLogs[0]).toMatchObject({
      email_status: 'skipped',
      phone_status: 'skipped',
      overall_status: 'completed',
    });
  });

  it('stops after its action limit instead of looping on a run that never moves', async () => {
    addAutomation({ is_follow_required: true, follow_request_message: followRequest });
    const applyUpdate = engine.store.runs.update.getMockImplementation();
    engine.store.runs.update.mockImplementation(async (input) => {
      const { current_step: step, ...otherChanges } = input.changes;
      const changes = step === 'email_collect' ? otherChanges : input.changes;
      return (await applyUpdate?.({ ...input, changes })) ?? null;
    });

    const result = await directMessage();

    expect(result.outcome).toBe('run_started');
    expect(engine.messageService.readFollowStatus).toHaveBeenCalledTimes(24);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: engine.rows.runs[0]?.id }),
      'app.automation_run.advance_limit_reached',
    );
  });
});

describe('the contact lock: an erase wins (CT8, CT9)', () => {
  /** Every repository and contact-service call, by when it was made. */
  function callOrders(): number[] {
    const { runs, runEvents, commentLogs, automations } = engine.store;
    const { lockLiveContact: _lock, ...contactCalls } = engine.contactService;
    return [runs, runEvents, commentLogs, automations, contactCalls].flatMap((group) =>
      Object.values(group).flatMap((fake) => fake.mock.invocationCallOrder),
    );
  }

  it.each<[string, () => Promise<AutomationRunHandlingResult>]>([
    ['a comment', () => comment()],
    ['a DM', () => directMessage()],
    ['a story reply', () => storyReply()],
    [
      'a click',
      () => {
        const run = addRun({
          automation_id: 18,
          waiting_for: 'opening_message_button',
          current_step: 'comment_reply',
        });
        const automation = engine.rows.automations[1] as AutomationRow;
        return click({ automationPublicId: automation.public_id, runPublicId: run.public_id });
      },
    ],
  ])(
    'every unit of %s locks the event’s contact first, on its own handle',
    async (_case, handle) => {
      addAutomation({ is_public_reply_enabled: true, public_reply_texts: ['Sent!'] });
      addAutomation({ id: 18, trigger_type: 'story_reply', keywords: [], name: 'Any story' });

      await handle();

      const { lockLiveContact } = engine.contactService;
      expect(engine.rows.runs.at(-1)?.status).toBe('completed');
      // One lock a unit, on that unit's handle.
      expect(unitOfWork.handles.length).toBeGreaterThan(2);
      expect(lockLiveContact.mock.calls.map(([key]) => key)).toEqual(
        unitOfWork.handles.map((databaseHandle) => ({
          databaseHandle,
          organizationId: ORGANIZATION_ID,
          contactId: CONTACT_ID,
        })),
      );
      // Nothing is read or written between a unit opening and its lock — the erase's own order.
      const openings = vi.mocked(withAppDatabaseContext).mock.invocationCallOrder;
      const locks = lockLiveContact.mock.invocationCallOrder;
      openings.forEach((opened, unitNumber) => {
        const locked = locks[unitNumber] as number;
        expect(locked).toBeGreaterThan(opened);
        expect(callOrders().filter((order) => order > opened && order < locked)).toEqual([]);
      });
    },
  );

  it.each<[string, () => Promise<AutomationRunHandlingResult>]>([
    ['a comment', () => comment()],
    ['a DM', () => directMessage()],
    ['a story reply', () => storyReply()],
  ])(
    '%s of a contact erased since is ignored: nothing matched, written or sent',
    async (_case, handle) => {
      addAutomation();
      addAutomation({ id: 18, trigger_type: 'story_reply', keywords: [] });
      eraseContact();

      expect(await handle()).toEqual({
        outcome: 'ignored',
        runPublicIds: [],
        failedErrorType: null,
      });

      expect(engine.store.automations.listLiveAutomationsOfAccount).not.toHaveBeenCalled();
      expect(engine.rows).toMatchObject({ runs: [], commentLogs: [], runEvents: [] });
      expect(engine.store.automations.markRunStarted).not.toHaveBeenCalled();
      expect(engine.instagramCalls).toEqual([]);
    },
  );

  it('an answer that comes after the erase is ignored: the run it waited for stays cancelled', async () => {
    addAutomation({ is_email_collection_enabled: true });
    const run = addRun();
    eraseContact();

    expect((await directMessage({ text: 'jordan@example.com' })).outcome).toBe('ignored');

    expect(run.status).toBe('cancelled');
    expect(engine.contactService.recordContactEmail).not.toHaveBeenCalled();
    expect(engine.store.runs.update).not.toHaveBeenCalled();
    expect(engine.rows.runs).toHaveLength(1);
  });

  it('a click that comes after the erase is ignored', async () => {
    const automation = addAutomation();
    const run = addRun({ waiting_for: 'opening_message_button', current_step: 'comment_reply' });
    eraseContact();

    const payload = { automationPublicId: automation.public_id, runPublicId: run.public_id };
    expect((await click(payload)).outcome).toBe('ignored');

    expect(engine.store.runs.update).not.toHaveBeenCalled();
    expect(engine.instagramCalls).toEqual([]);
  });

  it('a retried comment whose question never went asks nobody once the contact is erased', async () => {
    addEmailFirst();
    addRun({ automation_id: EMAIL_FIRST_ID });
    addCommentLog({
      automation_run_id: null,
      overall_status: 'ignored',
      ignored_reason: 'waiting_for_other_email',
    });
    eraseContact();

    expect((await comment()).outcome).toBe('ignored');
    expect(engine.store.commentLogs.listForComment).not.toHaveBeenCalled();
    expect(engine.instagramCalls).toEqual([]);
  });

  it('a retried event of an erased contact resumes none of the runs it moved', async () => {
    addAutomation();
    const run = addRun({
      status: 'running',
      current_step: 'final_dm',
      waiting_for: null,
      last_instagram_event_key: 'message:now',
    });
    eraseContact();

    expect(await directMessage()).toEqual({
      outcome: 'already_handled',
      runPublicIds: [run.public_id],
      failedErrorType: null,
    });
    expect(engine.instagramCalls).toEqual([]);
  });

  it('an erase between the match and the first step stops the run before it sends', async () => {
    addAutomation();
    // Another request erases the contact as soon as the unit that started the run is over.
    engine.store.runEvents.insertMany.mockImplementationOnce(async () => eraseContact());

    const result = await directMessage();

    expect(result).toEqual({ outcome: 'run_started', runPublicIds: [], failedErrorType: null });
    expect(engine.rows.runs[0]?.status).toBe('cancelled');
    expect(engine.instagramCalls).toEqual([]);
  });

  it('a step reads the contact live itself: a run still open sends nothing to an erased contact', async () => {
    addAutomation();
    engine.contactService.findLiveContact.mockResolvedValue(null);

    const result = await directMessage();

    expect(result).toEqual({ outcome: 'run_started', runPublicIds: [], failedErrorType: null });
    expect(engine.rows.runs[0]?.status).toBe('running');
    expect(engine.instagramCalls).toEqual([]);
  });

  it('an erase while a message goes keeps the run cancelled: no tag, no count, no event', async () => {
    addAutomation();
    engine.messageService.sendDirectMessage.mockImplementationOnce(async () => {
      eraseContact();
      return delivered;
    });

    await directMessage();

    const run = engine.rows.runs[0] as AutomationRunRow;
    expect(run.status).toBe('cancelled');
    expect(eventTrail(run.id)).toEqual(['status_changed:running']);
    expect(engine.contactService.addContactTags).not.toHaveBeenCalled();
    expect(engine.store.automations.incrementCompletedRunCount).not.toHaveBeenCalled();
  });

  it('an erase between the queued trigger and the question sends no question', async () => {
    addEmailFirst();
    addAutomation();
    const waiting = addRun({ automation_id: EMAIL_FIRST_ID });
    engine.store.commentLogs.insertMany.mockImplementationOnce(async () => {
      eraseContact();
      return [];
    });

    expect(await comment()).toEqual({
      outcome: 'question_asked_again',
      runPublicIds: [],
      failedErrorType: null,
    });
    expect(waiting).toMatchObject({ status: 'cancelled', sending_message_kind: null });
    expect(engine.instagramCalls).toEqual([]);
  });

  it('a lock that fails is a temporary failure: rethrown, with nothing read or written', async () => {
    addAutomation();
    const lockTimeout = new Error('canceling statement due to lock timeout');
    engine.contactService.lockLiveContact.mockRejectedValue(lockTimeout);

    await expect(comment()).rejects.toBe(lockTimeout);

    expect(callOrders()).toEqual([]);
    expect(unitOfWork.openCount).toBe(0);
  });
});

describe('a failed step (3.B.9)', () => {
  it('records Instagram’s answer on the comment log: the step, the codes, the trace', async () => {
    addAutomation();
    engine.outcomes.sends.push(refused());

    const result = await comment();

    expect(result.failedErrorType).toBe('instagram_api');
    expect(engine.rows.runs[0]).toMatchObject({
      status: 'failed',
      error_message: 'instagram_api:10/2534022',
      sending_message_kind: null,
    });
    expect(engine.rows.commentLogs[0]).toMatchObject({
      overall_status: 'failed',
      failed_step: 'final_dm',
      error_type: 'instagram_api',
      http_status: 400,
      error_code: 10,
      error_subcode: 2534022,
      error_message: 'instagram_api:10/2534022',
      error_reason: 'refused',
      fbtrace_id: 'trace-acme',
      // D53: the class, the codes, the type, the trace and the status — never Instagram's text.
      error_response: {
        error_class: 'refused',
        http_status: 400,
        code: 10,
        error_subcode: 2534022,
        type: 'OAuthException',
        fbtrace_id: 'trace-acme',
      },
    });
    expect(eventTrail(engine.rows.runs[0]?.id ?? 0)).toEqual([
      'status_changed:running',
      'status_changed:failed',
    ]);
  });

  it('records a failure Instagram never answered without its columns (last attempt)', async () => {
    addAutomation();
    engine.outcomes.sends.push({
      outcome: 'temporary',
      error: new Error('the circuit is open'),
      errorType: 'network',
    });

    const result = await comment({ isLastAttempt: true });

    expect(result.failedErrorType).toBe('network');
    expect(engine.rows.commentLogs[0]).toMatchObject({
      error_type: 'network',
      error_message: 'network:temporary',
      error_reason: 'temporary',
      http_status: null,
      error_code: null,
      fbtrace_id: null,
      error_response: null,
    });
  });

  it('keeps the claim of a send that may have gone, whatever broke (AQ5)', async () => {
    addAutomation();
    engine.outcomes.sends.push({
      outcome: 'unknown',
      error: new Error('a bug of our own'),
      errorType: 'code',
    });

    const result = await directMessage();

    expect(result.failedErrorType).toBe('code');
    expect(engine.rows.runs[0]).toMatchObject({
      status: 'failed',
      error_message: 'code:send_outcome_unknown',
      sending_message_kind: 'final_message',
    });
  });

  it('fails without a call when no channel is open: no window, and the comment is over 7 days old', async () => {
    const automation = addAutomation();
    Object.assign(engine.contact, { last_direct_message_received_at: null });
    addRun({
      automation_id: automation.id,
      trigger_type: 'comment',
      trigger_instagram_comment_id: COMMENT,
      status: 'running',
      current_step: 'final_dm',
      waiting_for: null,
      last_instagram_event_key: `comment:${COMMENT}`,
      started_at: new Date(Date.now() - 8 * DAY_MILLISECONDS),
    });
    addCommentLog();

    const result = await comment();

    expect(result).toMatchObject({ outcome: 'run_resumed', failedErrorType: 'instagram_api' });
    expect(engine.messageService.sendDirectMessage).not.toHaveBeenCalled();
    expect(engine.rows.commentLogs[0]).toMatchObject({
      failed_step: 'final_dm',
      error_reason: 'outside_messaging_window',
    });
  });

  it.each([
    ['expired', 'expired'],
    ['error', 'error'],
    [null, 'error'],
  ] as const)(
    'marks the account broken on a dead token: Instagram says %s → %s (IA9)',
    async (reported, connectionStatus) => {
      addAutomation();
      engine.outcomes.sends.push(deadToken(reported));

      const result = await directMessage();

      expect(result.failedErrorType).toBe('token');
      expect(engine.accountService.markConnectionBroken).toHaveBeenCalledWith({
        scope,
        instagramAccount,
        connectionStatus,
        requestId: REQUEST_ID,
      });
      expect(engine.rows.runs[0]?.status).toBe('failed');
    },
  );
});

describe('what AU17 holds back', () => {
  it.each([
    ['running', 'run_in_progress'],
    ['failed', 'previous_run_final'],
  ] as const)(
    'a comment whose last run is %s is logged %s, with no new run',
    async (status, ignoredReason) => {
      addAutomation();
      addRun({ status, waiting_for: null, current_step: 'final_dm' });

      const result = await comment();

      expect(result.outcome).toBe('comment_logged');
      expect(engine.rows.runs).toHaveLength(1);
      expect(engine.rows.commentLogs).toEqual([
        expect.objectContaining({
          overall_status: 'ignored',
          ignored_reason: ignoredReason,
          automation_run_id: null,
        }),
      ]);
    },
  );

  it('a cancelled last run holds nothing back', async () => {
    addAutomation();
    addRun({ status: 'cancelled', waiting_for: null });

    expect((await comment()).outcome).toBe('run_started');
    expect(engine.rows.runs).toHaveLength(2);
  });

  it('a DM and a story reply held back are ignored, writing nothing', async () => {
    addAutomation();
    addAutomation({ id: 18, trigger_type: 'story_reply', keywords: [], name: 'Any story' });
    addRun({ status: 'completed', waiting_for: null });
    addRun({ id: 502, automation_id: 18, status: 'running', waiting_for: null });

    expect((await directMessage()).outcome).toBe('ignored');
    expect((await storyReply()).outcome).toBe('ignored');
    expect(engine.store.runs.insert).not.toHaveBeenCalled();
    expect(engine.rows.commentLogs).toEqual([]);
    expect(engine.messageService.sendDirectMessage).not.toHaveBeenCalled();
  });

  it('a story reply no automation matches does nothing', async () => {
    addAutomation();
    addAutomation({
      id: 18,
      trigger_type: 'story_reply',
      target_scope: 'specific',
      target_instagram_story_id: '17910000000000009',
      keywords: [],
    });

    expect((await storyReply()).outcome).toBe('nothing_matched');
    expect(engine.rows.runs).toEqual([]);
  });
});

describe('a trigger while another automation’s run waits for the contact’s email (AU17 (1), AU21)', () => {
  it('a story reply queues its trigger on that run and asks again, by DM', async () => {
    addEmailFirst();
    const story = addAutomation({ id: 18, trigger_type: 'story_reply', keywords: [] });
    const waiting = addRun({ automation_id: EMAIL_FIRST_ID });

    const result = await storyReply();

    expect(result).toEqual({
      outcome: 'question_asked_again',
      runPublicIds: [waiting.public_id],
      failedErrorType: null,
    });
    expect(waiting.queued_automations).toEqual([
      {
        automation_id: story.public_id,
        queued_at: expect.any(String),
        trigger: { type: 'story_reply', instagram_story_id: STORY, text: 'link please' },
      },
    ]);
    expect(sentKinds()).toEqual(['email_question']);
    expect(engine.messageService.sendDirectMessage.mock.calls[0]?.[0].recipient).toEqual({
      id: CONTACT_INSTAGRAM_ID,
    });
    expect(engine.rows.runs).toHaveLength(1);
  });

  it('a comment asks again as a private reply to it when no DM window is open', async () => {
    addEmailFirst();
    const chosen = addAutomation();
    const waiting = addRun({ automation_id: EMAIL_FIRST_ID });
    Object.assign(engine.contact, { last_direct_message_received_at: null });

    await comment();

    expect(engine.messageService.sendDirectMessage.mock.calls[0]?.[0].recipient).toEqual({
      comment_id: COMMENT,
    });
    // Asked, not moved on: claimed, sent, cleared, still waiting.
    expect(engine.instagramCalls).toEqual([{ openUnits: 0, claims: ['email_question'] }]);
    expect(waiting).toMatchObject({
      status: 'waiting',
      waiting_for: 'email',
      sending_message_kind: null,
      queued_automations: [expect.objectContaining({ automation_id: chosen.public_id })],
    });
    expect(engine.rows.commentLogs).toEqual([
      expect.objectContaining({
        automation_id: chosen.id,
        ignored_reason: 'waiting_for_other_email',
        automation_run_id: null,
      }),
    ]);
    expect(engine.contactService.recordContactMessageSent).toHaveBeenCalledTimes(1);
  });

  it('the chosen automation’s own wait is already_waiting: nothing queued, nothing asked (D14)', async () => {
    addAutomation({ is_email_collection_enabled: true });
    addAutomation({
      id: 18,
      trigger_type: 'story_reply',
      keywords: [],
      is_email_collection_enabled: true,
    });
    const ownRun = addRun();

    expect((await comment()).outcome).toBe('comment_logged');
    expect(engine.rows.commentLogs).toEqual([
      expect.objectContaining({ ignored_reason: 'already_waiting', automation_run_id: null }),
    ]);

    Object.assign(ownRun, { automation_id: 18 });
    expect((await storyReply()).outcome).toBe('ignored');

    expect(engine.store.runs.replaceQueuedAutomations).not.toHaveBeenCalled();
    expect(engine.messageService.sendDirectMessage).not.toHaveBeenCalled();
  });

  it('asks on the other automation’s run even when the chosen one’s own wait comes first', async () => {
    addEmailFirst();
    const chosen = addAutomation({ is_email_collection_enabled: true });
    const ownRun = addRun({ id: 501, automation_id: chosen.id });
    const otherRun = addRun({ id: 502, automation_id: EMAIL_FIRST_ID });

    const result = await comment();

    expect(result.runPublicIds).toEqual([otherRun.public_id]);
    expect(otherRun.queued_automations).toEqual([
      expect.objectContaining({ automation_id: chosen.public_id }),
    ]);
    expect(ownRun).toMatchObject({
      queued_automations: [],
      last_instagram_event_key: 'message:earlier',
    });
  });

  it('queues an automation once, and no more than 100', async () => {
    const automation = addAutomation();
    const alreadyQueued = addRun({
      automation_id: EMAIL_FIRST_ID,
      queued_automations: [queuedEntry(automation)],
    });

    await comment();
    expect(alreadyQueued.queued_automations).toHaveLength(1);

    Object.assign(alreadyQueued, {
      queued_automations: Array.from({ length: 100 }, () => queuedEntry(automationRow())),
    });
    await comment({ instagramCommentId: '17950000000000002' });
    expect(alreadyQueued.queued_automations).toHaveLength(100);
    expect(engine.store.runs.replaceQueuedAutomations).not.toHaveBeenCalled();
  });
});

describe('the email question asked again (AU17 (1), AU19)', () => {
  let waiting: AutomationRunRow;

  beforeEach(() => {
    addEmailFirst();
    addAutomation();
    addAutomation({ id: 18, trigger_type: 'story_reply', keywords: [] });
    waiting = addRun({ automation_id: EMAIL_FIRST_ID });
  });

  it.each<[string, () => void]>([
    [
      'another event moved the run on',
      () =>
        engine.store.runs.lockById.mockResolvedValueOnce(
          runRow({ status: 'running', waiting_for: null }),
        ),
    ],
    [
      'a claim is still set',
      () => Object.assign(waiting, { sending_message_kind: 'email_question' }),
    ],
    ['the contact was erased', () => engine.contactService.findLiveContact.mockResolvedValue(null)],
    [
      'no channel is open',
      () => Object.assign(engine.contact, { last_direct_message_received_at: null }),
    ],
  ])('sends nothing and answers the same when %s', async (_case, change) => {
    change();

    const result = await storyReply();

    expect(result).toEqual({
      outcome: 'question_asked_again',
      runPublicIds: [],
      failedErrorType: null,
    });
    expect(engine.messageService.sendDirectMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['a comment', () => comment()],
    ['a story reply', () => storyReply()],
  ])(
    'a temporary failure of %s is rethrown with the event key put back: the retry sends it, once',
    async (_case, handle) => {
      const throttle = throttled();
      engine.outcomes.sends.push(throttle);

      await expect(handle()).rejects.toBe(throttle.error);
      expect(waiting).toMatchObject({
        status: 'waiting',
        sending_message_kind: null,
        sending_started_at: null,
        last_instagram_event_key: 'message:earlier',
      });
      expect(engine.contactService.recordContactMessageSent).not.toHaveBeenCalled();

      expect(await handle()).toEqual({
        outcome: 'question_asked_again',
        runPublicIds: [waiting.public_id],
        failedErrorType: null,
      });
      expect(await handle()).toMatchObject({ outcome: 'already_handled' });
      expect(sentKinds()).toEqual(['email_question', 'email_question']);
      expect(engine.contactService.recordContactMessageSent).toHaveBeenCalledTimes(1);
      expect(waiting.queued_automations).toHaveLength(1);
      expect(engine.rows.commentLogs.length).toBeLessThanOrEqual(1);
    },
  );

  it('a wrong-email text that could not go for now is sent by the retry too', async () => {
    engine.contactService.recordContactEmail.mockResolvedValue({ outcome: 'invalid' });
    const throttle = throttled();
    engine.outcomes.sends.push(throttle);

    await expect(directMessage({ text: 'not an email' })).rejects.toBe(throttle.error);
    expect(waiting.last_instagram_event_key).toBe('message:earlier');

    expect((await directMessage({ text: 'not an email' })).outcome).toBe('answer_invalid');
    expect(sentKinds()).toEqual(['invalid_email', 'invalid_email']);
    expect(waiting.last_instagram_event_key).toBe('message:now');
  });

  it.each([
    ['a temporary failure on the last attempt', throttled(), true],
    ['a refusal', refused(), false],
    ['an unknown outcome', unknownOutcome(), false],
    ['a delivery', delivered, false],
  ] as const)(
    'keeps the event key after %s: the run waits on, and a retry never sends again',
    async (_case, result, isLastAttempt) => {
      engine.outcomes.sends.push(result);

      await expect(comment({ isLastAttempt })).resolves.toEqual({
        outcome: 'question_asked_again',
        runPublicIds: [waiting.public_id],
        failedErrorType: null,
      });
      expect(waiting).toMatchObject({
        status: 'waiting',
        sending_message_kind: null,
        last_instagram_event_key: `comment:${COMMENT}`,
      });

      expect(await comment({ isLastAttempt })).toEqual({
        outcome: 'already_handled',
        runPublicIds: [waiting.public_id],
        failedErrorType: null,
      });
      expect(engine.messageService.sendDirectMessage).toHaveBeenCalledTimes(1);
    },
  );

  it('marks the account broken on a dead token, the run still waiting under the event key', async () => {
    engine.outcomes.sends.push(deadToken('expired'));

    const result = await comment();

    expect(result).toMatchObject({ outcome: 'question_asked_again', failedErrorType: 'token' });
    expect(waiting).toMatchObject({
      status: 'waiting',
      last_instagram_event_key: `comment:${COMMENT}`,
    });
    expect(engine.accountService.markConnectionBroken).toHaveBeenCalledWith(
      expect.objectContaining({ connectionStatus: 'expired' }),
    );
  });

  it('a retried comment whose question was never claimed asks it now, choosing nothing again', async () => {
    addCommentLog({
      automation_run_id: null,
      overall_status: 'ignored',
      ignored_reason: 'waiting_for_other_email',
    });

    expect(await comment()).toEqual({
      outcome: 'question_asked_again',
      runPublicIds: [waiting.public_id],
      failedErrorType: null,
    });
    expect(sentKinds()).toEqual(['email_question']);
    expect(engine.store.automations.listLiveAutomationsOfAccount).not.toHaveBeenCalled();
    expect(engine.store.commentLogs.insertMany).not.toHaveBeenCalled();
  });

  it('a retried comment whose question a crash left claimed has the claim cleared, never re-sent (AQ5)', async () => {
    addCommentLog({
      automation_run_id: null,
      overall_status: 'ignored',
      ignored_reason: 'waiting_for_other_email',
    });
    Object.assign(waiting, {
      sending_message_kind: 'email_question',
      sending_started_at: new Date(),
      last_instagram_event_key: `comment:${COMMENT}`,
    });

    expect((await comment()).outcome).toBe('already_handled');
    expect(waiting.sending_message_kind).toBeNull();
    expect(engine.messageService.sendDirectMessage).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    [
      'no run waits for the email any more',
      () => Object.assign(waiting, { status: 'completed', waiting_for: null }),
    ],
    [
      'the comment was held back for another reason',
      () =>
        Object.assign(engine.rows.commentLogs[0] as object, {
          ignored_reason: 'previous_run_final',
        }),
    ],
  ])('a retried comment asks nothing when %s', async (_case, change) => {
    addCommentLog({
      automation_run_id: null,
      overall_status: 'ignored',
      ignored_reason: 'waiting_for_other_email',
    });
    change();

    expect(await comment()).toEqual({
      outcome: 'already_handled',
      runPublicIds: [],
      failedErrorType: null,
    });
    expect(engine.messageService.sendDirectMessage).not.toHaveBeenCalled();
  });
});

describe('an answer (AU14, AU18 steps 4–5)', () => {
  it('saves the quick reply before the typed text, at the event’s own time', async () => {
    addAutomation({ is_email_collection_enabled: true });
    addRun();

    const result = await directMessage({
      text: 'typed@example.com',
      quickReplyPayload: 'quick@example.com',
    });

    expect(result.outcome).toBe('run_continued');
    expect(engine.contactService.recordContactEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        contactId: CONTACT_ID,
        email: 'quick@example.com',
        collectedAt: expect.any(Date),
      }),
    );
  });

  it('a phone number saved records the event and completes the run, starting no queued automation', async () => {
    addAutomation({ is_phone_collection_enabled: true });
    const queued = addAutomation({ id: 18, name: 'Queued' });
    const run = addRun({
      current_step: 'phone_collect',
      waiting_for: 'phone',
      trigger_type: 'comment',
      trigger_instagram_comment_id: COMMENT,
      queued_automations: [queuedEntry(queued)],
    });
    addCommentLog({ phone_status: 'waiting', overall_status: 'waiting', waiting_for: 'phone' });

    const result = await directMessage({ text: '+1 415 555 0100' });

    expect(result).toEqual({
      outcome: 'run_continued',
      runPublicIds: [run.public_id],
      failedErrorType: null,
    });
    expect(eventTrail(run.id)).toEqual([
      'status_changed:running',
      'phone_received:-',
      'status_changed:completed',
    ]);
    expect(engine.rows.commentLogs[0]).toMatchObject({
      phone_status: 'done',
      phone_received: '+1 415 555 0100',
      overall_status: 'completed',
      waiting_for: null,
    });
    expect(engine.rows.runs).toHaveLength(1);
  });

  it.each([
    ['email', 'email_collect'],
    ['phone', 'phone_collect'],
  ] as const)(
    'moves on without taking the %s when its step was turned off meanwhile (AU14)',
    async (waitingFor, currentStep) => {
      addAutomation();
      const run = addRun({ waiting_for: waitingFor, current_step: currentStep });

      const result = await directMessage({ text: 'jordan@example.com' });

      expect(result.outcome).toBe('run_continued');
      expect(run.status).toBe('completed');
      expect(engine.contactService.recordContactEmail).not.toHaveBeenCalled();
      expect(engine.contactService.recordContactPhone).not.toHaveBeenCalled();
    },
  );

  it('ignores the answer of a contact erased meanwhile, leaving the run as it is', async () => {
    addAutomation({ is_email_collection_enabled: true });
    const run = addRun();
    engine.contactService.recordContactEmail.mockResolvedValueOnce(null);

    expect((await directMessage()).outcome).toBe('ignored');
    expect(run).toMatchObject({ status: 'waiting', waiting_for: 'email' });
    expect(engine.rows.runEvents).toEqual([]);
  });

  it('keeps a run waiting for a phone after an invalid number, sending nothing', async () => {
    addAutomation({ is_phone_collection_enabled: true });
    const run = addRun({ waiting_for: 'phone', current_step: 'phone_collect' });
    engine.contactService.recordContactPhone.mockResolvedValueOnce({ outcome: 'invalid' });

    expect(await directMessage({ text: 'later' })).toEqual({
      outcome: 'answer_invalid',
      runPublicIds: [],
      failedErrorType: null,
    });
    expect(run.status).toBe('waiting');
    expect(engine.messageService.sendDirectMessage).not.toHaveBeenCalled();
  });

  it('takes the DM as a new trigger when the waiting run’s automation is gone', async () => {
    const orphan = addRun({ automation_id: 99, waiting_for: 'phone' });
    addAutomation();

    expect((await directMessage()).outcome).toBe('run_started');
    expect(orphan.status).toBe('waiting');
  });
});

describe('the automations queued behind an email (AU21)', () => {
  beforeEach(() => {
    addEmailFirst();
  });

  it('each that may still run starts as its own run, in order; the rest are skipped and the queue emptied', async () => {
    const first = addAutomation({ id: 21, name: 'First queued' });
    const deleted = addAutomation({ id: 22, deleted_at: new Date() });
    const inactive = addAutomation({ id: 23, status: 'inactive' });
    const otherAccounts = addAutomation({ id: 24, instagram_account_id: OTHER_ACCOUNT_ID });
    const ranBefore = addAutomation({ id: 25 });
    const last = addAutomation({ id: 26, name: 'Last queued' });
    addRun({ id: 502, automation_id: ranBefore.id, status: 'completed', waiting_for: null });
    const answered = addRun({
      automation_id: EMAIL_FIRST_ID,
      queued_automations: [
        queuedEntry(first),
        queuedEntry(deleted),
        queuedEntry(inactive),
        queuedEntry(otherAccounts),
        queuedEntry(ranBefore),
        queuedEntry(automationRow()),
        { automation_id: 'not-an-id' } as unknown as AutomationQueuedEntry,
        queuedEntry(last),
      ],
    });

    const result = await directMessage({ text: 'jordan@example.com' });

    const started = engine.rows.runs.filter((run) => run.id > 1000);
    expect(started.map((run) => run.automation_id)).toEqual([first.id, last.id]);
    expect(started.every((run) => run.trigger_type === 'dm' && run.trigger_text === 'price')).toBe(
      true,
    );
    expect(result).toEqual({
      outcome: 'run_continued',
      runPublicIds: [answered.public_id, ...started.map((run) => run.public_id)],
      failedErrorType: null,
    });
    expect(answered.queued_automations).toEqual([]);
    expect(loggerWarn).toHaveBeenCalledWith(
      { runPublicId: answered.public_id, malformedCount: 1 },
      'app.automation_run.queued_entry_malformed',
    );
  });

  it('a queued comment whose log is gone starts all the same', async () => {
    const queued = addAutomation({ id: 21 });
    addRun({
      automation_id: EMAIL_FIRST_ID,
      queued_automations: [
        {
          ...queuedEntry(queued),
          trigger: {
            type: 'comment',
            instagram_media_id: POST,
            instagram_comment_id: COMMENT,
            text: 'link',
          },
        },
      ],
    });

    await directMessage({ text: 'jordan@example.com' });

    expect(engine.rows.runs.at(-1)).toMatchObject({
      automation_id: queued.id,
      trigger_type: 'comment',
      trigger_instagram_comment_id: COMMENT,
      status: 'completed',
    });
  });

  it('one run failing leaves the others to go on; the first failure is answered', async () => {
    const queued = addAutomation({ id: 21 });
    const answered = addRun({
      automation_id: EMAIL_FIRST_ID,
      queued_automations: [queuedEntry(queued)],
    });
    engine.outcomes.sends.push(refused());

    const result = await directMessage({ text: 'jordan@example.com' });

    expect(result.failedErrorType).toBe('instagram_api');
    expect(answered.status).toBe('failed');
    expect(engine.rows.runs.at(-1)?.status).toBe('completed');
    expect(result.runPublicIds).toHaveLength(2);
  });

  it('a temporary failure on the first leaves the rest to the retry, which resumes both', async () => {
    const queued = addAutomation({ id: 21 });
    const answered = addRun({
      automation_id: EMAIL_FIRST_ID,
      queued_automations: [queuedEntry(queued)],
    });
    const throttle = throttled();
    engine.outcomes.sends.push(throttle);

    await expect(directMessage({ text: 'jordan@example.com' })).rejects.toBe(throttle.error);
    const queuedRun = engine.rows.runs.at(-1) as AutomationRunRow;
    expect([answered.status, queuedRun.status]).toEqual(['running', 'running']);

    const retried = await directMessage({ text: 'jordan@example.com' });

    expect(retried).toEqual({
      outcome: 'run_resumed',
      runPublicIds: [answered.public_id, queuedRun.public_id],
      failedErrorType: null,
    });
    expect([answered.status, queuedRun.status]).toEqual(['completed', 'completed']);
    expect(engine.contactService.recordContactEmail).toHaveBeenCalledTimes(1);
  });
});

describe('a button click (AU16, D18)', () => {
  it('the opening button moves the run on and closes the log’s opening step', async () => {
    const automation = addAutomation();
    const run = addRun({
      trigger_type: 'comment',
      trigger_instagram_comment_id: COMMENT,
      current_step: 'comment_reply',
      waiting_for: 'opening_message_button',
    });
    addCommentLog({ opening_dm_status: 'waiting', overall_status: 'waiting' });

    const result = await click({
      automationPublicId: automation.public_id,
      runPublicId: run.public_id,
    });

    expect(result).toMatchObject({ outcome: 'run_continued', runPublicIds: [run.public_id] });
    expect(run).toMatchObject({
      status: 'completed',
      last_instagram_event_key: 'postback:now',
    });
    expect(engine.rows.commentLogs[0]).toMatchObject({
      opening_dm_status: 'done',
      button_clicked_at: expect.any(Date),
      overall_status: 'completed',
    });
  });

  it('continues nothing while another run waits for the email: the question is asked again', async () => {
    const automation = addAutomation(openingOn);
    addEmailFirst();
    const clicked = addRun({
      waiting_for: 'opening_message_button',
      current_step: 'comment_reply',
    });
    const emailWaiting = addRun({ id: 502, automation_id: EMAIL_FIRST_ID });

    const result = await click({
      automationPublicId: automation.public_id,
      runPublicId: clicked.public_id,
    });

    expect(result).toMatchObject({
      outcome: 'question_asked_again',
      runPublicIds: [emailWaiting.public_id],
    });
    expect(clicked.waiting_for).toBe('opening_message_button');
    expect(sentKinds()).toEqual(['email_question']);
  });

  it.each<[string, (automation: AutomationRow, run: AutomationRunRow) => void]>([
    ['is unknown', (_automation, run) => Object.assign(run, { public_id: 'run_other' })],
    ['is another contact’s', (_automation, run) => Object.assign(run, { contact_id: 42 })],
    ['is running', (_automation, run) => Object.assign(run, { status: 'running' })],
    [
      'waits for the email itself',
      (automation, run) => {
        Object.assign(automation, { is_email_collection_enabled: true });
        Object.assign(run, { waiting_for: 'email' });
      },
    ],
    [
      'waits for a phone',
      (automation, run) => {
        Object.assign(automation, { is_phone_collection_enabled: true });
        Object.assign(run, { waiting_for: 'phone' });
      },
    ],
    [
      'belongs to a deleted automation',
      (automation) => Object.assign(automation, { deleted_at: new Date() }),
    ],
    [
      'belongs to another account’s automation',
      (automation) => Object.assign(automation, { instagram_account_id: OTHER_ACCOUNT_ID }),
    ],
  ])('is ignored when the run %s', async (_case, change) => {
    const automation = addAutomation(openingOn);
    const run = addRun({ waiting_for: 'opening_message_button', current_step: 'comment_reply' });
    const payload = { automationPublicId: automation.public_id, runPublicId: run.public_id };
    change(automation, run);

    expect((await click(payload)).outcome).toBe('ignored');
    expect(engine.store.runs.update).not.toHaveBeenCalled();
    expect(engine.messageService.sendDirectMessage).not.toHaveBeenCalled();
  });
});

describe('a retried event (AU19)', () => {
  it('clears a claim left on a run that still waits, and sends nothing again', async () => {
    addAutomation({ is_email_collection_enabled: true });
    const run = addRun({
      last_instagram_event_key: 'message:now',
      sending_message_kind: 'invalid_email',
      sending_started_at: new Date(),
    });

    expect(await directMessage()).toEqual({
      outcome: 'already_handled',
      runPublicIds: [run.public_id],
      failedErrorType: null,
    });
    expect(run).toMatchObject({
      status: 'waiting',
      sending_message_kind: null,
      sending_started_at: null,
    });
    expect(engine.messageService.sendDirectMessage).not.toHaveBeenCalled();
    expect(engine.contactService.recordContactEmail).not.toHaveBeenCalled();
  });

  it('a story reply resumes the run it started, without choosing again', async () => {
    addAutomation({ trigger_type: 'story_reply', keywords: [] });
    const run = addRun({
      trigger_type: 'story_reply',
      status: 'running',
      current_step: 'final_dm',
      waiting_for: null,
      last_instagram_event_key: 'message:story',
    });

    expect(await storyReply()).toMatchObject({
      outcome: 'run_resumed',
      runPublicIds: [run.public_id],
    });
    expect(run.status).toBe('completed');
    expect(engine.store.automations.listLiveAutomationsOfAccount).not.toHaveBeenCalled();
  });

  it('a comment logged before, whose runs are all final, is already handled', async () => {
    addAutomation();
    addCommentLog({ automation_run_id: null, overall_status: 'ignored' });

    expect(await comment()).toEqual({
      outcome: 'already_handled',
      runPublicIds: [],
      failedErrorType: null,
    });
    expect(engine.store.commentLogs.insertMany).not.toHaveBeenCalled();
  });
});

describe('the lock order: the contact, the automations, the runs (AU12, D47)', () => {
  /** Every repository call, by name, oldest first. */
  function repositoryCalls(): Array<{ name: string; order: number }> {
    const { runs, runEvents, commentLogs, automations } = engine.store;
    return Object.entries({ runs, runEvents, commentLogs, automations })
      .flatMap(([table, group]) =>
        Object.entries(group).flatMap(([method, fake]) =>
          fake.mock.invocationCallOrder.map((order: number) => ({
            name: `${table}.${method}`,
            order,
          })),
        ),
      )
      .sort((left, right) => left.order - right.order);
  }

  it.each<[string, () => Promise<AutomationRunHandlingResult>]>([
    ['a comment', () => comment()],
    ['a DM', () => directMessage()],
    ['a story reply', () => storyReply()],
    [
      'a click',
      () => {
        const run = addRun({
          automation_id: 18,
          waiting_for: 'opening_message_button',
          current_step: 'comment_reply',
        });
        const automation = engine.rows.automations[1] as AutomationRow;
        return click({ automationPublicId: automation.public_id, runPublicId: run.public_id });
      },
    ],
  ])(
    'every unit of %s locks the automations of the contact’s open runs before it reads or locks any run',
    async (_case, handle) => {
      addAutomation({ is_public_reply_enabled: true, public_reply_texts: ['Sent!'] });
      addAutomation({ id: 18, trigger_type: 'story_reply', keywords: [], name: 'Any story' });

      await handle();

      expect(engine.rows.runs.at(-1)?.status).toBe('completed');
      const openings = vi.mocked(withAppDatabaseContext).mock.invocationCallOrder;
      const calls = repositoryCalls();
      openings.forEach((opened, unitNumber) => {
        const nextOpened = openings[unitNumber + 1] ?? Number.POSITIVE_INFINITY;
        expect(
          calls
            .filter(({ order }) => order > opened && order < nextOpened)
            .slice(0, 2)
            .map(({ name }) => name),
        ).toEqual(['runs.listOpenRunAutomationIds', 'automations.lockForRunChanges']);
      });
    },
  );

  it('locks the automations of the open runs only, the contact’s own', async () => {
    addRun({ id: 501, automation_id: 17, waiting_for: 'opening_message_button' });
    addRun({ id: 502, automation_id: 18, status: 'running', waiting_for: null });
    addRun({ id: 503, automation_id: 19, status: 'completed', waiting_for: null });
    addRun({ id: 504, automation_id: 20, contact_id: 42 });

    await directMessage({ text: 'hello' });

    expect(engine.store.automations.lockForRunChanges).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      automationIds: [17, 18],
    });
  });

  it.each<[string, () => Promise<AutomationRunHandlingResult>]>([
    ['a comment', () => comment()],
    ['a DM', () => directMessage()],
    ['a story reply', () => storyReply()],
  ])(
    '%s whose automation was deleted before its lock starts nothing: ignored, nothing written',
    async (_case, handle) => {
      addAutomation();
      addAutomation({ id: 18, trigger_type: 'story_reply', keywords: [] });
      engine.store.automations.lockLiveForRunStart.mockResolvedValue(null);

      expect(await handle()).toEqual({
        outcome: 'ignored',
        runPublicIds: [],
        failedErrorType: null,
      });

      expect(engine.rows).toMatchObject({ runs: [], commentLogs: [], runEvents: [] });
      expect(engine.store.automations.markRunStarted).not.toHaveBeenCalled();
      expect(engine.instagramCalls).toEqual([]);
    },
  );

  it('a trigger is not queued, nor the question asked again, for an automation deleted before its lock', async () => {
    addEmailFirst();
    addAutomation();
    const waiting = addRun({ automation_id: EMAIL_FIRST_ID });
    engine.store.automations.lockLiveForRunStart.mockResolvedValue(null);

    expect((await comment()).outcome).toBe('ignored');

    expect(waiting.queued_automations).toEqual([]);
    expect(engine.rows.commentLogs).toEqual([]);
    expect(engine.instagramCalls).toEqual([]);
  });

  it('proves the chosen automation live under its lock before AU17 locks a run', async () => {
    const automation = addAutomation();

    await comment();

    const { lockLiveForRunStart } = engine.store.automations;
    expect(lockLiveForRunStart).toHaveBeenCalledExactlyOnceWith({
      organizationId: ORGANIZATION_ID,
      automationId: automation.id,
    });
    expect(lockLiveForRunStart.mock.invocationCallOrder[0]).toBeLessThan(
      engine.store.runs.lockWaitingRunsOfContact.mock.invocationCallOrder[0] as number,
    );
  });

  it('a queued automation deleted before its lock is skipped; the others start', async () => {
    addEmailFirst();
    const deleted = addAutomation({ id: 21 });
    const last = addAutomation({ id: 22 });
    addRun({
      automation_id: EMAIL_FIRST_ID,
      queued_automations: [queuedEntry(deleted), queuedEntry(last)],
    });
    engine.store.automations.lockLiveForRunStart.mockResolvedValueOnce(null);

    await directMessage({ text: 'jordan@example.com' });

    expect(engine.rows.runs.filter((run) => run.id > 1000).map((run) => run.automation_id)).toEqual(
      [last.id],
    );
  });
});

describe('an event that ended failed (AU19 rev 2, WH14 rev 4, D47)', () => {
  const FAILED_EVENT_KEY = 'comment:dead';

  function failRuns(errorCode = 'processing_attempts_exhausted'): Promise<string[]> {
    return engine.service.failRunsOfFailedEvent({
      scope,
      organizationId: ORGANIZATION_ID,
      eventKey: FAILED_EVENT_KEY,
      errorCode,
    });
  }

  /** A run the failed event left `running`. */
  function addLeftRunning(overrides: Partial<AutomationRunRow> = {}): AutomationRunRow {
    return addRun({
      status: 'running',
      current_step: 'final_dm',
      waiting_for: null,
      waiting_since_at: null,
      last_instagram_event_key: FAILED_EVENT_KEY,
      ...overrides,
    });
  }

  it('fails every run it left running — the claim cleared, the error, an event each', async () => {
    const claimed = addLeftRunning({
      sending_message_kind: 'final_message',
      sending_started_at: new Date(),
    });
    const queued = addLeftRunning({
      id: 502,
      automation_id: 18,
      trigger_type: 'story_reply',
      current_step: 'keyword_match',
    });

    expect(await failRuns()).toEqual([claimed.public_id, queued.public_id]);

    for (const run of [claimed, queued]) {
      expect(run).toMatchObject({
        status: 'failed',
        failed_at: expect.any(Date),
        error_message: 'code:processing_attempts_exhausted',
        waiting_for: null,
        sending_message_kind: null,
        sending_started_at: null,
      });
      expect(eventTrail(run.id)).toEqual(['status_changed:failed']);
    }
    expect(engine.instagramCalls).toEqual([]);
  });

  it.each<[string, Partial<AutomationRunRow>, string, Partial<AutomationCommentLogRow>]>([
    ['the claimed message', { sending_message_kind: 'opening_message' }, 'opening_dm', {}],
    ['the step it was at', { current_step: 'phone_collect' }, 'phone_collect', {}],
    ['the public reply still to come', { current_step: 'comment_reply' }, 'public_reply', {}],
    [
      'the opening message, no public reply being on',
      { current_step: 'comment_reply' },
      'opening_dm',
      { current_step: 'opening_dm' },
    ],
  ])(
    'fails the comment log at %s, with the event’s code',
    async (_case, overrides, failedStep, logged) => {
      addLeftRunning({
        trigger_type: 'comment',
        trigger_instagram_comment_id: COMMENT,
        ...overrides,
      });
      addCommentLog(logged);

      await failRuns('processing_error:TypeError');

      expect(engine.rows.commentLogs[0]).toMatchObject({
        overall_status: 'failed',
        failed_step: failedStep,
        waiting_for: null,
        error_type: 'code',
        error_message: 'code:processing_error:TypeError',
        error_reason: 'processing_error:TypeError',
        error_at: expect.any(Date),
      });
    },
  );

  it('keeps the error a comment log already holds', async () => {
    const replyFailedAt = new Date('2026-11-20T10:00:00.000Z');
    const logged = {
      failed_step: 'public_reply',
      error_type: 'instagram_api',
      error_message: 'instagram_api:10/2534022',
      error_reason: 'refused',
      error_code: 10,
      error_at: replyFailedAt,
    };
    const run = addLeftRunning({
      trigger_type: 'comment',
      trigger_instagram_comment_id: COMMENT,
    });
    addCommentLog({ public_reply_status: 'failed', ...logged });

    await failRuns();

    expect(engine.rows.commentLogs[0]).toMatchObject({ overall_status: 'failed', ...logged });
    // The run's own error is this event's.
    expect(run.error_message).toBe('code:processing_attempts_exhausted');
  });

  it('leaves every other run as it is: not running, or moved last by another event', async () => {
    const others = [
      addLeftRunning({ id: 501, status: 'waiting', waiting_for: 'email' }),
      addLeftRunning({ id: 502, status: 'completed', completed_at: new Date() }),
      addLeftRunning({ id: 503, status: 'cancelled', cancel_reason: 'wait_expired' }),
      addLeftRunning({ id: 504, status: 'failed', error_message: 'instagram_api:10/2534022' }),
      addLeftRunning({ id: 505, last_instagram_event_key: 'message:later' }),
    ];
    const before = others.map((run) => ({ ...run }));

    expect(await failRuns()).toEqual([]);

    expect(others).toEqual(before);
    expect(engine.rows.runEvents).toEqual([]);
    expect(engine.contactService.lockLiveContact).not.toHaveBeenCalled();
  });

  it('a second call finds nothing left to fail', async () => {
    const run = addLeftRunning();
    await failRuns();
    const failed = { ...run };

    expect(await failRuns()).toEqual([]);

    expect(run).toEqual(failed);
    expect(eventTrail(run.id)).toEqual(['status_changed:failed']);
  });

  it('is one unit, in the engine’s lock order: the contact, the automation, then the run', async () => {
    addLeftRunning();

    await failRuns();

    expect(unitOfWork.handles).toHaveLength(1);
    expect(vi.mocked(withAppDatabaseContext)).toHaveBeenCalledWith(
      expect.objectContaining({ scope }),
    );
    expect(engine.contactService.lockLiveContact).toHaveBeenCalledExactlyOnceWith({
      databaseHandle: unitOfWork.handles[0],
      organizationId: ORGANIZATION_ID,
      contactId: CONTACT_ID,
    });
    expect(engine.store.automations.lockForRunChanges).toHaveBeenCalledExactlyOnceWith({
      organizationId: ORGANIZATION_ID,
      automationIds: [17],
    });
    const [contactLock, automationLock, runLock] = [
      engine.contactService.lockLiveContact,
      engine.store.automations.lockForRunChanges,
      engine.store.runs.lockById,
    ].map((lock) => lock.mock.invocationCallOrder[0] as number);
    expect(contactLock).toBeLessThan(automationLock as number);
    expect(automationLock).toBeLessThan(runLock as number);
  });

  it('a run another transaction ended or moved before its lock is left alone', async () => {
    const run = addLeftRunning();
    engine.store.runs.lockById.mockResolvedValueOnce({ ...run, status: 'cancelled' });

    expect(await failRuns()).toEqual([]);

    expect(run.status).toBe('running');
    expect(engine.rows.runEvents).toEqual([]);
  });
});

describe('a run waiting for a step that is now off (AU14, D48)', () => {
  const STEP_OFF_CASES = [
    ['email', 'email_collect', 'email_status', 'skipped'],
    ['phone', 'phone_collect', 'phone_status', 'skipped'],
    ['follow', 'follow_check', 'follow_status', 'skipped'],
    // The opening message itself went: only the click is no longer waited for.
    ['opening_message_button', 'comment_reply', 'opening_dm_status', 'sent'],
  ] as const;

  /** Automation 17's run, waiting for a step that automation 17 no longer has. */
  function addRunWithStepOff(overrides: Partial<AutomationRunRow> = {}): AutomationRunRow {
    return addRun({ trigger_type: 'comment', trigger_instagram_comment_id: COMMENT, ...overrides });
  }

  const OTHER_COMMENT = '17950000000000777';

  it.each(
    STEP_OFF_CASES.flatMap(([waitingFor, currentStep, stepStatus, closedAs]) =>
      (
        [
          ['a comment', () => comment({ text: 'hello', instagramCommentId: OTHER_COMMENT })],
          ['a DM', () => directMessage({ text: 'hello' })],
          ['a story reply', () => storyReply()],
          ['a click', () => click({ automationPublicId: 'aut_none', runPublicId: 'run_none' })],
        ] as const
      ).map(([eventName, handle]) => ({
        waitingFor,
        currentStep,
        stepStatus,
        closedAs,
        eventName,
        handle,
      })),
    ),
  )(
    'goes on at $eventName when it waits for the $waitingFor: the step skipped, nothing asked again',
    async ({ waitingFor, currentStep, stepStatus, closedAs, handle }) => {
      addAutomation();
      const run = addRunWithStepOff({ waiting_for: waitingFor, current_step: currentStep });
      addCommentLog({
        [stepStatus]: 'waiting',
        overall_status: 'waiting',
        waiting_for: waitingFor,
      });

      expect(await handle()).toEqual({
        outcome: 'run_continued',
        runPublicIds: [run.public_id],
        failedErrorType: null,
      });

      expect(run).toMatchObject({ status: 'completed', waiting_for: null });
      expect(eventTrail(run.id)).toEqual(['status_changed:running', 'status_changed:completed']);
      expect(engine.rows.commentLogs[0]).toMatchObject({
        [stepStatus]: closedAs,
        overall_status: 'completed',
        waiting_for: null,
      });
      expect(sentKinds()).toEqual(['final_message']);
      expect(engine.contactService.recordContactEmail).not.toHaveBeenCalled();
      expect(engine.contactService.recordContactPhone).not.toHaveBeenCalled();
    },
  );

  it('goes on from its next step: a step still on is asked, and waited for', async () => {
    addAutomation({ is_phone_collection_enabled: true });
    const run = addRunWithStepOff();

    await directMessage({ text: 'hello' });

    expect(run).toMatchObject({ status: 'waiting', waiting_for: 'phone' });
    // The DM that moved it on is not the answer to the question it led to.
    expect(sentKinds()).toEqual(['phone_question']);
    expect(engine.contactService.recordContactPhone).not.toHaveBeenCalled();
  });

  it('starts the automations queued behind its email, each with its own settings (AU21)', async () => {
    const queuedPlain = addAutomation({ id: 21, name: 'Plain' });
    const queuedWithEmail = addAutomation({
      id: 22,
      name: 'With email',
      is_email_collection_enabled: true,
    });
    const deleted = addAutomation({ id: 23, deleted_at: new Date() });
    addAutomation();
    const run = addRunWithStepOff({
      queued_automations: [
        {
          ...queuedEntry(queuedPlain),
          trigger: {
            type: 'comment',
            instagram_media_id: POST,
            instagram_comment_id: OTHER_COMMENT,
            text: 'price',
          },
        },
        queuedEntry(deleted),
        queuedEntry(queuedWithEmail),
      ],
    });
    const queuedLog = addCommentLog({
      id: 902,
      automation_id: queuedPlain.id,
      automation_run_id: null,
      instagram_comment_id: OTHER_COMMENT,
      overall_status: 'ignored',
      ignored_reason: 'waiting_for_other_email',
    });

    const result = await storyReply();

    const [plainRun, emailRun] = engine.rows.runs.filter((candidate) => candidate.id > 1000);
    expect(result).toEqual({
      outcome: 'run_continued',
      runPublicIds: [run.public_id, plainRun?.public_id, emailRun?.public_id],
      failedErrorType: null,
    });
    expect(run).toMatchObject({ status: 'completed', queued_automations: [] });
    expect(plainRun).toMatchObject({ automation_id: queuedPlain.id, status: 'completed' });
    expect(queuedLog).toMatchObject({
      overall_status: 'completed',
      ignored_reason: null,
      automation_run_id: plainRun?.id,
    });
    expect(emailRun).toMatchObject({
      automation_id: queuedWithEmail.id,
      status: 'waiting',
      waiting_for: 'email',
    });
    expect(sentKinds()).toEqual(['final_message', 'final_message', 'email_question']);
  });

  it('only an email wait starts its queue: a phone or follow wait off leaves it (AU21)', async () => {
    const queued = addAutomation({ id: 21 });
    addAutomation();
    const run = addRunWithStepOff({
      waiting_for: 'phone',
      current_step: 'phone_collect',
      queued_automations: [queuedEntry(queued)],
    });

    await storyReply();

    expect(run.status).toBe('completed');
    expect(engine.rows.runs).toHaveLength(1);
  });

  it('a DM is not its answer: the DM then starts the automation its keyword names', async () => {
    addAutomation({ keywords: ['catalog'] });
    const keyword = addAutomation({ id: 18, keywords: ['link'], trigger_type: 'dm' });
    const run = addRunWithStepOff();

    const result = await directMessage({ text: 'link please' });

    const started = engine.rows.runs.at(-1) as AutomationRunRow;
    expect(started).toMatchObject({ automation_id: keyword.id, status: 'completed' });
    expect(run.status).toBe('completed');
    expect(result).toEqual({
      outcome: 'run_started',
      runPublicIds: [started.public_id, run.public_id],
      failedErrorType: null,
    });
  });

  it('a DM goes to the next run that does wait for an answer', async () => {
    addAutomation();
    addAutomation({ id: 18, is_phone_collection_enabled: true });
    const emailRun = addRunWithStepOff();
    const phoneRun = addRun({
      id: 502,
      automation_id: 18,
      waiting_for: 'phone',
      current_step: 'phone_collect',
    });

    const result = await directMessage({ text: '+14155550100' });

    expect(engine.contactService.recordContactPhone).toHaveBeenCalledWith(
      expect.objectContaining({ phone: '+14155550100' }),
    );
    expect(engine.contactService.recordContactEmail).not.toHaveBeenCalled();
    expect([phoneRun.status, emailRun.status]).toEqual(['completed', 'completed']);
    expect(result.runPublicIds).toEqual([phoneRun.public_id, emailRun.public_id]);
  });

  it.each<[string, () => Promise<AutomationRunHandlingResult>]>([
    ['a comment', () => comment({ instagramCommentId: OTHER_COMMENT })],
    ['a story reply', () => storyReply()],
  ])(
    '%s on another automation is not held back by it: that automation starts, nothing is queued',
    async (_case, handle) => {
      addAutomation({ keywords: ['catalog'] });
      const other = addAutomation({ id: 18, keywords: ['link'] });
      addAutomation({ id: 19, trigger_type: 'story_reply', keywords: [] });
      const run = addRunWithStepOff();

      const result = await handle();

      const started = engine.rows.runs.at(-1) as AutomationRunRow;
      expect([other.id, 19]).toContain(started.automation_id);
      expect([started.status, run.status]).toEqual(['completed', 'completed']);
      expect(result).toMatchObject({
        outcome: 'run_started',
        runPublicIds: [started.public_id, run.public_id],
      });
      expect(engine.store.runs.replaceQueuedAutomations).not.toHaveBeenCalledWith(
        expect.objectContaining({ entries: expect.arrayContaining([expect.anything()]) }),
      );
    },
  );

  it('a click on another run is continued, not answered with the email question', async () => {
    addAutomation({ keywords: ['catalog'] });
    const clickedAutomation = addAutomation({ id: 18 });
    const run = addRunWithStepOff();
    const clicked = addRun({
      id: 502,
      automation_id: 18,
      waiting_for: 'opening_message_button',
      current_step: 'comment_reply',
    });

    const result = await click({
      automationPublicId: clickedAutomation.public_id,
      runPublicId: clicked.public_id,
    });

    expect(result).toEqual({
      outcome: 'run_continued',
      runPublicIds: [clicked.public_id, run.public_id],
      failedErrorType: null,
    });
    expect([clicked.status, run.status]).toEqual(['completed', 'completed']);
    expect(sentKinds()).toEqual(['final_message', 'final_message']);
  });

  it('a click on its own "I’m following" button continues it once, as the click', async () => {
    const automation = addAutomation();
    const run = addRunWithStepOff({ waiting_for: 'follow', current_step: 'follow_check' });

    expect(
      await click({ automationPublicId: automation.public_id, runPublicId: run.public_id }),
    ).toEqual({
      outcome: 'run_continued',
      runPublicIds: [run.public_id],
      failedErrorType: null,
    });
    expect(eventTrail(run.id)).toEqual(['status_changed:running', 'status_changed:completed']);
    expect(engine.messageService.readFollowStatus).not.toHaveBeenCalled();
  });

  it('a comment on its own automation is already_waiting, and the run goes on', async () => {
    addAutomation();
    const run = addRunWithStepOff();

    const result = await comment({ instagramCommentId: OTHER_COMMENT });

    expect(engine.rows.commentLogs).toEqual([
      expect.objectContaining({ ignored_reason: 'already_waiting', automation_run_id: null }),
    ]);
    expect(run.status).toBe('completed');
    expect(result).toMatchObject({ outcome: 'run_continued', runPublicIds: [run.public_id] });
  });

  it('a trigger of an automation already queued behind it starts that automation once (AU21)', async () => {
    addAutomation({ keywords: ['catalog'] });
    const queued = addAutomation({ id: 18, keywords: ['link'] });
    const run = addRunWithStepOff({ queued_automations: [queuedEntry(queued)] });

    const result = await comment({ instagramCommentId: OTHER_COMMENT });

    const started = engine.rows.runs.filter((candidate) => candidate.id > 1000);
    expect(started).toEqual([
      expect.objectContaining({
        automation_id: queued.id,
        trigger_instagram_comment_id: OTHER_COMMENT,
      }),
    ]);
    expect(run).toMatchObject({ status: 'completed', queued_automations: [] });
    expect(result.runPublicIds).toEqual([started[0]?.public_id, run.public_id]);
  });

  it.each<[string, Date | null]>([
    ['never opened', null],
    ['closed since', new Date(Date.now() - DAY_MILLISECONDS - 60_000)],
  ])(
    'waits on at a comment when the messaging window is %s: no DM could reach the contact (3.B.10)',
    async (_case, lastDirectMessageReceivedAt) => {
      addAutomation({ keywords: ['catalog'] });
      const other = addAutomation({ id: 18, keywords: ['link'] });
      const queued = addAutomation({ id: 21, keywords: ['never'] });
      const run = addRunWithStepOff({ queued_automations: [queuedEntry(queued)] });
      Object.assign(engine.contact, {
        last_direct_message_received_at: lastDirectMessageReceivedAt,
      });

      const result = await comment({ instagramCommentId: OTHER_COMMENT });

      // The comment's own automation starts all the same: its one private reply is its own.
      const started = engine.rows.runs.at(-1) as AutomationRunRow;
      expect(started).toMatchObject({ automation_id: other.id, status: 'completed' });
      expect(
        engine.messageService.sendDirectMessage.mock.calls.map(([input]) => input.recipient),
      ).toEqual([{ comment_id: OTHER_COMMENT }]);
      expect(result).toMatchObject({ outcome: 'run_started', runPublicIds: [started.public_id] });
      expect(run).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
        queued_automations: [queuedEntry(queued)],
      });

      // Its next DM opens the window: the run goes on then.
      Object.assign(engine.contact, { last_direct_message_received_at: new Date() });
      await directMessage({ text: 'hello' });
      expect(run).toMatchObject({ status: 'completed', queued_automations: [] });
    },
  );

  it('a question asked again goes to a run whose email step is still on; the other goes on after it', async () => {
    addEmailFirst();
    addAutomation({ keywords: ['catalog'] });
    const chosen = addAutomation({ id: 18, keywords: ['link'] });
    const stepOff = addRunWithStepOff();
    const stepOn = addRun({ id: 502, automation_id: EMAIL_FIRST_ID });

    const result = await comment({ instagramCommentId: OTHER_COMMENT });

    expect(stepOn.queued_automations).toEqual([
      expect.objectContaining({ automation_id: chosen.public_id }),
    ]);
    expect(stepOff).toMatchObject({ status: 'completed', queued_automations: [] });
    expect(sentKinds()).toEqual(['email_question', 'final_message']);
    expect(result).toEqual({
      outcome: 'question_asked_again',
      runPublicIds: [stepOn.public_id, stepOff.public_id],
      failedErrorType: null,
    });
  });

  it('a question whose step is turned off before it goes is not asked: the run goes on instead', async () => {
    const emailFirst = addEmailFirst();
    addAutomation();
    const waiting = addRun({ automation_id: EMAIL_FIRST_ID });
    engine.store.commentLogs.insertMany.mockImplementationOnce(async () => {
      Object.assign(emailFirst, { is_email_collection_enabled: false });
      return [];
    });

    const result = await comment();

    expect(waiting).toMatchObject({ status: 'completed', queued_automations: [] });
    expect(sentKinds()).not.toContain('email_question');
    expect(result.runPublicIds).toHaveLength(2);
  });

  it.each<[string, (automation: AutomationRow) => void]>([
    [
      'its automation was deleted',
      (automation) => Object.assign(automation, { deleted_at: new Date() }),
    ],
    [
      'its automation is another account’s',
      (automation) => Object.assign(automation, { instagram_account_id: OTHER_ACCOUNT_ID }),
    ],
  ])('stays as it is when %s', async (_case, change) => {
    const run = addRunWithStepOff();
    change(addAutomation());

    expect((await directMessage({ text: 'hello' })).outcome).toBe('nothing_matched');

    expect(run).toMatchObject({ status: 'waiting', waiting_for: 'email' });
    expect(engine.instagramCalls).toEqual([]);
  });

  it('an inactive automation’s run goes on too: turning it off stops new runs only', async () => {
    addAutomation({ status: 'inactive' });
    const run = addRunWithStepOff();

    await directMessage({ text: 'hello' });

    expect(run.status).toBe('completed');
  });

  it('a run whose step is still on waits on, whatever else its automation turned off', async () => {
    addAutomation({ is_email_collection_enabled: true });
    const run = addRunWithStepOff();
    addAutomation({ id: 18, ...openingOn });
    const openingRun = addRun({
      id: 502,
      automation_id: 18,
      waiting_for: 'opening_message_button',
      current_step: 'comment_reply',
    });

    expect((await storyReply()).outcome).toBe('nothing_matched');

    expect([run.waiting_for, openingRun.waiting_for]).toEqual(['email', 'opening_message_button']);
    expect(engine.instagramCalls).toEqual([]);
  });

  it('a claim an event that died left on it is cleared, never re-sent: the run goes on', async () => {
    addAutomation();
    const run = addRunWithStepOff({
      sending_message_kind: 'email_question',
      sending_started_at: new Date(),
    });

    await directMessage({ text: 'hello' });

    expect(run).toMatchObject({ status: 'completed', sending_message_kind: null });
    expect(sentKinds()).toEqual(['final_message']);
  });

  it('a dead token ends the event: the waiting run is left to a later one', async () => {
    addAutomation({ keywords: ['catalog'] });
    addAutomation({ id: 18, keywords: ['link'] });
    const run = addRunWithStepOff();
    engine.outcomes.sends.push(deadToken());

    expect((await comment({ instagramCommentId: OTHER_COMMENT })).failedErrorType).toBe('token');

    expect(run).toMatchObject({ status: 'waiting', waiting_for: 'email' });
  });

  it('a dead token met by the run itself is answered, whatever the event’s own run failed with', async () => {
    addAutomation({ keywords: ['catalog'] });
    addAutomation({ id: 18, keywords: ['link'] });
    const run = addRunWithStepOff();
    engine.outcomes.sends.push(refused(), deadToken());

    const result = await comment({ instagramCommentId: OTHER_COMMENT });

    expect(result.failedErrorType).toBe('token');
    expect(run.status).toBe('failed');
    expect(engine.accountService.markConnectionBroken).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => Promise<AutomationRunHandlingResult>]>([
    ['a comment', () => comment({ text: 'hello', instagramCommentId: OTHER_COMMENT })],
    ['a DM', () => directMessage({ text: 'hello' })],
    ['a story reply', () => storyReply()],
    ['a click', () => click({ automationPublicId: 'aut_none', runPublicId: 'run_none' })],
  ])(
    'a temporary failure of %s leaves it running: the retry resumes it, its queue started once',
    async (_case, handle) => {
      const queued = addAutomation({ id: 21, keywords: ['never'] });
      addAutomation({ keywords: ['catalog'] });
      const run = addRunWithStepOff({ queued_automations: [queuedEntry(queued)] });
      const throttle = throttled();
      engine.outcomes.sends.push(throttle);

      await expect(handle()).rejects.toBe(throttle.error);
      expect(run).toMatchObject({ status: 'running', sending_message_kind: null });

      expect(await handle()).toMatchObject({ outcome: 'run_resumed', failedErrorType: null });

      expect(run.status).toBe('completed');
      expect(engine.rows.runs.filter((candidate) => candidate.automation_id === queued.id)).toEqual(
        [expect.objectContaining({ status: 'completed' })],
      );
      expect(sentKinds()).toEqual(['final_message', 'final_message', 'final_message']);
      expect((await handle()).outcome).toBe('already_handled');
    },
  );

  it('a question that could not go for now is asked by the retry, and only then the run goes on', async () => {
    addEmailFirst();
    addAutomation({ keywords: ['catalog'] });
    addAutomation({ id: 18, trigger_type: 'story_reply', keywords: [] });
    const stepOff = addRunWithStepOff();
    const stepOn = addRun({ id: 502, automation_id: EMAIL_FIRST_ID });
    const throttle = throttled();
    engine.outcomes.sends.push(throttle);

    await expect(storyReply()).rejects.toBe(throttle.error);
    expect(stepOff.status).toBe('waiting');

    expect(await storyReply()).toEqual({
      outcome: 'question_asked_again',
      runPublicIds: [stepOn.public_id, stepOff.public_id],
      failedErrorType: null,
    });
    expect(stepOff.status).toBe('completed');
    expect(sentKinds()).toEqual(['email_question', 'email_question', 'final_message']);
  });

  it('a retried comment held back by an email step turned off since asks nothing: the run goes on', async () => {
    addAutomation({ keywords: ['catalog'] });
    const queued = addAutomation({ id: 18 });
    const run = addRunWithStepOff({ queued_automations: [queuedEntry(queued)] });
    addCommentLog({
      automation_id: queued.id,
      automation_run_id: null,
      overall_status: 'ignored',
      ignored_reason: 'waiting_for_other_email',
    });

    const result = await comment();

    const started = engine.rows.runs.at(-1) as AutomationRunRow;
    expect(result).toEqual({
      outcome: 'run_continued',
      runPublicIds: [run.public_id, started.public_id],
      failedErrorType: null,
    });
    expect(sentKinds()).toEqual(['final_message', 'final_message']);
  });

  it('an erased contact’s run is cancelled, never moved on', async () => {
    addAutomation();
    const run = addRunWithStepOff();
    eraseContact();

    expect((await directMessage({ text: 'hello' })).outcome).toBe('ignored');

    expect(run.status).toBe('cancelled');
    expect(engine.instagramCalls).toEqual([]);
  });
});

describe('the public reply (AU20)', () => {
  beforeEach(() => {
    addAutomation({
      is_public_reply_enabled: true,
      public_reply_texts: ['Sent!', 'Check your DMs'],
    });
  });

  it('asks reply safety with the account’s settings and the automation’s texts, and sends what it picked', async () => {
    await comment();

    expect(engine.replySafetyService.decide).toHaveBeenCalledWith({
      commentLogRepository: engine.store.commentLogs,
      settings,
      organizationId: ORGANIZATION_ID,
      automationId: 17,
      instagramCommentId: COMMENT,
      replyTexts: ['Sent!', 'Check your DMs'],
      now: expect.any(Date),
    });
    expect(engine.messageService.sendPublicReply).toHaveBeenCalledWith(
      expect.objectContaining({
        instagramCommentId: COMMENT,
        text: 'Sent!',
        requestId: REQUEST_ID,
      }),
    );
    expect(engine.rows.commentLogs[0]).toMatchObject({
      public_reply_status: 'sent',
      public_reply_text: 'Sent!',
      public_reply_at: expect.any(Date),
    });
  });

  it.each(['duplicate', 'random', 'hour_limit', 'gap'] as const)(
    'logs the skip %s and never holds the DM back',
    async (skipReason) => {
      engine.replySafetyService.decide.mockResolvedValueOnce({ kind: 'skip', skipReason });

      expect((await comment()).failedErrorType).toBeNull();

      expect(engine.messageService.sendPublicReply).not.toHaveBeenCalled();
      expect(sentKinds()).toEqual(['final_message']);
      expect(engine.rows.commentLogs[0]).toMatchObject({
        public_reply_status: 'skipped',
        public_reply_skip_reason: skipReason,
        overall_status: 'completed',
      });
    },
  );

  it.each([
    ['refused', refused(), 'instagram_api'],
    ['temporarily refused', throttled(), 'instagram_api'],
    ['of unknown outcome', unknownOutcome(), 'network'],
  ])('a reply %s is logged failed and the flow goes on', async (_case, result, errorType) => {
    engine.outcomes.publicReplies.push(result);

    expect((await comment()).failedErrorType).toBeNull();

    expect(engine.rows.runs[0]?.status).toBe('completed');
    expect(engine.rows.commentLogs[0]).toMatchObject({
      public_reply_status: 'failed',
      public_reply_text: null,
      error_type: errorType,
      overall_status: 'completed',
    });
  });

  it('a dead token fails the run at the public reply and marks the account broken', async () => {
    engine.outcomes.publicReplies.push(deadToken('expired'));

    expect((await comment()).failedErrorType).toBe('token');

    expect(engine.rows.runs[0]).toMatchObject({ status: 'failed', sending_message_kind: null });
    expect(engine.rows.commentLogs[0]).toMatchObject({
      overall_status: 'failed',
      failed_step: 'public_reply',
      error_type: 'token',
    });
    expect(engine.accountService.markConnectionBroken).toHaveBeenCalledTimes(1);
    expect(engine.messageService.sendDirectMessage).not.toHaveBeenCalled();
  });

  it('a claim a crash left on it is never sent again: logged failed, the flow goes on (AQ5)', async () => {
    const run = addRun({
      trigger_type: 'comment',
      trigger_instagram_comment_id: COMMENT,
      status: 'running',
      current_step: 'comment_reply',
      waiting_for: null,
      sending_message_kind: 'public_reply',
      last_instagram_event_key: `comment:${COMMENT}`,
    });
    addCommentLog();

    expect(await comment()).toMatchObject({ outcome: 'run_resumed', failedErrorType: null });

    expect(engine.messageService.sendPublicReply).not.toHaveBeenCalled();
    expect(run.status).toBe('completed');
    expect(engine.rows.commentLogs[0]).toMatchObject({
      public_reply_status: 'failed',
      error_type: 'network',
      error_reason: 'send_outcome_unknown',
    });
  });

  it('a run cancelled while its reply went logs the reply and sends no DM', async () => {
    engine.messageService.sendPublicReply.mockImplementationOnce(async () => {
      Object.assign(engine.rows.runs[0] as AutomationRunRow, { status: 'cancelled' });
      return delivered;
    });

    await comment();

    expect(engine.rows.runs[0]?.status).toBe('cancelled');
    expect(engine.rows.commentLogs[0]).toMatchObject({ public_reply_status: 'sent' });
    expect(engine.messageService.sendDirectMessage).not.toHaveBeenCalled();
  });
});

describe('the follow check (AU18 step 3)', () => {
  beforeEach(() => {
    addAutomation({ is_follow_required: true, follow_request_message: followRequest });
  });

  it('a follower goes straight on: saved on the contact, the step skipped, nothing asked', async () => {
    await comment();

    expect(sentKinds()).toEqual(['final_message']);
    expect(engine.contactService.recordContactProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: CONTACT_ID,
        profile: { isFollowingAccount: true },
        checkedAt: expect.any(Date),
      }),
    );
    expect(engine.rows.commentLogs[0]).toMatchObject({
      follow_status: 'skipped',
      follow_confirmed_at: null,
    });
  });

  it('a follow confirmed after the request closes the step as done', async () => {
    const automation = engine.rows.automations[0] as AutomationRow;
    const run = addRun({
      trigger_type: 'comment',
      trigger_instagram_comment_id: COMMENT,
      current_step: 'follow_check',
      waiting_for: 'follow',
    });
    addCommentLog({ follow_status: 'waiting', overall_status: 'waiting' });

    await click({ automationPublicId: automation.public_id, runPublicId: run.public_id });

    expect(engine.rows.commentLogs[0]).toMatchObject({
      follow_status: 'done',
      follow_confirmed_at: expect.any(Date),
      overall_status: 'completed',
    });
  });

  it.each([
    ['is not following', false, 1],
    ['Instagram will not say', null, 0],
  ])('asks for the follow when the contact %s, then waits', async (_case, isFollowing, saved) => {
    engine.outcomes.followReads.push({ outcome: 'read', isFollowing, profile: null });

    await comment();

    expect(sentKinds()).toEqual(['follow_request']);
    expect(engine.contactService.recordContactProfile).toHaveBeenCalledTimes(saved);
    expect(engine.rows.runs[0]).toMatchObject({ status: 'waiting', waiting_for: 'follow' });
    expect(engine.rows.commentLogs[0]).toMatchObject({
      follow_status: 'waiting',
      waiting_for: 'follow',
      current_step: 'follow_check',
      overall_status: 'waiting',
    });
  });

  it('rethrows a read that failed for now: the run stays where it was', async () => {
    const failure = new Error('timeout');
    engine.outcomes.followReads.push({
      outcome: 'temporary',
      error: failure,
      errorType: 'network',
    });

    await expect(comment()).rejects.toBe(failure);

    expect(engine.rows.runs[0]).toMatchObject({ status: 'running', current_step: 'follow_check' });
    expect(engine.accountService.markConnectionBroken).not.toHaveBeenCalled();
  });

  it('fails the run when the read still fails on the last attempt', async () => {
    engine.outcomes.followReads.push({
      outcome: 'temporary',
      error: new Error('timeout'),
      errorType: 'network',
    });

    expect((await comment({ isLastAttempt: true })).failedErrorType).toBe('network');

    expect(engine.rows.runs[0]).toMatchObject({
      status: 'failed',
      error_message: 'network:follow_read_failed',
    });
    expect(engine.rows.commentLogs[0]).toMatchObject({ failed_step: 'follow_check' });
  });

  it('fails the run on a dead token and marks the account broken', async () => {
    engine.outcomes.followReads.push(deadToken('error'));

    expect((await comment()).failedErrorType).toBe('token');
    expect(engine.rows.runs[0]?.status).toBe('failed');
    expect(engine.accountService.markConnectionBroken).toHaveBeenCalledWith(
      expect.objectContaining({ connectionStatus: 'error' }),
    );
  });

  it('a run cancelled during the read is left alone, its contact too', async () => {
    engine.messageService.readFollowStatus.mockImplementationOnce(async () => {
      Object.assign(engine.rows.runs[0] as AutomationRunRow, { status: 'cancelled' });
      return { outcome: 'read', isFollowing: true, profile: null };
    });

    await comment();

    expect(engine.contactService.recordContactProfile).not.toHaveBeenCalled();
    expect(engine.messageService.sendDirectMessage).not.toHaveBeenCalled();
  });
});

describe('the hooks other callers run', () => {
  it('an automation delete cancels its open runs, with an event each and their logs (AU12)', async () => {
    addRun({ id: 501 });
    addRun({ id: 502, status: 'running' });
    addRun({ id: 503, status: 'completed' });
    addRun({ id: 504, automation_id: 18 });

    await expect(
      engine.service.cancelAutomationOpenRuns({
        organizationId: ORGANIZATION_ID,
        automationId: 17,
      }),
    ).resolves.toBe(2);

    expect(engine.rows.runEvents).toEqual([
      '501:status_changed:cancelled',
      '502:status_changed:cancelled',
    ]);
    expect(engine.store.commentLogs.markRunsCancelled).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      runIds: [501, 502],
    });
    // It joins the route's own transaction: no unit, no job handle and no contact lock of its own.
    expect(withAppDatabaseContext).not.toHaveBeenCalled();
    expect(engine.contactService.lockLiveContact).not.toHaveBeenCalled();
    expect(createWorkerAutomationRunEventRepository).not.toHaveBeenCalled();
  });

  it('an automation without open runs cancels none and writes nothing', async () => {
    addRun({ status: 'completed' });

    await expect(
      engine.service.cancelAutomationOpenRuns({
        organizationId: ORGANIZATION_ID,
        automationId: 17,
      }),
    ).resolves.toBe(0);

    expect(engine.store.runEvents.insertMany).not.toHaveBeenCalled();
    expect(engine.store.commentLogs.markRunsCancelled).not.toHaveBeenCalled();
  });

  it('a contact erase cancels its open runs first, then clears every copy (AU26)', async () => {
    addRun();
    const key = { organizationId: ORGANIZATION_ID, contactId: CONTACT_ID };

    await engine.service.eraseContactRunCopies({ ...key, databaseHandle: {} } as never);

    // The erase that runs it already holds the contact `FOR UPDATE`; the automations come next (D47).
    expect(engine.contactService.lockLiveContact).not.toHaveBeenCalled();
    expect(engine.store.automations.lockForRunChanges).toHaveBeenCalledExactlyOnceWith({
      organizationId: ORGANIZATION_ID,
      automationIds: [17],
    });
    expect(engine.store.automations.lockForRunChanges.mock.invocationCallOrder[0]).toBeLessThan(
      engine.store.runs.cancelOpenRunsOfContact.mock.invocationCallOrder[0] as number,
    );
    expect(engine.rows.runEvents).toEqual(['501:status_changed:cancelled']);
    expect(engine.store.runs.eraseContactCopies).toHaveBeenCalledWith(key);
    expect(engine.store.commentLogs.eraseContactCopies).toHaveBeenCalledWith(key);
    expect(engine.store.runs.cancelOpenRunsOfContact.mock.invocationCallOrder[0]).toBeLessThan(
      engine.store.runs.eraseContactCopies.mock.invocationCallOrder[0] as number,
    );
  });

  it('a contact with no open run still has its copies cleared', async () => {
    await engine.service.eraseContactRunCopies({
      organizationId: ORGANIZATION_ID,
      contactId: CONTACT_ID,
    } as never);

    expect(engine.store.runEvents.insertMany).not.toHaveBeenCalled();
    expect(engine.store.runs.eraseContactCopies).toHaveBeenCalledTimes(1);
    expect(engine.store.commentLogs.eraseContactCopies).toHaveBeenCalledTimes(1);
  });

  it('the 7-day wait cancels only the runs that still wait, all on the job’s handle (AU25)', async () => {
    addRun({ id: 501 });
    addRun({ id: 502, status: 'running' });
    const databaseHandle = { name: 'job handle' } as unknown as WorkerDatabaseHandle;
    const waitingSinceBefore = new Date('2026-11-14T09:00:00.000Z');

    await expect(
      engine.service.cancelExpiredWaitingRuns({
        databaseHandle,
        organizationId: ORGANIZATION_ID,
        runIds: [501, 502],
        waitingSinceBefore,
      }),
    ).resolves.toBe(1);

    expect(engine.store.runs.cancelExpiredWaitingRuns).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      runIds: [501, 502],
      waitingSinceBefore,
    });
    expect(engine.rows.runEvents).toEqual(['501:status_changed:cancelled']);
    expect(engine.store.commentLogs.markRunsCancelled).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      runIds: [501],
    });
    for (const factory of [
      createWorkerAutomationRunRepository,
      createWorkerAutomationRunEventRepository,
      createWorkerAutomationCommentLogRepository,
    ]) {
      expect(factory).toHaveBeenCalledWith(databaseHandle);
    }
  });
});
