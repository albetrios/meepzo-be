import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { encryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';
import type {
  AutomationBackfillRead,
  AutomationBackfillReadBegin,
} from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.types.js';
import {
  META_GRAPH_BASE_URL,
  META_GRAPH_VERSION,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type { InstagramSendTicketContext } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import type { enqueueInstagramTask } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.queue.js';
import type { InstagramWebhookIntakeEnqueue } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';
import type { NewInstagramWebhookEvent } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import {
  createInstagramPastCommentReadTaskHandler,
  enqueueInstagramPastCommentRead,
  type InstagramPastCommentReadServices,
} from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-past-comment-read.processor.js';

// The `meta` circuit in memory — no Redis, never opened by these few failures.
vi.mock('@/infrastructure/resilience/circuit-breaker.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/infrastructure/resilience/circuit-breaker.js')>();
  return {
    ...actual,
    metaGraphCircuit: new actual.CircuitBreaker({
      name: 'meta',
      failureThreshold: 50,
      resetTimeoutMs: 60_000,
    }),
  };
});

/**
 * The past-comments read (feat-instagram-dm-sending § 4.C AU32, AUC12; worker-changes WC-41; ROUTE
 * row R41 — AC-8.4–AC-8.6): Meta through nock only. The read's posts by the automation's target,
 * each post's comments of the asked days (never older than 7 days minus 30 minutes) saved through
 * the webhook's store function and handed to comment intake at the low priority, the numbers, the
 * 80 % wait, Meta's retries then `meta_error`, and one read at a time per account.
 */

const ORGANIZATION_PUBLIC_ID = 'org_acmeshop000000000001';
const ACCOUNT_PUBLIC_ID = 'cha_acmeshop000000000001';
const BACKFILL_PUBLIC_ID = 'abf_acmeshop000000000001';
const ACCOUNT_INSTAGRAM_USER_ID = '17841400000000001';
const ACCOUNT_TOKEN = 'EAAG-past-comment-token';
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const NOW = new Date('2026-11-25T12:00:00Z');
const STARTED_AT = new Date('2026-11-25T11:59:00.123Z');

function graph(): nock.Scope {
  return nock(META_GRAPH_BASE_URL).matchHeader('authorization', `Bearer ${ACCOUNT_TOKEN}`);
}

function comment({
  id,
  ageMilliseconds,
  text = 'price please',
  fromId = '9000000000000001',
}: {
  id: string;
  ageMilliseconds: number;
  text?: string;
  fromId?: string;
}) {
  return {
    id,
    text,
    timestamp: new Date(NOW.getTime() - ageMilliseconds).toISOString(),
    from: { id: fromId, username: 'acme_customer' },
  };
}

function commentsOf(mediaId: string): nock.Interceptor {
  return graph()
    .get(`/${META_GRAPH_VERSION}/${mediaId}/comments`)
    .query((query) => query.limit === '50');
}

function mediaPage(): nock.Interceptor {
  return graph()
    .get(`/${META_GRAPH_VERSION}/${ACCOUNT_INSTAGRAM_USER_ID}/media`)
    .query((query) => query.limit === '25');
}

type Target = NonNullable<AutomationBackfillRead['target']>;

const ANY_POST: Target = {
  automationPublicId: 'aut_acmeshop000000000001',
  status: 'live',
  trigger_type: 'comment',
  target_scope: 'any',
  target_instagram_media_id: null,
  target_starts_at: null,
  target_ends_at: null,
  keywords: ['price'],
  ad_id: null,
};

interface Harness {
  services: InstagramPastCommentReadServices;
  saved: NewInstagramWebhookEvent[][];
  progress: Array<Record<string, number>>;
  finished: unknown[];
  enqueueTask: ReturnType<typeof vi.fn<typeof enqueueInstagramTask>>;
  enqueueIntake: ReturnType<typeof vi.fn<InstagramWebhookIntakeEnqueue>>;
  begin: ReturnType<typeof vi.fn>;
}

