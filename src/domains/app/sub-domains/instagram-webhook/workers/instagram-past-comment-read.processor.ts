import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';
import { MILLISECONDS_PER_DAY, MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import { NotFoundError } from '@/shared/errors/index.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  META_TASK_RETRY_MINUTES,
  PAST_COMMENTS_MAX_AGE_MINUTES,
  PAST_COMMENTS_POSTS_MAX,
} from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.constants.js';
import type { AutomationBackfillService } from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.service.js';
import type {
  AutomationBackfillRead,
  AutomationBackfillReadQueue,
} from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.types.js';
import { matchesAutomationKeywords } from '@/domains/app/sub-domains/automation/automation-run/automation-run-matching.util.js';
import {
  type InstagramCommentGraphItem,
  listInstagramMedia,
  listInstagramMediaComments,
  readMetaAdInstagramMediaId,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import type { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import type { InstagramSendAccessService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-access.service.js';
import type {
  InstagramSendAccess,
  InstagramTaskHandler,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import { enqueueInstagramTask } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.queue.js';
import {
  INSTAGRAM_INTAKE_LOW_PRIORITY,
  INSTAGRAM_MISSED_COMMENT_CALL_GAP_MILLISECONDS,
  INSTAGRAM_MISSED_COMMENT_FULL_PASS_PRIORITY,
  INSTAGRAM_MISSED_COMMENT_MAX_PAGES_PER_POST,
  INSTAGRAM_MISSED_COMMENT_ROUND_USAGE_STOP_PERCENT,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.constants.js';
import type { InstagramWebhookIntakeEnqueue } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';
import type { InstagramWebhookEventService } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.service.js';
import { enqueueInstagramWebhookIntake } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import {
  type InstagramReadCommentMedia,
  readInstagramCommentTimeOf,
  toInstagramCommentEvents,
} from './instagram-missed-comment-check.processor.js';

/**
 * Job name of one account's past-comments read on `instagram-tasks` (feat-instagram-dm-sending
 * § 4.C AU32, worker-changes WC-41) — the key of `instagramSendWork.taskHandlers` the app container
 * registers {@link createInstagramPastCommentReadTaskHandler} under.
 *
 * @remarks
 * Notes: an unknown task name is dead-lettered, so the handler is registered before any add.
 */
export const INSTAGRAM_PAST_COMMENT_READ_JOB_NAME = 'automation-backfill-read';

/** The posts one Meta media page asks for while a read looks for its posts. */
const MEDIA_PAGE_SIZE = 25;

/** The most media pages a read scans for its posts ("any post", "posts between"). */
const MEDIA_PAGES_MAX = 4;

/** At this Meta usage or above the read waits (WC-41, P51): 15 minutes, then it goes on. */
const PAST_COMMENT_USAGE_WAIT_PERCENT = INSTAGRAM_MISSED_COMMENT_ROUND_USAGE_STOP_PERCENT;

/** How long a read waits at {@link PAST_COMMENT_USAGE_WAIT_PERCENT} (WC-41). */
const PAST_COMMENT_USAGE_WAIT_MINUTES = 15;

/**
 * The read's task input (public ids only, K8): the account, and — for a job that goes on after a
 * wait or a Meta retry — the read, the start it carries (ISO), the post to go on from and the
 * retries spent.
 */
const pastCommentReadInputSchema = z.object({
  channelAccountPublicId: z.string().min(1).max(28),
  automationBackfillPublicId: z.string().min(1).max(28).nullable().optional(),
  startedAt: z.string().max(40).nullable().optional(),
  postNumber: z.number().int().min(0).optional(),
  metaTry: z.number().int().min(0).optional(),
});

/** A job that goes on with a started read. */
interface ReadResume {
  automationBackfillPublicId: string;
  startedAt: Date;
  postNumber: number;
  metaTry: number;
}

/**
 * Adds one past-comments read job to `instagram-tasks` (WC-41): a wake-up of the account's reads (no
 * `resume` — route 38, the watch, an ended read), or a job that goes on with a started read after
 * `delayMilliseconds` (a usage wait, a Meta retry).
 *
 * @remarks
 * - **Algorithm:** job id `automation-backfill-read-<cha_…>-<uuid>` — every add is a new job (the
 *   job decides under the account's read lock, so a repeat does nothing), at the queue's lowest
 *   priority ({@link INSTAGRAM_MISSED_COMMENT_FULL_PASS_PRIORITY}, P93).
 * - **Failure modes:** propagates BullMQ / Redis errors — route 38 logs them after its commit and
 *   the watch wakes the read within 10 minutes.
 * - **Side effects:** one task.
 * - **Notes:** the job input carries public ids, a time and two numbers only.
 */
export async function enqueueInstagramPastCommentRead({
  organizationPublicId,
  channelAccountPublicId,
  resume,
  delayMilliseconds,
  enqueue = enqueueInstagramTask,
}: {
  organizationPublicId: string;
  channelAccountPublicId: string;
  resume?: ReadResume | undefined;
  delayMilliseconds?: number | undefined;
  enqueue?: typeof enqueueInstagramTask | undefined;
}): Promise<void> {
  await enqueue({
    jobName: INSTAGRAM_PAST_COMMENT_READ_JOB_NAME,
    jobId: `automation-backfill-read-${channelAccountPublicId}-${randomUUID()}`,
    organizationPublicId,
    taskInput:
      resume === undefined
        ? { channelAccountPublicId }
        : {
            channelAccountPublicId,
            automationBackfillPublicId: resume.automationBackfillPublicId,
            startedAt: resume.startedAt.toISOString(),
            postNumber: resume.postNumber,
            metaTry: resume.metaTry,
          },
    priority: INSTAGRAM_MISSED_COMMENT_FULL_PASS_PRIORITY,
    ...(delayMilliseconds === undefined ? {} : { delayMilliseconds }),
  });
}

/**
 * Instagram's {@link AutomationBackfillReadQueue} (WC-41) — passed to `AutomationBackfillService`
 * (route 38) and the watch: a wake-up of the account's reads.
 *
 * @remarks
 * Notes: wiring only — {@link enqueueInstagramPastCommentRead} without `resume`.
 */
export const INSTAGRAM_PAST_COMMENT_READ_QUEUE: AutomationBackfillReadQueue = {
  enqueueAutomationBackfillRead: ({ organizationPublicId, channelAccountPublicId }) =>
    enqueueInstagramPastCommentRead({ organizationPublicId, channelAccountPublicId }),
};

/**
 * The services one read uses (each its owner's).
 *
 * @remarks
 * Notes: structural `Pick`s — the account's send access and Meta usage, its comment-reply switch,
 * the read's row (automation-backfill, channel-neutral) and the events' store.
 */
export interface InstagramPastCommentReadServices {
  instagramSendAccessService: Pick<
    InstagramSendAccessService,
    'readSendAccess' | 'readUsagePercent' | 'buildUsageRecorder'
  >;
  instagramAccountSettingsService: Pick<InstagramAccountSettingsService, 'findSettings'>;
  automationBackfillService: Pick<
    AutomationBackfillService,
    | 'beginAutomationBackfillRead'
    | 'recordAutomationBackfillProgress'
    | 'finishAutomationBackfillRead'
  >;
  instagramWebhookEventService: Pick<InstagramWebhookEventService, 'recordReceivedEvents'>;
}

/**
 * The Meta reads a read makes — the real client's by default; tests pass nock or fakes.
 *
 * @remarks
 * Notes: the media list ("any post", "posts between"), a post's comments, an ad's post.
 */
export interface InstagramPastCommentReadClient {
  listMedia: typeof listInstagramMedia;
  listComments: typeof listInstagramMediaComments;
  readAdMediaId: typeof readMetaAdInstagramMediaId;
}

/** The real client. */
const META_CLIENT: InstagramPastCommentReadClient = {
  listMedia: listInstagramMedia,
  listComments: listInstagramMediaComments,
  readAdMediaId: readMetaAdInstagramMediaId,
};

/**
 * How one job ended (logged as `app.automation_backfill.read_job_completed`): `idle` (nothing to
 * read, another read runs, the read ended meanwhile), `refused` (the feature check ended it),
 * `waiting` (Meta's usage — goes on in 15 minutes), `retrying` (Meta failed — tried again later),
 * `done`, `failed`.
 *
 * @remarks
 * - **Algorithm:** a label and the posts this job read.
 * - **Failure modes:** none — a return shape.
 * - **Side effects:** none.
 * - **Notes:** the counters live on the read's row.
 */
export interface InstagramPastCommentReadJobResult {
  outcome: 'idle' | 'refused' | 'waiting' | 'retrying' | 'done' | 'failed';
  postsReadByThisJob: number;
}

/** Everything one job's read needs. */
interface ReadContext {
  organizationPublicId: string;
  channelAccountPublicId: string;
  scope: OrganizationPrincipalDatabaseScope;
  access: InstagramSendAccess;
  read: AutomationBackfillRead;
  requestId: string;
  now: Date;
  services: InstagramPastCommentReadServices;
  client: InstagramPastCommentReadClient;
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => Promise<T>;
  pace: () => Promise<void>;
  enqueueTask: typeof enqueueInstagramTask;
  enqueueIntake: InstagramWebhookIntakeEnqueue;
}

/** Meta's usage reached the wait (WC-41): the read goes on later. */
class UsageWait extends Error {
  constructor() {
    super('meta_usage_wait');
    this.name = 'UsageWait';
  }
}

/** `instagram_api:<code>/<subcode>`, or the error class when Meta sent no code — never Meta's text. */
function describeMetaError(error: MetaGraphApiError): string {
  if (error.instagramErrorCode === null) return `instagram_api:${error.errorClass}`;
  return error.instagramErrorSubcode === null
    ? `instagram_api:${error.instagramErrorCode}`
    : `instagram_api:${error.instagramErrorCode}/${error.instagramErrorSubcode}`;
}

/** The connection's usage before a Meta call (P51/S13): at 80 % the read waits. */
async function beforeMetaCall(context: ReadContext): Promise<void> {
  const usagePercent = await context.runInDatabaseSlot(() =>
    context.services.instagramSendAccessService.readUsagePercent({
      scope: context.scope,
      access: context.access,
      now: context.now,
    }),
  );
  if (usagePercent >= PAST_COMMENT_USAGE_WAIT_PERCENT) throw new UsageWait();
  await context.pace();
}

/**
 * One media page's posts of {@link scanPosts} into `posts`; `true` once the scan is done (past the
 * read's posts, or {@link PAST_COMMENTS_POSTS_MAX} kept).
 */
function collectPagePosts({
  items,
  keep,
  isPastEnd,
  posts,
}: {
  items: ReadonlyArray<{
    id: string;
    timestamp?: string | undefined;
    comments_count?: number | undefined;
    media_product_type?: string | undefined;
  }>;
  keep: (post: { timestamp: number; commentsCount: number }) => boolean;
  isPastEnd: (timestamp: number) => boolean;
  posts: InstagramReadCommentMedia[];
}): boolean {
  for (const item of items) {
    const timestamp = item.timestamp === undefined ? Number.NaN : Date.parse(item.timestamp);
    if (Number.isNaN(timestamp)) continue;
    if (isPastEnd(timestamp)) return true;
    if (!keep({ timestamp, commentsCount: item.comments_count ?? 0 })) continue;
    posts.push({
      instagramMediaId: item.id,
      mediaProductType: item.media_product_type?.toLowerCase() ?? null,
    });
    if (posts.length >= PAST_COMMENTS_POSTS_MAX) return true;
  }
  return false;
}

/** The account's newest posts, newest first, a page of 25 at a time — at most 4 pages. */
async function scanPosts({
  context,
  keep,
  isPastEnd,
}: {
  context: ReadContext;
  /** Whether a post is one of the read's. */
  keep: (post: { timestamp: number; commentsCount: number }) => boolean;
  /** Whether the scan has gone past the read's posts (older ones are not looked at). */
  isPastEnd: (timestamp: number) => boolean;
}): Promise<InstagramReadCommentMedia[]> {
  const posts: InstagramReadCommentMedia[] = [];
  let after: string | undefined;
  let page = 0;
  let isScanDone = false;
  while (!isScanDone && page < MEDIA_PAGES_MAX) {
    page += 1;
    await beforeMetaCall(context);
    const answer = await context.client.listMedia({
      encryptedAccessToken: context.access.encryptedAccessToken as string,
      instagramUserId: context.access.instagramUserId,
      limit: MEDIA_PAGE_SIZE,
      after,
      requestId: context.requestId,
      recordUsage: context.services.instagramSendAccessService.buildUsageRecorder({
        scope: context.scope,
        access: context.access,
      }),
    });
    isScanDone =
      collectPagePosts({ items: answer.items, keep, isPastEnd, posts }) ||
      answer.nextCursor === null;
    after = answer.nextCursor ?? undefined;
  }
  return posts;
}

/**
 * The read's posts (AU32): the automation's one post (one post, a linked "next post"); the posts of
 * a "posts between" window; for "any post" the newest 50 with comments; for an ad comment the ad's
 * post. A "next post" still waiting has none.
 */
async function listReadPosts(context: ReadContext): Promise<InstagramReadCommentMedia[]> {
  const target = context.read.target;
  if (target === null) return [];
  if (target.trigger_type === 'ad_comment') {
    if (target.ad_id === null) return [];
    await beforeMetaCall(context);
    const instagramMediaId = await context.client.readAdMediaId({
      encryptedAccessToken: context.access.encryptedAccessToken as string,
      adId: target.ad_id,
      requestId: context.requestId,
      recordUsage: context.services.instagramSendAccessService.buildUsageRecorder({
        scope: context.scope,
        access: context.access,
      }),
    });
    return instagramMediaId === null
      ? []
      : [{ instagramMediaId, mediaProductType: null, adId: target.ad_id }];
  }
  if (target.target_scope === 'specific' || target.target_scope === 'next') {
    return target.target_instagram_media_id === null
      ? []
      : [{ instagramMediaId: target.target_instagram_media_id, mediaProductType: null }];
  }
  if (target.target_scope === 'between') {
    const startsAt = target.target_starts_at?.getTime() ?? Number.NEGATIVE_INFINITY;
    const endsAt = target.target_ends_at?.getTime() ?? Number.POSITIVE_INFINITY;
    return scanPosts({
      context,
      keep: ({ timestamp }) => timestamp <= endsAt,
      isPastEnd: (timestamp) => timestamp < startsAt,
    });
  }
  return scanPosts({
    context,
    keep: ({ commentsCount }) => commentsCount > 0,
    isPastEnd: () => false,
  });
}

/**
 * One post's comments newest first, back to the read's cut-off — the days asked, never older than 7
 * days minus 30 minutes (AC-8.5) — at most 40 pages, one call a second, the usage read before each.
 */
async function readPostComments({
  context,
  post,
  isRepliesIncluded,
}: {
  context: ReadContext;
  post: InstagramReadCommentMedia;
  isRepliesIncluded: boolean;
}): Promise<InstagramCommentGraphItem[]> {
  const cutOff = Math.max(
    context.now.getTime() - context.read.days * MILLISECONDS_PER_DAY,
    context.now.getTime() - PAST_COMMENTS_MAX_AGE_MINUTES * MILLISECONDS_PER_MINUTE,
  );
  const comments: InstagramCommentGraphItem[] = [];
  const keep = (comment: InstagramCommentGraphItem) => {
    const time = readInstagramCommentTimeOf(comment);
    if (time !== null && time.getTime() >= cutOff) comments.push(comment);
  };
  let after: string | undefined;
  for (let page = 0; page < INSTAGRAM_MISSED_COMMENT_MAX_PAGES_PER_POST; page += 1) {
    await beforeMetaCall(context);
    const answer = await context.client.listComments({
      encryptedAccessToken: context.access.encryptedAccessToken as string,
      instagramMediaId: post.instagramMediaId,
      isRepliesIncluded,
      after,
      requestId: context.requestId,
      recordUsage: context.services.instagramSendAccessService.buildUsageRecorder({
        scope: context.scope,
        access: context.access,
      }),
    });
    let isPastCutOff = false;
    for (const comment of answer.items) {
      keep(comment);
      for (const reply of comment.replies?.data ?? []) {
        keep({ ...reply, parent_id: reply.parent_id ?? comment.id });
      }
      const time = readInstagramCommentTimeOf(comment);
      if (time !== null && time.getTime() < cutOff) isPastCutOff = true;
    }
    if (isPastCutOff || answer.nextCursor === null) return comments;
    after = answer.nextCursor;
  }
  return comments;
}

/**
 * Saves one post's comments as "old" comment events and adds the post's numbers to the read: `found`
 * — the comments in the window (the account's own left out); `matched` — of those, the ones the
 * automation's keywords match (no keywords: every one); `queued` — the matched ones saved as new
 * events, i.e. handed to intake (a comment Meta already delivered keeps its one event — the key).
 */
async function saveComments({
  context,
  post,
  comments,
}: {
  context: ReadContext;
  post: InstagramReadCommentMedia;
  comments: readonly InstagramCommentGraphItem[];
}): Promise<{ isStillReading: boolean; savedCount: number }> {
  const events = toInstagramCommentEvents({
    comments,
    media: post,
    instagramUserId: context.access.instagramUserId,
  });
  const keywords = context.read.target?.keywords ?? [];
  const isMatched = (text: unknown) =>
    matchesAutomationKeywords({
      keywords,
      text: typeof text === 'string' ? text : null,
      isMatchWithoutKeywords: true,
    });
  const textOf = (payload: unknown) =>
    (payload as { value?: { text?: unknown } } | null)?.value?.text ??
    (payload as { text?: unknown } | null)?.text;
  return context.runInDatabaseSlot(async () => {
    const saved = await context.services.instagramWebhookEventService.recordReceivedEvents({
      scope: context.scope,
      channelAccount: context.access.channelAccount,
      requestId: context.requestId,
      events,
      now: context.now,
    });
    const savedKeys = new Set(saved.map((row) => row.event_key));
    const matched = events.filter((event) => isMatched(textOf(event.payload)));
    const isStillReading =
      await context.services.automationBackfillService.recordAutomationBackfillProgress({
        scope: context.scope,
        read: context.read,
        postsRead: 1,
        found: events.length,
        matched: matched.length,
        queuedCount: matched.filter((event) => savedKeys.has(event.eventKey)).length,
      });
    return { isStillReading, savedCount: saved.length };
  });
}

/** Hands the saved comments to comment intake at the low priority (AC-8.6) — failing open. */
async function handToIntake(context: ReadContext): Promise<void> {
  try {
    await context.enqueueIntake({
      organizationPublicId: context.organizationPublicId,
      channelAccountPublicId: context.channelAccountPublicId,
      intakeKind: 'comments',
      requestId: context.requestId,
      priority: INSTAGRAM_INTAKE_LOW_PRIORITY,
    });
  } catch (error) {
    // The saved events wait `received`; the every-minute pick-up hands them to intake (WH17).
    logger.warn(
      {
        jobId: context.requestId,
        organizationPublicId: context.organizationPublicId,
        errorName: error instanceof Error ? error.name : typeof error,
      },
      'app.automation_backfill.intake_enqueue_failed',
    );
  }
}

/** Wakes the account's next queued read once this one ended (one read at a time per account). */
async function wakeNextRead(
  context: Pick<
    ReadContext,
    'organizationPublicId' | 'channelAccountPublicId' | 'enqueueTask' | 'requestId'
  >,
) {
  try {
    await enqueueInstagramPastCommentRead({
      organizationPublicId: context.organizationPublicId,
      channelAccountPublicId: context.channelAccountPublicId,
      enqueue: context.enqueueTask,
    });
  } catch (error) {
    logger.warn(
      {
        jobId: context.requestId,
        organizationPublicId: context.organizationPublicId,
        errorName: error instanceof Error ? error.name : typeof error,
      },
      'app.automation_backfill.next_read_enqueue_failed',
    );
  }
}

/** One post's comments; Meta refusing that post (deleted, comments off) skips it only. */
async function readPostCommentsOrSkip({
  context,
  post,
  isRepliesIncluded,
}: {
  context: ReadContext;
  post: InstagramReadCommentMedia;
  isRepliesIncluded: boolean;
}): Promise<InstagramCommentGraphItem[]> {
  try {
    return await readPostComments({ context, post, isRepliesIncluded });
  } catch (error) {
    if (!(error instanceof MetaGraphApiError) || error.errorClass !== 'refused') throw error;
    logger.info(
      { jobId: context.requestId, instagramMediaId: post.instagramMediaId },
      'app.automation_backfill.post_refused',
    );
    return [];
  }
}

/** A Meta failure of the read: a later job after 1, 5, 15, 60 min, then `failed` `meta_error`. */
async function handleMetaReadFailure({
  context,
  error,
  metaTry,
  goOnLater,
}: {
  context: ReadContext;
  error: MetaGraphApiError;
  metaTry: number;
  goOnLater: (input: { delayMinutes: number; nextTry: number }) => Promise<void>;
}): Promise<'retrying' | 'failed'> {
  const retryMinutes = META_TASK_RETRY_MINUTES[metaTry];
  logger.warn(
    {
      jobId: context.requestId,
      automationBackfillPublicId: context.read.automationBackfillPublicId,
      errorClass: error.errorClass,
      instagramErrorCode: error.instagramErrorCode,
      metaTry,
    },
    'app.automation_backfill.meta_read_failed',
  );
  if (retryMinutes !== undefined) {
    await goOnLater({ delayMinutes: retryMinutes, nextTry: metaTry + 1 });
    return 'retrying';
  }
  await context.runInDatabaseSlot(() =>
    context.services.automationBackfillService.finishAutomationBackfillRead({
      scope: context.scope,
      read: context.read,
      failure: { reason: 'meta_error', lastError: describeMetaError(error) },
    }),
  );
  await wakeNextRead(context);
  return 'failed';
}

/** Reads the posts from `postNumber` on; a wait or a Meta failure goes on in a later job. */
async function readFromPost({
  context,
  postNumber,
  metaTry,
  isRepliesIncluded,
}: {
  context: ReadContext;
  postNumber: number;
  metaTry: number;
  isRepliesIncluded: boolean;
}): Promise<InstagramPastCommentReadJobResult> {
  let current = postNumber;
  let postsReadByThisJob = 0;
  const goOnLater = async ({
    delayMinutes,
    nextTry,
  }: {
    delayMinutes: number;
    nextTry: number;
  }) => {
    await enqueueInstagramPastCommentRead({
      organizationPublicId: context.organizationPublicId,
      channelAccountPublicId: context.channelAccountPublicId,
      resume: {
        automationBackfillPublicId: context.read.automationBackfillPublicId,
        startedAt: context.read.startedAt,
        postNumber: current,
        metaTry: nextTry,
      },
      delayMilliseconds: delayMinutes * MILLISECONDS_PER_MINUTE,
      enqueue: context.enqueueTask,
    });
  };
  try {
    const posts = await listReadPosts(context);
    for (; current < posts.length; current += 1) {
      const post = posts[current] as InstagramReadCommentMedia;
      const comments = await readPostCommentsOrSkip({ context, post, isRepliesIncluded });
      const { isStillReading, savedCount } = await saveComments({ context, post, comments });
      postsReadByThisJob += 1;
      if (savedCount > 0) await handToIntake(context);
      if (!isStillReading) return { outcome: 'idle', postsReadByThisJob };
    }
  } catch (error) {
    if (error instanceof UsageWait) {
      // Meta's usage is high: the page mark stays fresh and the read goes on in 15 minutes.
      await context.runInDatabaseSlot(() =>
        context.services.automationBackfillService.recordAutomationBackfillProgress({
          scope: context.scope,
          read: context.read,
          postsRead: 0,
          found: 0,
          matched: 0,
          queuedCount: 0,
        }),
      );
      await goOnLater({ delayMinutes: PAST_COMMENT_USAGE_WAIT_MINUTES, nextTry: metaTry });
      return { outcome: 'waiting', postsReadByThisJob };
    }
    if (!(error instanceof MetaGraphApiError)) throw error;
    const outcome = await handleMetaReadFailure({ context, error, metaTry, goOnLater });
    return { outcome, postsReadByThisJob };
  }
  const isFinished = await context.runInDatabaseSlot(() =>
    context.services.automationBackfillService.finishAutomationBackfillRead({
      scope: context.scope,
      read: context.read,
      failure: null,
    }),
  );
  await wakeNextRead(context);
  return { outcome: isFinished ? 'done' : 'idle', postsReadByThisJob };
}

/**
 * The `automation-backfill-read` task (feat-instagram-dm-sending § 4.C AU32, AUC12; worker-changes
 * WC-41): one account's past-comments read — the automation's posts, their comments of the last N
 * days saved as "old" comment events that sub-domain 5's normal intake takes in (the 7-day rule, the
 * once rule, the low priority). The read never sends.
 *
 * @remarks
 * - **Algorithm:** the account's send access, then `beginAutomationBackfillRead` under the account's
 *   read lock (one read at a time per account: a fresh `reading` read leaves this job idle, a stuck
 *   one is started again, else the oldest `queued` one starts; a resumed job goes on only with its
 *   read and start) and 1B's feature check `past_comments` (a refusal ends it `failed`). Then the
 *   posts ({@link listReadPosts}) and, from the job's post on, each post's comments newest first
 *   back to the cut-off — the usage read before every Meta call, one call a second. Each post's
 *   comments go through the webhook's store function (`recordReceivedEvents`, key `comment:<id>`)
 *   and its numbers onto the read (also the page mark the watch reads); new events are handed to
 *   comment intake at {@link INSTAGRAM_INTAKE_LOW_PRIORITY}. At the end the read is `done` and the
 *   account's next read is woken.
 * - **Failure modes:** an account gone → idle; not connected → the read ends `failed` ·
 *   `meta_error` (`account_not_connected`); Meta's usage at 80 % → a job 15 minutes on, from the
 *   same post; a Meta failure (throttle, outage, token) → a job after 1, 5, 15, 60 minutes, then
 *   `failed` · `meta_error` with the code only; Meta refusing one post → that post skipped; a read
 *   ended or started again meanwhile (the move down's `plan_feature_off`, the watch) → the job
 *   stops at its next post; database errors propagate (the queue's one attempt — the watch restarts
 *   the read).
 * - **Side effects:** Meta reads and their usage; event and key rows; the read's row; intake jobs;
 *   the next read's job.
 * - **Notes:** `callsMeta` — the task asks `mayTakeTickets` first; registered as
 *   `instagramSendWork.taskHandlers['automation-backfill-read']` by the app container. The owner's
 *   "past comments done" notice is ROUTE row R53's (AC-8.8).
 */
export function createInstagramPastCommentReadTaskHandler({
  services,
  client = META_CLIENT,
  wait = (milliseconds: number) => sleep(milliseconds),
  readNow = () => new Date(),
  enqueueTask = enqueueInstagramTask,
  enqueueIntake = enqueueInstagramWebhookIntake,
}: {
  services: InstagramPastCommentReadServices;
  client?: InstagramPastCommentReadClient;
  /** The pause between two calls (1 s); tests pass a no-op. */
  wait?: (milliseconds: number) => Promise<unknown>;
  readNow?: () => Date;
  enqueueTask?: typeof enqueueInstagramTask;
  enqueueIntake?: InstagramWebhookIntakeEnqueue;
}): InstagramTaskHandler {
  return {
    callsMeta: true,
    inputSchema: pastCommentReadInputSchema,
    async run({ organizationPublicId, taskInput, context: ticket }) {
      const input = pastCommentReadInputSchema.parse(taskInput);
      const resume: ReadResume | null =
        input.automationBackfillPublicId === undefined ||
        input.automationBackfillPublicId === null ||
        input.startedAt === undefined ||
        input.startedAt === null
          ? null
          : {
              automationBackfillPublicId: input.automationBackfillPublicId,
              startedAt: new Date(input.startedAt),
              postNumber: input.postNumber ?? 0,
              metaTry: input.metaTry ?? 0,
            };
      const result = await runPastCommentRead({
        organizationPublicId,
        channelAccountPublicId: input.channelAccountPublicId,
        resume,
        requestId: ticket.jobId,
        runInDatabaseSlot: (callback) => ticket.runInDatabaseSlot(callback),
        services,
        client,
        wait,
        now: readNow(),
        enqueueTask,
        enqueueIntake,
      });
      logger.info(
        {
          jobId: ticket.jobId,
          organizationPublicId,
          channelAccountPublicId: input.channelAccountPublicId,
          ...result,
        },
        'app.automation_backfill.read_job_completed',
      );
    },
  };
}

/** One job, as {@link createInstagramPastCommentReadTaskHandler} describes it. */
async function runPastCommentRead({
  organizationPublicId,
  channelAccountPublicId,
  resume,
  requestId,
  runInDatabaseSlot,
  services,
  client,
  wait,
  now,
  enqueueTask,
  enqueueIntake,
}: {
  organizationPublicId: string;
  channelAccountPublicId: string;
  resume: ReadResume | null;
  requestId: string;
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => Promise<T>;
  services: InstagramPastCommentReadServices;
  client: InstagramPastCommentReadClient;
  wait: (milliseconds: number) => Promise<unknown>;
  now: Date;
  enqueueTask: typeof enqueueInstagramTask;
  enqueueIntake: InstagramWebhookIntakeEnqueue;
}): Promise<InstagramPastCommentReadJobResult> {
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
  const idle: InstagramPastCommentReadJobResult = { outcome: 'idle', postsReadByThisJob: 0 };
  let access: InstagramSendAccess;
  try {
    access = await runInDatabaseSlot(() =>
      services.instagramSendAccessService.readSendAccess({ scope, channelAccountPublicId }),
    );
  } catch (error) {
    if (error instanceof NotFoundError) return idle;
    throw error;
  }
  const begun = await runInDatabaseSlot(() =>
    services.automationBackfillService.beginAutomationBackfillRead({
      scope,
      channelAccount: access.channelAccount,
      resume:
        resume === null
          ? null
          : {
              automationBackfillPublicId: resume.automationBackfillPublicId,
              startedAt: resume.startedAt,
            },
      now,
    }),
  );
  const wake = { organizationPublicId, channelAccountPublicId, enqueueTask, requestId };
  if (begun.kind === 'refused') {
    await wakeNextRead(wake);
    return { outcome: 'refused', postsReadByThisJob: 0 };
  }
  if (begun.kind !== 'reading') return idle;
  const { read } = begun;
  if (!access.isSendable || access.encryptedAccessToken === null) {
    await runInDatabaseSlot(() =>
      services.automationBackfillService.finishAutomationBackfillRead({
        scope,
        read,
        failure: { reason: 'meta_error', lastError: 'account_not_connected' },
      }),
    );
    await wakeNextRead(wake);
    return { outcome: 'failed', postsReadByThisJob: 0 };
  }
  const settings = await runInDatabaseSlot(() =>
    services.instagramAccountSettingsService.findSettings({
      scope,
      channelAccount: access.channelAccount,
    }),
  );
  let lastCallAt: number | null = null;
  const pace = async () => {
    if (lastCallAt !== null) {
      const gap = INSTAGRAM_MISSED_COMMENT_CALL_GAP_MILLISECONDS - (Date.now() - lastCallAt);
      if (gap > 0) await wait(gap);
    }
    lastCallAt = Date.now();
  };
  return readFromPost({
    context: {
      organizationPublicId,
      channelAccountPublicId,
      scope,
      access,
      read,
      requestId,
      now,
      services,
      client,
      runInDatabaseSlot,
      pace,
      enqueueTask,
      enqueueIntake,
    },
    postNumber: resume?.postNumber ?? 0,
    metaTry: resume?.metaTry ?? 0,
    isRepliesIncluded: settings?.is_comment_reply_trigger_enabled ?? true,
  });
}
