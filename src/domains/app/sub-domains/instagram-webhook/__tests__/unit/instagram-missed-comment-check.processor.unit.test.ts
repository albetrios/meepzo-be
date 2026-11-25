import { createHmac } from 'node:crypto';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { getEnv } from '@/shared/config/env.config.js';
import { encryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';
import {
  META_GRAPH_BASE_URL,
  META_GRAPH_VERSION,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type { InstagramMediaRow } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.repository.js';
import type { InstagramSendTicketContext } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import type { InstagramWebhookIntakeEnqueue } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';
import type { NewInstagramWebhookEvent } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import {
  chooseInstagramMissedCommentLookMode,
  createInstagramLateCommentTimeReader,
  createInstagramMissedCommentCheckTaskHandler,
  enqueueInstagramMissedCommentCheck,
  type InstagramMissedCommentCheckServices,
  runInstagramMissedCommentSweepJob,
} from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-missed-comment-check.processor.js';

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

const { mediaRetentionRepository } = vi.hoisted(() => ({
  mediaRetentionRepository: { listAccountsWithCommentWatches: vi.fn() },
}));

vi.mock('@/infrastructure/queue/worker-runtime/worker-processor.util.js', () => ({
  runGlobalRetentionWorkerJob: (processor: (databaseHandle: unknown) => Promise<unknown>) =>
    processor({ handle: 'retention' }),
}));

vi.mock(
  '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.repository.js',
  () => ({ createRetentionInstagramMediaRepository: () => mediaRetentionRepository }),
);

/**
 * The missed-comment look (feat-instagram-dm-sending § 5.A WH17, WHC10; worker-changes WC-26;
 * P93; AC-16.21): Meta through nock only. The full pass reads no comment over 7 days old and no
 * 26th post and stops at 60 % usage; the round stops at 80 %; new comments are saved through the
 * webhook's store function with key `comment:<id>` and handed to comment intake once.
 */

const ORGANIZATION_PUBLIC_ID = 'org_acmeshop000000000001';
const ACCOUNT_PUBLIC_ID = 'cha_acmeshop000000000001';
const ACCOUNT_INSTAGRAM_USER_ID = '17841400000000001';
const ACCOUNT_TOKEN = 'EAAG-missed-comment-token';
const COMMENT_FIELDS = 'id,text,timestamp,username,from,parent_id';
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-25T12:00:00Z');

function withProof(query: Record<string, string>): Record<string, string> {
  const appSecret = getEnv().META_APP_SECRET ?? '';
  return {
    ...query,
    appsecret_proof: createHmac('sha256', appSecret).update(ACCOUNT_TOKEN).digest('hex'),
  };
}

function graph(): nock.Scope {
  return nock(META_GRAPH_BASE_URL).matchHeader('authorization', `Bearer ${ACCOUNT_TOKEN}`);
}

function post(index: number, values: Partial<InstagramMediaRow> = {}): InstagramMediaRow {
  return {
    id: index,
    organization_id: 1,
    channel_account_id: 2,
    instagram_media_id: `1800000000000${String(index).padStart(4, '0')}`,
    shortcode: null,
    media_type: 'image',
    media_product_type: 'feed',
    caption: null,
    media_url: null,
    thumbnail_url: null,
    permalink: null,
    published_at: new Date(NOW.getTime() - DAY),
    comments_count: 0,
    like_count: 0,
    is_comment_enabled: true,
    graph_data: {},
    comments_checked_at: null,
    comments_next_check_at: new Date(NOW.getTime() - 60_000),
    last_comment_at: null,
    live_ended_at: null,
    synced_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...values,
  };
}

function comment(id: string, daysAgo: number, fromId = '9000000000000001') {
  return {
    id,
    text: 'price?',
    timestamp: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
    from: { id: fromId, username: 'acme_customer' },
  };
}

const ANY_POST_AUTOMATION = {
  id: 1,
  created_at: NOW,
  trigger_type: 'comment',
  also_start_from: [],
  target_scope: 'any',
  target_instagram_media_id: null,
  target_instagram_story_id: null,
  target_starts_at: null,
  target_ends_at: null,
  keywords: [],
  ad_id: null,
  ref_code: null,
  starter_questions: [],
  trigger_tag: null,
};

interface Harness {
  services: InstagramMissedCommentCheckServices;
  saved: NewInstagramWebhookEvent[][];
  watches: Array<{ instagramMediaId: string; watch: Record<string, unknown> }>;
  listWatchedPosts: ReturnType<typeof vi.fn>;
  readUsagePercent: ReturnType<typeof vi.fn>;
  enqueueIntake: ReturnType<typeof vi.fn<InstagramWebhookIntakeEnqueue>>;
}

function harness({
  posts,
  usagePercent = 10,
  isCommentReplyTriggerEnabled = true,
  automations = [ANY_POST_AUTOMATION],
}: {
  posts: InstagramMediaRow[];
  usagePercent?: number;
  isCommentReplyTriggerEnabled?: boolean;
  automations?: unknown[];
}): Harness {
  const saved: NewInstagramWebhookEvent[][] = [];
  const watches: Harness['watches'] = [];
  const listWatchedPosts = vi.fn(async ({ limit }: { limit: number }) => posts.slice(0, limit));
  const readUsagePercent = vi.fn(async () => usagePercent);
  const enqueueIntake = vi.fn<InstagramWebhookIntakeEnqueue>(async () => undefined);
  const services = {
    instagramAccountService: {
      findWebhookProcessingAccount: vi.fn(async () => ({
        instagramAccount: { organizationId: 1, instagramAccountId: 3 },
        channelAccountId: 2,
        instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        connectionStatus: 'connected',
        isAutomationEnabled: true,
        encryptedAccessToken: encryptFieldSecret(ACCOUNT_TOKEN),
      })),
    },
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
      readUsagePercent,
      buildUsageRecorder: vi.fn(() => undefined),
    },
    instagramAccountSettingsService: {
      findSettings: vi.fn(async () => ({
        is_comment_reply_trigger_enabled: isCommentReplyTriggerEnabled,
      })),
    },
    automationService: { listLiveCommentAutomations: vi.fn(async () => automations) },
    instagramMediaService: {
      listWatchedPosts,
      updateCommentWatch: vi.fn(async ({ instagramMediaId, watch }) => {
        watches.push({ instagramMediaId, watch });
        return null;
      }),
    },
    instagramWebhookEventService: {
      recordReceivedEvents: vi.fn(async ({ events }: { events: NewInstagramWebhookEvent[] }) => {
        saved.push(events);
        return events.map((event) => ({ event_key: event.eventKey }));
      }),
    },
  } as unknown as InstagramMissedCommentCheckServices;
  return { services, saved, watches, listWatchedPosts, readUsagePercent, enqueueIntake };
}

const CONTEXT: InstagramSendTicketContext = {
  jobId: 'missed-comments-job-1',
  runInDatabaseSlot: (callback) => callback(),
  returnTicket: async () => {
    throw new Error('not expected');
  },
};

async function runLook(testHarness: Harness, mode: 'round' | 'full_pass'): Promise<void> {
  const handler = createInstagramMissedCommentCheckTaskHandler({
    services: testHarness.services,
    wait: async () => undefined,
    readNow: () => NOW,
    enqueueIntake: testHarness.enqueueIntake,
  });
  await handler.run({
    organizationPublicId: ORGANIZATION_PUBLIC_ID,
    taskInput: { channelAccountPublicId: ACCOUNT_PUBLIC_ID, mode },
    context: CONTEXT,
  });
}

beforeEach(async () => {
  await metaGraphCircuit.reset();
});

afterEach(() => {
  const pending = nock.pendingMocks();
  nock.cleanAll();
  expect(pending).toEqual([]);
});

describe('the missed-comment look (WC-26)', () => {
  it('full pass: reads no 26th post and no comment over 7 days old (P93, AC-16.21)', async () => {
    const posts = Array.from({ length: 26 }, (_unused, index) => post(index + 1));
    const testHarness = harness({ posts });
    for (const watched of posts.slice(0, 25)) {
      graph()
        .get(`/${META_GRAPH_VERSION}/${watched.instagram_media_id}/comments`)
        .query(
          withProof({
            fields: `${COMMENT_FIELDS},replies{${COMMENT_FIELDS}}`,
            limit: '50',
          }),
        )
        .reply(200, {
          data: [
            comment(`17${watched.id}01`, 1),
            comment(`17${watched.id}02`, 6.5),
            comment(`17${watched.id}03`, 8),
          ],
          // Meta has more — the look stops at the 8-day-old comment and never asks.
          paging: { cursors: { after: 'more' }, next: 'https://graph.facebook.com/next' },
        });
    }

    await runLook(testHarness, 'full_pass');

    expect(testHarness.listWatchedPosts).toHaveBeenCalledWith(
      expect.objectContaining({ isDueOnly: false, limit: 25 }),
    );
    expect(testHarness.saved).toHaveLength(25);
    for (const events of testHarness.saved) {
      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(event.eventKey).toMatch(/^comment:17\d+0[12]$/);
        expect(event.eventKind).toBe('comment');
        expect(event.skipReason).toBeNull();
        expect(NOW.getTime() - (event.occurredAt?.getTime() ?? 0)).toBeLessThan(7 * DAY);
      }
    }
    expect(testHarness.enqueueIntake).toHaveBeenCalledTimes(1);
    expect(testHarness.enqueueIntake).toHaveBeenCalledWith({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      intakeKind: 'comments',
      requestId: 'missed-comments-job-1',
    });
  });

  it('full pass: stops at 60 % Meta usage before any call (P93)', async () => {
    const testHarness = harness({ posts: [post(1), post(2)], usagePercent: 60 });

    await runLook(testHarness, 'full_pass');

    expect(testHarness.saved).toEqual([]);
    expect(testHarness.watches).toEqual([]);
    expect(testHarness.enqueueIntake).not.toHaveBeenCalled();
  });

  it('full pass: stops when the usage reaches 60 % after a post — the rest waits', async () => {
    const testHarness = harness({ posts: [post(1), post(2)] });
    testHarness.readUsagePercent.mockResolvedValueOnce(10).mockResolvedValue(61);
    graph()
      .get(`/${META_GRAPH_VERSION}/${post(1).instagram_media_id}/comments`)
      .query(true)
      .reply(200, { data: [comment('1790000000000101', 0.1)] });

    await runLook(testHarness, 'full_pass');

    expect(testHarness.saved).toHaveLength(1);
    expect(testHarness.watches.map((entry) => entry.instagramMediaId)).toEqual([
      post(1).instagram_media_id,
    ]);
  });

  it('round: goes on at 70 % but is skipped at 80 % (P51)', async () => {
    const goesOn = harness({ posts: [post(1)], usagePercent: 70 });
    graph()
      .get(`/${META_GRAPH_VERSION}/${post(1).instagram_media_id}/comments`)
      .query(true)
      .reply(200, { data: [] });
    await runLook(goesOn, 'round');
    expect(goesOn.listWatchedPosts).toHaveBeenCalledWith(
      expect.objectContaining({ isDueOnly: true, limit: 25 }),
    );
    expect(goesOn.watches).toHaveLength(1);

    const skipped = harness({ posts: [post(1)], usagePercent: 80 });
    await runLook(skipped, 'round');
    expect(skipped.watches).toEqual([]);
  });

  it('reads back to the last seen comment minus 10 minutes, page after page, and moves the watch on', async () => {
    const lastSeen = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const watched = post(1, { last_comment_at: lastSeen });
    const testHarness = harness({ posts: [watched], isCommentReplyTriggerEnabled: false });
    const minutesBefore = (minutes: number) =>
      new Date(lastSeen.getTime() - minutes * 60_000).toISOString();
    graph()
      .get(`/${META_GRAPH_VERSION}/${watched.instagram_media_id}/comments`)
      .query(withProof({ fields: COMMENT_FIELDS, limit: '50' }))
      .reply(200, {
        data: [comment('1790000000000201', 0.01)],
        paging: { cursors: { after: 'page2' }, next: 'https://graph.facebook.com/next' },
      });
    graph()
      .get(`/${META_GRAPH_VERSION}/${watched.instagram_media_id}/comments`)
      .query(withProof({ fields: COMMENT_FIELDS, limit: '50', after: 'page2' }))
      .reply(200, {
        data: [
          { ...comment('1790000000000202', 0), timestamp: minutesBefore(5) },
          { ...comment('1790000000000203', 0), timestamp: minutesBefore(15) },
          // The account's own public reply is dropped.
          { ...comment('1790000000000204', 0.01, ACCOUNT_INSTAGRAM_USER_ID) },
        ],
        paging: { cursors: { after: 'page3' }, next: 'https://graph.facebook.com/next' },
      });

    await runLook(testHarness, 'round');

    expect(testHarness.saved[0]?.map((event) => event.eventKey)).toEqual([
      'comment:1790000000000201',
      'comment:1790000000000202',
    ]);
    expect(testHarness.watches).toEqual([
      {
        instagramMediaId: watched.instagram_media_id,
        watch: {
          commentsCheckedAt: NOW,
          commentsNextCheckAt: new Date(NOW.getTime() + 30 * 60_000),
          lastCommentAt: new Date(NOW.getTime() - 0.01 * DAY),
        },
      },
    ]);
  });

  it('saves a reply with its parent when comment replies are on (D64)', async () => {
    const testHarness = harness({ posts: [post(1)] });
    graph()
      .get(`/${META_GRAPH_VERSION}/${post(1).instagram_media_id}/comments`)
      .query(true)
      .reply(200, {
        data: [
          {
            ...comment('1790000000000301', 0.5),
            replies: { data: [comment('1790000000000302', 0.4, '9000000000000002')] },
          },
        ],
      });

    await runLook(testHarness, 'round');

    const reply = testHarness.saved[0]?.find(
      (event) => event.eventKey === 'comment:1790000000000302',
    );
    expect(reply?.contactInstagramUserId).toBe('9000000000000002');
    expect((reply?.payload.value as Record<string, unknown> | undefined)?.parent_id).toBe(
      '1790000000000301',
    );
  });

  it('stops watching a post no live comment automation takes, or older than 7 days, without a call', async () => {
    const oldPost = post(2, {
      published_at: new Date(NOW.getTime() - 9 * DAY),
      last_comment_at: new Date(NOW.getTime() - 8 * DAY),
    });
    const noAutomation = harness({ posts: [post(1)], automations: [] });
    await runLook(noAutomation, 'round');
    expect(noAutomation.watches).toEqual([
      { instagramMediaId: post(1).instagram_media_id, watch: { commentsNextCheckAt: null } },
    ]);

    const tooOld = harness({ posts: [oldPost] });
    await runLook(tooOld, 'round');
    expect(tooOld.watches).toEqual([
      { instagramMediaId: oldPost.instagram_media_id, watch: { commentsNextCheckAt: null } },
    ]);
  });

  it('a throttle stops the look and the post stays due; a refusal skips only that post', async () => {
    const testHarness = harness({ posts: [post(1), post(2), post(3)] });
    graph()
      .get(`/${META_GRAPH_VERSION}/${post(1).instagram_media_id}/comments`)
      .query(true)
      .reply(400, { error: { message: 'no', type: 'OAuthException', code: 100 } });
    graph()
      .get(`/${META_GRAPH_VERSION}/${post(2).instagram_media_id}/comments`)
      .query(true)
      .reply(429, { error: { message: 'slow down', type: 'OAuthException', code: 4 } });

    await runLook(testHarness, 'round');

    expect(testHarness.watches).toEqual([]);
    expect(testHarness.saved).toEqual([]);
  });

  it('skips an account whose automation switch is off', async () => {
    const testHarness = harness({ posts: [post(1)] });
    vi.mocked(
      testHarness.services.instagramAccountService.findWebhookProcessingAccount,
    ).mockResolvedValueOnce({
      instagramAccount: { organizationId: 1, instagramAccountId: 3 },
      channelAccountId: 2,
      instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
      connectionStatus: 'connected',
      isAutomationEnabled: false,
      encryptedAccessToken: encryptFieldSecret(ACCOUNT_TOKEN),
    });

    await runLook(testHarness, 'round');

    expect(testHarness.listWatchedPosts).not.toHaveBeenCalled();
  });
});

