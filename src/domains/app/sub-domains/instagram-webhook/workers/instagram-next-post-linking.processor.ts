import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import { NotFoundError } from '@/shared/errors/index.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { AutomationService } from '@/domains/app/sub-domains/automation/automation.service.js';
import type { AutomationPostLinkingEnqueue } from '@/domains/app/sub-domains/automation/workers/automation-next-post-linking.processor.js';
import { AUTOMATION_NEXT_POST_LINKING_MINUTES } from '@/domains/app/sub-domains/automation/workers/automation-next-post-linking.constants.js';
import {
  type InstagramMediaGraphItem,
  listInstagramMedia,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import type { InstagramMediaService } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.service.js';
import type { InstagramSendAccessService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-access.service.js';
import type {
  InstagramSendAccess,
  InstagramTaskHandler,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import { enqueueInstagramTask } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.queue.js';
import {
  INSTAGRAM_INTAKE_LOW_PRIORITY,
  INSTAGRAM_MISSED_COMMENT_CALL_GAP_MILLISECONDS,
  INSTAGRAM_MISSED_COMMENT_ROUND_USAGE_STOP_PERCENT,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.constants.js';

/**
 * Job name of one account's "next post" linking on `instagram-tasks` (feat-instagram-dm-sending § 4
 * AU6, AUC3; worker-changes WC-43) — the key of `instagramSendWork.taskHandlers` the app container
 * registers {@link createInstagramNextPostLinkingTaskHandler} under.
 *
 * @remarks
 * Notes: an unknown task name is dead-lettered, so the handler is registered before any add.
 */
export const INSTAGRAM_NEXT_POST_LINKING_JOB_NAME = 'next-post-linking';

/** The posts one Meta media page asks for. */
const MEDIA_PAGE_SIZE = 25;

/** The most media pages one linking reads — 100 posts since the oldest go-live. */
const MEDIA_PAGES_MAX = 4;

/** The task's input: the account and the oldest publish time it stores (public ids only, K8). */
const nextPostLinkingInputSchema = z.object({
  channelAccountPublicId: z.string().min(1).max(28),
  postsSince: z.string().min(1).max(40),
});

/**
 * Instagram's {@link AutomationPostLinkingEnqueue} (WC-43): one `next-post-linking` task per account
 * and 15-minute round (job id `next-post-linking-<cha_…>-<round>` — a repeat in the round is a
 * no-op), at the low priority.
 *
 * @remarks
 * - **Algorithm:** the round is the current 15-minute slot.
 * - **Failure modes:** propagates BullMQ / Redis errors — the sweep logs them; the next round links.
 * - **Side effects:** at most one task.
 * - **Notes:** passed to the channel-neutral sweep by the intake worker.
 */
export function createInstagramNextPostLinkingEnqueue({
  enqueue = enqueueInstagramTask,
  readNow = () => new Date(),
}: {
  enqueue?: typeof enqueueInstagramTask;
  readNow?: () => Date;
} = {}): AutomationPostLinkingEnqueue {
  return async ({ organizationPublicId, channelAccountPublicId, postsSince }) => {
    const round = Math.floor(
      readNow().getTime() / (AUTOMATION_NEXT_POST_LINKING_MINUTES * MILLISECONDS_PER_MINUTE),
    );
    await enqueue({
      jobName: INSTAGRAM_NEXT_POST_LINKING_JOB_NAME,
      jobId: `next-post-linking-${channelAccountPublicId}-${round}`,
      organizationPublicId,
      taskInput: { channelAccountPublicId, postsSince: postsSince.toISOString() },
      priority: INSTAGRAM_INTAKE_LOW_PRIORITY,
    });
  };
}

/**
 * The services one linking uses (each its owner's).
 *
 * @remarks
 * Notes: structural `Pick`s — the account's send access and Meta usage, the stored posts and their
 * watch, and the automations' link.
 */
export interface InstagramNextPostLinkingServices {
  instagramSendAccessService: Pick<
    InstagramSendAccessService,
    'readSendAccess' | 'readUsagePercent' | 'buildUsageRecorder'
  >;
  instagramMediaService: Pick<
    InstagramMediaService,
    'findStoredMedia' | 'upsertFromInstagram' | 'updateCommentWatch'
  >;
  automationService: Pick<AutomationService, 'linkNextPostAutomations'>;
}

/**
 * What one linking did (logged as `app.automation.next_post_linking_completed`): `skipped` (no
 * account, not connected, Meta's usage at 80 %, Meta failed), else `done`; the new posts stored and
 * the automations linked.
 *
 * @remarks
 * - **Algorithm:** counts only.
 * - **Failure modes:** none — a return shape.
 * - **Side effects:** none.
 * - **Notes:** a skipped round is safe — the next one links.
 */
export interface InstagramNextPostLinkingResult {
  outcome: 'skipped' | 'done';
  storedPostCount: number;
  linkedAutomationCount: number;
}

/** A post's publish time, or `null` when Meta sent none it can read. */
function publishedAtOf(item: InstagramMediaGraphItem): Date | null {
  const time = item.timestamp === undefined ? Number.NaN : Date.parse(item.timestamp);
  return Number.isNaN(time) ? null : new Date(time);
}

/**
 * The `next-post-linking` task (feat-instagram-dm-sending § 4 AU6, AUC3; worker-changes WC-43; P12):
 * one account's new posts since its oldest waiting go-live, stored, and each waiting "my next post"
 * automation linked to the first one published after it went live — once, no window, no expiry.
 *
 * @remarks
 * - **Algorithm:** the account's send access (connected, a token); the connection's Meta usage
 *   (P51/S13 — at 80 % the round is skipped, the next one links); then the account's posts newest
 *   first, one call a second, 25 a page, at most 4 pages, back to `postsSince`. Then, oldest first,
 *   each post in one unit of work: stored when it is not yet (`upsertFromInstagram`) and offered to
 *   the waiting automations (`linkNextPostAutomations` — the organization's "next post" lock, one
 *   conditional update, safe to repeat); a post an automation took starts its missed-comment watch
 *   now, so the comments made before the link are read back (WC-26 — a comment already delivered
 *   keeps its one event and its handling). Intake still links a commented post at once (P315).
 * - **Failure modes:** an account gone or not connected → skipped; any Meta failure → logged and
 *   skipped (a refused token is the token check's, WC-34); database errors propagate (the queue's
 *   one attempt; the next round links).
 * - **Side effects:** Meta reads and their usage; `app.instagram_media` rows and watches; linked
 *   automations.
 * - **Notes:** `callsMeta` — the task asks `mayTakeTickets` first; registered as
 *   `instagramSendWork.taskHandlers['next-post-linking']` by the app container.
 */
export function createInstagramNextPostLinkingTaskHandler({
  services,
  listMedia = listInstagramMedia,
  wait = (milliseconds: number) => sleep(milliseconds),
}: {
  services: InstagramNextPostLinkingServices;
  /** The media read — the real client's by default; tests pass nock or a fake. */
  listMedia?: typeof listInstagramMedia;
  /** The pause between two calls (1 s); tests pass a no-op. */
  wait?: (milliseconds: number) => Promise<unknown>;
}): InstagramTaskHandler {
  return {
    callsMeta: true,
    inputSchema: nextPostLinkingInputSchema,
    async run({ organizationPublicId, taskInput, context }) {
      const input = nextPostLinkingInputSchema.parse(taskInput);
      const result = await linkAccountNextPosts({
        organizationPublicId,
        channelAccountPublicId: input.channelAccountPublicId,
        postsSince: new Date(input.postsSince),
        requestId: context.jobId,
        runInDatabaseSlot: (callback) => context.runInDatabaseSlot(callback),
        services,
        listMedia,
        wait,
      });
      logger.info(
        {
          jobId: context.jobId,
          organizationPublicId,
          channelAccountPublicId: input.channelAccountPublicId,
          ...result,
        },
        'app.automation.next_post_linking_completed',
      );
    },
  };
}

/** What one account's linking works with once its access is read. */
interface LinkingContext {
  scope: OrganizationPrincipalDatabaseScope;
  channelAccountPublicId: string;
  access: InstagramSendAccess & { encryptedAccessToken: string };
  postsSince: Date;
  requestId: string;
  logFields: Record<string, unknown>;
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => Promise<T>;
  services: InstagramNextPostLinkingServices;
  listMedia: typeof listInstagramMedia;
  wait: (milliseconds: number) => Promise<unknown>;
}

/** A post read from Meta with its publish time. */
interface ReadPost {
  item: InstagramMediaGraphItem;
  publishedAt: Date;
}

/** One Meta call a second: waits out the rest of the gap since the previous call. */
function createCallPace(wait: (milliseconds: number) => Promise<unknown>): () => Promise<void> {
  let lastCallAt: number | null = null;
  return async () => {
    if (lastCallAt !== null) {
      const gap = INSTAGRAM_MISSED_COMMENT_CALL_GAP_MILLISECONDS - (Date.now() - lastCallAt);
      if (gap > 0) await wait(gap);
    }
    lastCallAt = Date.now();
  };
}

/** One media page's step: stop with what was read, or go on after Meta's cursor. */
type MediaPageStep = { kind: 'stop'; posts: ReadPost[] | null } | { kind: 'next'; after: string };

/** One media page of {@link readPostsSince}: the usage check, the call, the posts since. */
async function readMediaPage({
  context,
  after,
  pace,
  posts,
}: {
  context: LinkingContext;
  after: string | undefined;
  pace: () => Promise<void>;
  posts: ReadPost[];
}): Promise<MediaPageStep> {
  const { scope, access, services } = context;
  const usagePercent = await context.runInDatabaseSlot(() =>
    services.instagramSendAccessService.readUsagePercent({ scope, access }),
  );
  if (usagePercent >= INSTAGRAM_MISSED_COMMENT_ROUND_USAGE_STOP_PERCENT) {
    logger.info({ ...context.logFields, usagePercent }, 'app.automation.next_post_linking_paused');
    return { kind: 'stop', posts: posts.length === 0 ? null : posts };
  }
  await pace();
  const answer = await context.listMedia({
    encryptedAccessToken: access.encryptedAccessToken,
    instagramUserId: access.instagramUserId,
    limit: MEDIA_PAGE_SIZE,
    after,
    requestId: context.requestId,
    recordUsage: services.instagramSendAccessService.buildUsageRecorder({ scope, access }),
  });
  for (const item of answer.items) {
    const publishedAt = publishedAtOf(item);
    if (publishedAt === null) continue;
    if (publishedAt < context.postsSince) return { kind: 'stop', posts };
    posts.push({ item, publishedAt });
  }
  if (answer.nextCursor === null) return { kind: 'stop', posts };
  return { kind: 'next', after: answer.nextCursor };
}

/**
 * The account's posts since `postsSince`, newest first — `null` when nothing could be read (Meta's
 * usage at 80 %, or Meta failed before any post).
 */
async function readPostsSince(context: LinkingContext): Promise<ReadPost[] | null> {
  const posts: ReadPost[] = [];
  let after: string | undefined;
  const pace = createCallPace(context.wait);
  try {
    for (let page = 0; page < MEDIA_PAGES_MAX; page += 1) {
      const step = await readMediaPage({ context, after, pace, posts });
      if (step.kind === 'stop') return step.posts;
      after = step.after;
    }
    return posts;
  } catch (error) {
    if (!(error instanceof MetaGraphApiError)) throw error;
    logger.warn(
      {
        ...context.logFields,
        errorClass: error.errorClass,
        instagramErrorCode: error.instagramErrorCode,
      },
      'app.automation.next_post_linking_read_failed',
    );
    return posts.length === 0 ? null : posts;
  }
}

/** One post in one unit of work: stored when new, then offered to the waiting automations. */
async function storeAndLink({
  context,
  post,
}: {
  context: LinkingContext;
  post: ReadPost;
}): Promise<{ isNew: boolean; linkedPublicIds: string[] } | null> {
  const { scope, services } = context;
  const { channelAccount } = context.access;
  const { item, publishedAt } = post;
  let storedPost = await services.instagramMediaService.findStoredMedia({
    scope,
    channelAccount,
    instagramMediaId: item.id,
  });
  const isNew = storedPost === null;
  if (storedPost === null) {
    try {
      storedPost = await services.instagramMediaService.upsertFromInstagram({
        scope,
        channelAccount,
        mediaItem: item,
      });
    } catch (error) {
      // An answer the media service cannot map is Meta's fault — logged, the post left out.
      if (!(error instanceof MetaGraphApiError)) throw error;
      logger.warn(
        { ...context.logFields, instagramMediaId: item.id },
        'app.automation.post_store_failed',
      );
      return null;
    }
  }
  if (storedPost === null) return null;
  const linkedPublicIds = await services.automationService.linkNextPostAutomations({
    scope,
    channelAccountPublicId: context.channelAccountPublicId,
    instagramMediaId: item.id,
    publishedAt,
  });
  if (linkedPublicIds.length > 0 && storedPost.media_product_type !== 'live') {
    await services.instagramMediaService.updateCommentWatch({
      scope,
      channelAccount,
      instagramMediaId: item.id,
      watch: { commentsNextCheckAt: new Date() },
    });
  }
  return { isNew, linkedPublicIds };
}

/**
 * One account's linking, as {@link createInstagramNextPostLinkingTaskHandler} describes it.
 *
 * @remarks
 * Notes: exported for the task's tests; the handler is the one caller.
 */
export async function linkAccountNextPosts({
  organizationPublicId,
  channelAccountPublicId,
  postsSince,
  requestId,
  runInDatabaseSlot,
  services,
  listMedia,
  wait,
}: {
  organizationPublicId: string;
  channelAccountPublicId: string;
  postsSince: Date;
  requestId: string;
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => Promise<T>;
  services: InstagramNextPostLinkingServices;
  listMedia: typeof listInstagramMedia;
  wait: (milliseconds: number) => Promise<unknown>;
}): Promise<InstagramNextPostLinkingResult> {
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
  const skipped: InstagramNextPostLinkingResult = {
    outcome: 'skipped',
    storedPostCount: 0,
    linkedAutomationCount: 0,
  };
  let access: InstagramSendAccess;
  try {
    access = await runInDatabaseSlot(() =>
      services.instagramSendAccessService.readSendAccess({ scope, channelAccountPublicId }),
    );
  } catch (error) {
    if (error instanceof NotFoundError) return skipped;
    throw error;
  }
  const { encryptedAccessToken } = access;
  if (!access.isSendable || encryptedAccessToken === null) return skipped;
  const context: LinkingContext = {
    scope,
    channelAccountPublicId,
    access: { ...access, encryptedAccessToken },
    postsSince,
    requestId,
    logFields: { jobId: requestId, organizationPublicId, channelAccountPublicId },
    runInDatabaseSlot,
    services,
    listMedia,
    wait,
  };
  const posts = await readPostsSince(context);
  if (posts === null) return skipped;
  const result: InstagramNextPostLinkingResult = {
    outcome: 'done',
    storedPostCount: 0,
    linkedAutomationCount: 0,
  };
  // Oldest first: each automation takes the first post published after it went live.
  const oldestFirst = [...posts];
  oldestFirst.reverse();
  for (const post of oldestFirst) {
    const linked = await runInDatabaseSlot(() =>
      withAppDatabaseContext({ scope, callback: () => storeAndLink({ context, post }) }),
    );
    if (linked === null) continue;
    result.storedPostCount += linked.isNew ? 1 : 0;
    result.linkedAutomationCount += linked.linkedPublicIds.length;
  }
  return result;
}