function harness({
  target = ANY_POST,
  days = 3,
  usagePercent = 10,
  begun,
  alreadySavedKeys = [],
  isStillReading = true,
}: {
  target?: Target;
  days?: number;
  usagePercent?: number;
  begun?: AutomationBackfillReadBegin;
  alreadySavedKeys?: string[];
  isStillReading?: boolean;
}): Harness {
  const saved: NewInstagramWebhookEvent[][] = [];
  const progress: Harness['progress'] = [];
  const finished: unknown[] = [];
  const read: AutomationBackfillRead = {
    key: { organizationId: 1, automationBackfillId: 7 },
    automationBackfillPublicId: BACKFILL_PUBLIC_ID,
    startedAt: STARTED_AT,
    days,
    target,
  };
  const begin = vi.fn(async () => begun ?? { kind: 'reading' as const, read });
  const services = {
    instagramSendAccessService: {
      readSendAccess: vi.fn(async () => ({
        channelAccount: { organizationId: 1, channelAccountId: 2 },
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        channelConnection: { organizationId: 1, channelConnectionId: 4 },
        channelConnectionPublicId: 'chc_acmeshop000000000001',
        clientBusinessId: '5550000000000001',
        instagramUserId: ACCOUNT_INSTAGRAM_USER_ID,
        encryptedAccessToken: encryptFieldSecret(ACCOUNT_TOKEN),
        isSendable: true,
      })),
      readUsagePercent: vi.fn(async () => usagePercent),
      buildUsageRecorder: vi.fn(() => undefined),
    },
    instagramAccountSettingsService: {
      findSettings: vi.fn(async () => ({ is_comment_reply_trigger_enabled: false })),
    },
    automationBackfillService: {
      beginAutomationBackfillRead: begin,
      recordAutomationBackfillProgress: vi.fn(async (input: Record<string, number>) => {
        const { postsRead, found, matched, queuedCount } = input;
        progress.push({
          postsRead: postsRead ?? 0,
          found: found ?? 0,
          matched: matched ?? 0,
          queuedCount: queuedCount ?? 0,
        });
        return isStillReading;
      }),
      finishAutomationBackfillRead: vi.fn(async ({ failure }: { failure: unknown }) => {
        finished.push(failure);
        return true;
      }),
    },
    instagramWebhookEventService: {
      recordReceivedEvents: vi.fn(async ({ events }: { events: NewInstagramWebhookEvent[] }) => {
        saved.push(events);
        return events
          .filter((event) => !alreadySavedKeys.includes(event.eventKey))
          .map((event) => ({ event_key: event.eventKey }));
      }),
    },
  } as unknown as InstagramPastCommentReadServices;
  return {
    services,
    saved,
    progress,
    finished,
    enqueueTask: vi.fn<typeof enqueueInstagramTask>(async () => undefined),
    enqueueIntake: vi.fn<InstagramWebhookIntakeEnqueue>(async () => undefined),
    begin,
  };
}

const CONTEXT: InstagramSendTicketContext = {
  jobId: 'automation-backfill-read-job-1',
  runInDatabaseSlot: (callback) => callback(),
  returnTicket: async () => {
    throw new Error('not expected');
  },
};

async function runRead(
  testHarness: Harness,
  taskInput: Record<string, unknown> = { channelAccountPublicId: ACCOUNT_PUBLIC_ID },
): Promise<void> {
  const handler = createInstagramPastCommentReadTaskHandler({
    services: testHarness.services,
    wait: async () => undefined,
    readNow: () => NOW,
    enqueueTask: testHarness.enqueueTask,
    enqueueIntake: testHarness.enqueueIntake,
  });
  await handler.run({
    organizationPublicId: ORGANIZATION_PUBLIC_ID,
    taskInput: handler.inputSchema.parse(taskInput),
    context: CONTEXT,
  });
}