describe('the missed-comment sweep (WC-26)', () => {
  it('chooses the round, the full pass after two missed rounds, or nothing when nothing is due', () => {
    const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
    expect(
      chooseInstagramMissedCommentLookMode({
        account: { isDue: true, lastCheckedAt: minutesAgo(31) },
        now: NOW,
      }),
    ).toBe('round');
    expect(
      chooseInstagramMissedCommentLookMode({
        account: { isDue: true, lastCheckedAt: minutesAgo(61) },
        now: NOW,
      }),
    ).toBe('full_pass');
    expect(
      chooseInstagramMissedCommentLookMode({
        account: { isDue: true, lastCheckedAt: null },
        now: NOW,
      }),
    ).toBe('round');
    expect(
      chooseInstagramMissedCommentLookMode({
        account: { isDue: false, lastCheckedAt: minutesAgo(600) },
        now: NOW,
      }),
    ).toBeNull();
  });

  it('adds one look per due account — the full pass at the lowest priority, spread over 10 minutes', async () => {
    mediaRetentionRepository.listAccountsWithCommentWatches.mockResolvedValueOnce([
      {
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        channelAccountId: 1234,
        lastCheckedAt: new Date(NOW.getTime() - 31 * 60_000),
        isDue: true,
      },
      {
        organizationPublicId: 'org_brightway00000000001',
        channelAccountPublicId: 'cha_brightway00000000001',
        channelAccountId: 77,
        lastCheckedAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
        isDue: true,
      },
      {
        organizationPublicId: 'org_calm00000000000000001',
        channelAccountPublicId: 'cha_calm00000000000000001',
        channelAccountId: 5,
        lastCheckedAt: NOW,
        isDue: false,
      },
    ]);
    const added: unknown[] = [];
    const enqueueTask = vi.fn(async (task: unknown) => {
      added.push(task);
    });

    const result = await runInstagramMissedCommentSweepJob({
      now: NOW,
      enqueueLook: (input) =>
        enqueueInstagramMissedCommentCheck({ ...input, enqueue: enqueueTask }),
    });

    expect(result).toEqual({ listedCount: 3, roundCount: 1, fullPassCount: 1, failedAddCount: 0 });
    const window30 = Math.floor(NOW.getTime() / (30 * 60_000));
    const window10 = Math.floor(NOW.getTime() / (10 * 60_000));
    expect(added).toEqual([
      {
        jobName: 'missed-comment-check',
        jobId: `missed-comments-round-${ACCOUNT_PUBLIC_ID}-${window30}`,
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        taskInput: { channelAccountPublicId: ACCOUNT_PUBLIC_ID, mode: 'round' },
        priority: 10,
        delayMilliseconds: (1234 % 1800) * 1000,
      },
      {
        jobName: 'missed-comment-check',
        jobId: `missed-comments-full_pass-cha_brightway00000000001-${window10}`,
        organizationPublicId: 'org_brightway00000000001',
        taskInput: { channelAccountPublicId: 'cha_brightway00000000001', mode: 'full_pass' },
        priority: 20,
        delayMilliseconds: 77 * 1000,
      },
    ]);
  });
});

