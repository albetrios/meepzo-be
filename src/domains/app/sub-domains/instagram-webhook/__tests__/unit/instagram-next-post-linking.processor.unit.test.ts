import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { encryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';
import {
  META_GRAPH_BASE_URL,
  META_GRAPH_VERSION,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type { InstagramSendTicketContext } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import {
  createInstagramNextPostLinkingEnqueue,
  createInstagramNextPostLinkingTaskHandler,
  type InstagramNextPostLinkingServices,
} from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-next-post-linking.processor.js';

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

// The task's one unit per post: the callback runs as it is (the services are fakes).
vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/infrastructure/database/contexts/database-context.js')>();
  return {
    ...actual,
    withAppDatabaseContext: ({ callback }: { callback: () => Promise<unknown> }) => callback(),
  };
});

/**
 * "My next post" linking (feat-instagram-dm-sending § 4 AU6, AUC3; worker-changes WC-43; P12; ROUTE
 * row R41 — AC-6.23, AC-16.23): Meta through nock only. One account's posts since its oldest waiting
 * go-live, oldest first: a new post stored, each offered to the waiting automations (the first post
 * after go-live links, once), a linked post's missed-comment watch started; Meta's usage at 80 % or a
 * Meta failure skips the round.
 */

const ORGANIZATION_PUBLIC_ID = 'org_acmeshop000000000001';
const ACCOUNT_PUBLIC_ID = 'cha_acmeshop000000000001';
const ACCOUNT_INSTAGRAM_USER_ID = '17841400000000001';
const ACCOUNT_TOKEN = 'EAAG-next-post-token';
const HOUR = 60 * 60 * 1000;
const GO_LIVE = new Date(Date.now() - 30 * 24 * HOUR);

function mediaPage(): nock.Interceptor {
  return nock(META_GRAPH_BASE_URL)
    .matchHeader('authorization', `Bearer ${ACCOUNT_TOKEN}`)
    .get(`/${META_GRAPH_VERSION}/${ACCOUNT_INSTAGRAM_USER_ID}/media`)
    .query((query) => query.limit === '25');
}

function postAt(id: string, hoursAgo: number) {
  return {
    id,
    media_type: 'IMAGE',
    media_product_type: 'FEED',
    timestamp: new Date(Date.now() - hoursAgo * HOUR).toISOString(),
  };
}

function harness({
  usagePercent = 10,
  storedIds = [],
  linkedBy = {},
}: {
  usagePercent?: number;
  storedIds?: string[];
  /** The automations each post links (by its media id). */
  linkedBy?: Record<string, string[]>;
}) {
  const stored = new Set(storedIds);
  const calls: string[] = [];
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
    instagramMediaService: {
      findStoredMedia: vi.fn(async ({ instagramMediaId }: { instagramMediaId: string }) =>
        stored.has(instagramMediaId)
          ? { instagram_media_id: instagramMediaId, media_product_type: 'feed' }
          : null,
      ),
      upsertFromInstagram: vi.fn(async ({ mediaItem }: { mediaItem: { id: string } }) => {
        calls.push(`store:${mediaItem.id}`);
        stored.add(mediaItem.id);
        return { instagram_media_id: mediaItem.id, media_product_type: 'feed' };
      }),
      updateCommentWatch: vi.fn(async ({ instagramMediaId }: { instagramMediaId: string }) => {
        calls.push(`watch:${instagramMediaId}`);
        return null;
      }),
    },
    automationService: {
      linkNextPostAutomations: vi.fn(
        async ({
          instagramMediaId,
          publishedAt,
        }: {
          instagramMediaId: string;
          publishedAt: Date;
        }) => {
          calls.push(`link:${instagramMediaId}@${publishedAt.toISOString()}`);
          return linkedBy[instagramMediaId] ?? [];
        },
      ),
    },
  } as unknown as InstagramNextPostLinkingServices;
  return { services, calls };
}

const CONTEXT: InstagramSendTicketContext = {
  jobId: 'next-post-linking-job-1',
  runInDatabaseSlot: (callback) => callback(),
  returnTicket: async () => {
    throw new Error('not expected');
  },
};

async function runLinking(services: InstagramNextPostLinkingServices): Promise<void> {
  const handler = createInstagramNextPostLinkingTaskHandler({
    services,
    wait: async () => undefined,
  });
  await handler.run({
    organizationPublicId: ORGANIZATION_PUBLIC_ID,
    taskInput: { channelAccountPublicId: ACCOUNT_PUBLIC_ID, postsSince: GO_LIVE.toISOString() },
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

describe('"my next post" linking (WC-43)', () => {
  it('offers the posts since go-live oldest first — a post weeks after go-live still links (no expiry, AC-6.23, AC-16.23)', async () => {
    const { services, calls } = harness({
      storedIds: ['1803'],
      linkedBy: { '1801': ['aut_acmeshop000000000001'] },
    });
    const newest = postAt('1803', 1);
    const middle = postAt('1802', 24 * 10);
    const oldest = postAt('1801', 24 * 29);
    mediaPage().reply(200, {
      data: [newest, middle],
      paging: { cursors: { after: 'page2' }, next: 'https://graph.facebook.com/next' },
    });
    mediaPage().reply(200, {
      // Older than the go-live: the read stops — Meta's next page is never asked for.
      data: [oldest, postAt('1800', 24 * 31)],
      paging: { cursors: { after: 'page3' }, next: 'https://graph.facebook.com/next' },
    });

    await runLinking(services);

    expect(calls).toEqual([
      'store:1801',
      `link:1801@${oldest.timestamp}`,
      // The linked post's missed-comment watch: its comments from before the link are read back.
      'watch:1801',
      'store:1802',
      `link:1802@${middle.timestamp}`,
      // Already stored (a comment's intake stored it): offered again, not stored twice.
      `link:1803@${newest.timestamp}`,
    ]);
  });

  it('at 80 % Meta usage the round is skipped with no call; the next round links', async () => {
    const { services, calls } = harness({ usagePercent: 80 });
    await runLinking(services);
    expect(calls).toEqual([]);
  });

  it('a Meta failure skips the round — nothing stored or linked', async () => {
    const { services, calls } = harness({});
    mediaPage().reply(400, { error: { message: 'Unsupported request', code: 100 } });
    await runLinking(services);
    expect(calls).toEqual([]);
  });

  it('one task per account and 15-minute round, at the low priority', async () => {
    const enqueue = vi.fn(async () => undefined);
    const now = new Date('2026-11-25T12:07:00Z');
    const enqueueLinking = createInstagramNextPostLinkingEnqueue({ enqueue, readNow: () => now });
    await enqueueLinking({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      postsSince: GO_LIVE,
    });
    expect(enqueue).toHaveBeenCalledWith({
      jobName: 'next-post-linking',
      jobId: `next-post-linking-${ACCOUNT_PUBLIC_ID}-${Math.floor(now.getTime() / (15 * 60 * 1000))}`,
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      taskInput: { channelAccountPublicId: ACCOUNT_PUBLIC_ID, postsSince: GO_LIVE.toISOString() },
      priority: 10,
    });
  });
});