/** The task inputs the read added (resumes and wake-ups), with their delays. */
function addedTasks(testHarness: Harness) {
  return testHarness.enqueueTask.mock.calls.map(([task]) => ({
    taskInput: task.taskInput,
    delayMilliseconds: task.delayMilliseconds,
    priority: task.priority,
  }));
}

beforeEach(async () => {
  await metaGraphCircuit.reset();
});

afterEach(() => {
  const pending = nock.pendingMocks();
  nock.cleanAll();
  expect(pending).toEqual([]);
});

describe('the past-comments read (WC-41)', () => {
  it('"any post": the newest posts with comments, the days asked, own comments left out; found, matched, queued; intake at the low priority (AC-8.4, AC-8.6)', async () => {
    const testHarness = harness({ alreadySavedKeys: ['comment:1702'] });
    mediaPage().reply(200, {
      data: [
        { id: '1801', timestamp: new Date(NOW.getTime() - DAY).toISOString(), comments_count: 3 },
        // No comments: not read.
        { id: '1802', timestamp: new Date(NOW.getTime() - DAY).toISOString(), comments_count: 0 },
      ],
    });
    commentsOf('1801').reply(200, {
      data: [
        comment({ id: '1701', ageMilliseconds: 1 * DAY }),
        // Already delivered by Meta: its key is used — found and matched, not queued again.
        comment({ id: '1702', ageMilliseconds: 2 * DAY }),
        comment({ id: '1703', ageMilliseconds: 2 * DAY, text: 'love it' }),
        // The account's own comment: never an event.
        comment({ id: '1704', ageMilliseconds: DAY, fromId: ACCOUNT_INSTAGRAM_USER_ID }),
        // Older than the 3 days asked: the read stops here, Meta's next page is never asked for.
        comment({ id: '1705', ageMilliseconds: 4 * DAY }),
      ],
      paging: { cursors: { after: 'more' }, next: 'https://graph.facebook.com/next' },
    });

    await runRead(testHarness);

    expect(testHarness.saved.map((events) => events.map((event) => event.eventKey))).toEqual([
      ['comment:1701', 'comment:1702', 'comment:1703'],
    ]);
    expect(testHarness.progress).toEqual([{ postsRead: 1, found: 3, matched: 2, queuedCount: 1 }]);
    expect(testHarness.enqueueIntake).toHaveBeenCalledWith({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      intakeKind: 'comments',
      requestId: 'automation-backfill-read-job-1',
      priority: 10,
    });
    expect(testHarness.finished).toEqual([null]);
    // The account's next queued read is woken, at the queue's lowest priority.
    expect(addedTasks(testHarness)).toEqual([
      {
        taskInput: { channelAccountPublicId: ACCOUNT_PUBLIC_ID },
        delayMilliseconds: undefined,
        priority: 20,
      },
    ]);
  });

  it('never saves a comment older than 7 days minus 30 minutes, even when 7 days are asked (AC-8.5)', async () => {
    const testHarness = harness({
      days: 7,
      target: { ...ANY_POST, target_scope: 'specific', target_instagram_media_id: '1801' },
    });
    commentsOf('1801').reply(200, {
      data: [
        comment({ id: '1701', ageMilliseconds: 7 * DAY - 31 * MINUTE }),
        comment({ id: '1702', ageMilliseconds: 7 * DAY - 29 * MINUTE }),
      ],
    });

    await runRead(testHarness);

    expect(testHarness.saved.map((events) => events.map((event) => event.eventKey))).toEqual([
      ['comment:1701'],
    ]);
    expect(testHarness.finished).toEqual([null]);
  });

  it('an ad comment: reads the ad post and saves its comments as the ad comments intake knows', async () => {
    const testHarness = harness({
      target: { ...ANY_POST, trigger_type: 'ad_comment', ad_id: '23850000000000001', keywords: [] },
    });
    graph()
      .get(`/${META_GRAPH_VERSION}/23850000000000001`)
      .query((query) => query.fields === 'creative{effective_instagram_media_id}')
      .reply(200, { creative: { effective_instagram_media_id: '1809' } });
    commentsOf('1809').reply(200, { data: [comment({ id: '1701', ageMilliseconds: DAY })] });

    await runRead(testHarness);

    const [[event]] = testHarness.saved as [[NewInstagramWebhookEvent]];
    expect(event.payload).toMatchObject({
      field: 'comments',
      value: { id: '1701', media: { id: '1809', ad_id: '23850000000000001' } },
    });
    // No keywords: every comment matches.
    expect(testHarness.progress).toEqual([{ postsRead: 1, found: 1, matched: 1, queuedCount: 1 }]);
  });

  it('"posts between": only the window posts, stopping at the first older one', async () => {
    const testHarness = harness({
      target: {
        ...ANY_POST,
        target_scope: 'between',
        target_starts_at: new Date(NOW.getTime() - 3 * DAY),
        target_ends_at: new Date(NOW.getTime() - DAY),
      },
    });
    mediaPage().reply(200, {
      data: [
        { id: '1801', timestamp: new Date(NOW.getTime() - 0.5 * DAY).toISOString() },
        { id: '1802', timestamp: new Date(NOW.getTime() - 2 * DAY).toISOString() },
        { id: '1803', timestamp: new Date(NOW.getTime() - 4 * DAY).toISOString() },
      ],
      paging: { cursors: { after: 'more' }, next: 'https://graph.facebook.com/next' },
    });
    commentsOf('1802').reply(200, { data: [] });

    await runRead(testHarness);

    expect(testHarness.progress).toEqual([{ postsRead: 1, found: 0, matched: 0, queuedCount: 0 }]);
    expect(testHarness.enqueueIntake).not.toHaveBeenCalled();
    expect(testHarness.finished).toEqual([null]);
  });

  it('a waiting "next post" has no post: done at once with nothing read', async () => {
    const testHarness = harness({ target: { ...ANY_POST, target_scope: 'next' } });
    await runRead(testHarness);
    expect(testHarness.progress).toEqual([]);
    expect(testHarness.finished).toEqual([null]);
  });

  it('at 80 % Meta usage: no call, the page mark kept and the read goes on in 15 minutes from the same post (WC-41, P51)', async () => {
    const testHarness = harness({
      usagePercent: 80,
      target: { ...ANY_POST, target_scope: 'specific', target_instagram_media_id: '1801' },
    });

    await runRead(testHarness);

    expect(testHarness.progress).toEqual([{ postsRead: 0, found: 0, matched: 0, queuedCount: 0 }]);
    expect(testHarness.finished).toEqual([]);
    expect(addedTasks(testHarness)).toEqual([
      {
        taskInput: {
          channelAccountPublicId: ACCOUNT_PUBLIC_ID,
          automationBackfillPublicId: BACKFILL_PUBLIC_ID,
          startedAt: STARTED_AT.toISOString(),
          postNumber: 0,
          metaTry: 0,
        },
        delayMilliseconds: 15 * MINUTE,
        priority: 20,
      },
    ]);
  });

  it('Meta failing: tried again after 1 minute from the same post; after the 60-minute try `failed` · `meta_error` with the code only (META_TASK_RETRY_MINUTES)', async () => {
    const target: Target = {
      ...ANY_POST,
      target_scope: 'specific',
      target_instagram_media_id: '1801',
    };
    const first = harness({ target });
    commentsOf('1801').reply(500, { error: { message: 'Meta text never kept', code: 2 } });
    await runRead(first);
    expect(first.finished).toEqual([]);
    expect(addedTasks(first)).toEqual([
      expect.objectContaining({
        taskInput: expect.objectContaining({ postNumber: 0, metaTry: 1 }),
        delayMilliseconds: MINUTE,
      }),
    ]);

    const last = harness({ target });
    commentsOf('1801').reply(500, { error: { message: 'Meta text never kept', code: 2 } });
    await runRead(last, {
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      automationBackfillPublicId: BACKFILL_PUBLIC_ID,
      startedAt: STARTED_AT.toISOString(),
      postNumber: 0,
      metaTry: 4,
    });
    expect(last.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        resume: { automationBackfillPublicId: BACKFILL_PUBLIC_ID, startedAt: STARTED_AT },
      }),
    );
    expect(last.finished).toEqual([{ reason: 'meta_error', lastError: 'instagram_api:2' }]);
    // Only the wake-up of the account's next read.
    expect(addedTasks(last)).toEqual([
      expect.objectContaining({ taskInput: { channelAccountPublicId: ACCOUNT_PUBLIC_ID } }),
    ]);
  });

  it('a resumed job goes on from its post: the posts before it are not read again', async () => {
    const testHarness = harness({});
    mediaPage().reply(200, {
      data: [
        { id: '1801', timestamp: new Date(NOW.getTime() - DAY).toISOString(), comments_count: 1 },
        { id: '1802', timestamp: new Date(NOW.getTime() - DAY).toISOString(), comments_count: 1 },
      ],
    });
    commentsOf('1802').reply(200, { data: [comment({ id: '1701', ageMilliseconds: DAY })] });

    await runRead(testHarness, {
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      automationBackfillPublicId: BACKFILL_PUBLIC_ID,
      startedAt: STARTED_AT.toISOString(),
      postNumber: 1,
      metaTry: 0,
    });

    expect(testHarness.progress).toEqual([{ postsRead: 1, found: 1, matched: 1, queuedCount: 1 }]);
    expect(testHarness.finished).toEqual([null]);
  });

  it('one read at a time per account: another read running leaves the job idle — no Meta call', async () => {
    const testHarness = harness({ begun: { kind: 'busy' } });
    await runRead(testHarness);
    expect(testHarness.finished).toEqual([]);
    expect(testHarness.enqueueTask).not.toHaveBeenCalled();
  });

  it('a read the feature check refused wakes the next one; a read ended meanwhile stops the job', async () => {
    const refused = harness({ begun: { kind: 'refused', failReason: 'plan_feature_off' } });
    await runRead(refused);
    expect(addedTasks(refused)).toEqual([
      expect.objectContaining({ taskInput: { channelAccountPublicId: ACCOUNT_PUBLIC_ID } }),
    ]);

    const ended = harness({ isStillReading: false });
    mediaPage().reply(200, {
      data: [
        { id: '1801', timestamp: new Date(NOW.getTime() - DAY).toISOString(), comments_count: 1 },
        { id: '1802', timestamp: new Date(NOW.getTime() - DAY).toISOString(), comments_count: 1 },
      ],
    });
    commentsOf('1801').reply(200, { data: [] });
    await runRead(ended);
    expect(ended.progress).toHaveLength(1);
    expect(ended.finished).toEqual([]);
  });

  it('every wake-up is a new job at the lowest priority with public ids only', async () => {
    const enqueue = vi.fn(async () => undefined);
    await enqueueInstagramPastCommentRead({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      enqueue,
    });
    await enqueueInstagramPastCommentRead({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      enqueue,
    });
    const [[first], [second]] = enqueue.mock.calls as unknown as [
      [{ jobId: string }],
      [{ jobId: string }],
    ];
    expect(first).toMatchObject({
      jobName: 'automation-backfill-read',
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      taskInput: { channelAccountPublicId: ACCOUNT_PUBLIC_ID },
      priority: 20,
    });
    expect(first.jobId).toMatch(new RegExp(`^automation-backfill-read-${ACCOUNT_PUBLIC_ID}-`));
    expect(second.jobId).not.toBe(first.jobId);
  });
});