describe("intake's late comment time read (WH12 step 2)", () => {
  it("reads the comment's own time with the account's token after the usage read; not sendable or at Meta's wait → the received time", async () => {
    const testHarness = harness({ posts: [] });
    const sendAccess = testHarness.services.instagramSendAccessService;
    const reader = createInstagramLateCommentTimeReader({ instagramSendAccessService: sendAccess });
    graph()
      .get(`/${META_GRAPH_VERSION}/1790000000000401`)
      .query(withProof({ fields: 'timestamp' }))
      .reply(200, { timestamp: '2026-11-25T09:00:00Z' });
    const input = {
      scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId: ORGANIZATION_PUBLIC_ID }),
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      instagramCommentId: '1790000000000401',
      requestId: 'intake-job-1',
    };

    await expect(reader(input)).resolves.toEqual(new Date('2026-11-25T09:00:00Z'));
    expect(sendAccess.readUsagePercent).toHaveBeenCalledTimes(1);

    testHarness.readUsagePercent.mockResolvedValueOnce(100);
    await expect(reader(input)).resolves.toBeNull();

    vi.mocked(sendAccess.readSendAccess).mockResolvedValueOnce({
      ...(await sendAccess.readSendAccess({ scope: input.scope, channelAccountPublicId: '' })),
      isSendable: false,
    });
    await expect(reader(input)).resolves.toBeNull();
  });
});
