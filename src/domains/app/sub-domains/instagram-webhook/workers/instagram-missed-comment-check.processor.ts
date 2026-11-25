import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';
import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { MILLISECONDS_PER_DAY, MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import { NotFoundError } from '@/shared/errors/index.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { isPostWatchedByCommentAutomations } from '@/domains/app/sub-domains/automation/automation-run/automation-run-matching.util.js';
import type { AutomationService } from '@/domains/app/sub-domains/automation/automation.service.js';
import {
  type InstagramCommentGraphItem,
  listInstagramMediaComments,
  readInstagramCommentTime,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import {
  createRetentionInstagramMediaRepository,
  type InstagramMediaRow,
  type InstagramMediaWatchedAccount,
} from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.repository.js';
import type { InstagramMediaService } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.service.js';
import type { InstagramSendAccessService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-access.service.js';
import type {
  InstagramSendAccess,
  InstagramTaskHandler,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import { enqueueInstagramTask } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.queue.js';
import { classifyInstagramWebhookItem } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event-classifier.util.js';
import type { NewInstagramWebhookEvent } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import type { InstagramWebhookEventService } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.service.js';
import {
  INSTAGRAM_MISSED_COMMENT_CALL_GAP_MILLISECONDS,
  INSTAGRAM_MISSED_COMMENT_FULL_PASS_PRIORITY,
  INSTAGRAM_MISSED_COMMENT_FULL_PASS_SPREAD_MINUTES,
  INSTAGRAM_MISSED_COMMENT_FULL_PASS_USAGE_STOP_PERCENT,
  INSTAGRAM_MISSED_COMMENT_MAX_AGE_DAYS,
  INSTAGRAM_MISSED_COMMENT_MAX_PAGES_PER_POST,
  INSTAGRAM_MISSED_COMMENT_OUTAGE_AFTER_MINUTES,
  INSTAGRAM_MISSED_COMMENT_OVERLAP_MINUTES,
  INSTAGRAM_MISSED_COMMENT_POSTS_PER_ROUND,
  INSTAGRAM_MISSED_COMMENT_ROUND_MINUTES,
  INSTAGRAM_MISSED_COMMENT_ROUND_PRIORITY,
  INSTAGRAM_MISSED_COMMENT_ROUND_USAGE_STOP_PERCENT,
  INSTAGRAM_MISSED_COMMENT_SWEEP_ACCOUNT_LIMIT,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.constants.js';
import type { InstagramWebhookIntakeEnqueue } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';
import { enqueueInstagramWebhookIntake } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import { INSTAGRAM_MISSED_COMMENT_CHECK_JOB_NAME } from './instagram-missed-comment-check.constants.js';
import type { InstagramLateCommentTimeReader } from './instagram-webhook-intake.processor.js';

/** A late comment's time read gives up after this long and intake keeps the received time (WH12 step 2). */
const LATE_COMMENT_TIME_READ_TIMEOUT_MILLISECONDS = 3000;

/** At Meta's wait (95 % or a time Meta named, read as 100) the late comment's read is not made. */
const LATE_COMMENT_TIME_READ_USAGE_STOP_PERCENT = 95;

/**
 * Intake's {@link InstagramLateCommentTimeReader} (WH12 step 2, R38's port): a comment whose webhook
 * came over an hour late gets its own time from Meta — the account's send access, the connection's
 * Meta usage read first (P51/S13), one `GET /{comment_id}?fields=timestamp`, 3 s, failing open.
 *
 * @remarks
 * - **Algorithm:** `readSendAccess` (token, connection), `readUsagePercent` — at Meta's wait (95 %
 *   or a named time) no call is made — then {@link readInstagramCommentTime} with the connection's
 *   usage recorder, raced against a 3-second timer.
 * - **Failure modes:** an account not sendable, Meta's wait, a timeout → `null` (the received
 *   time); a Meta or access failure propagates to intake, which logs it and keeps the received time
 *   (WH25).
 * - **Side effects:** reads; one Meta read and its usage write.
 * - **Notes:** passed to `processInstagramWebhookIntakeJob` by the intake worker.
 */
export function createInstagramLateCommentTimeReader({
  instagramSendAccessService,
  readCommentTime = readInstagramCommentTime,
}: {
  instagramSendAccessService: Pick<
    InstagramSendAccessService,
    'readSendAccess' | 'readUsagePercent' | 'buildUsageRecorder'
  >;
  readCommentTime?: typeof readInstagramCommentTime;
}): InstagramLateCommentTimeReader {
  return async ({ scope, channelAccountPublicId, instagramCommentId, requestId }) => {
    const access = await instagramSendAccessService.readSendAccess({
      scope,
      channelAccountPublicId,
    });
    if (!access.isSendable || access.encryptedAccessToken === null) return null;
    const usagePercent = await instagramSendAccessService.readUsagePercent({ scope, access });
    if (usagePercent >= LATE_COMMENT_TIME_READ_USAGE_STOP_PERCENT) return null;
    const timeout = new AbortController();
    try {
      return await Promise.race([
        readCommentTime({
          encryptedAccessToken: access.encryptedAccessToken,
          instagramCommentId,
          requestId,
          recordUsage: instagramSendAccessService.buildUsageRecorder({ scope, access }),
        }),
        sleep(LATE_COMMENT_TIME_READ_TIMEOUT_MILLISECONDS, null, { signal: timeout.signal }),
      ]);
    } finally {
      timeout.abort();
    }
  };
}

/**
 * Which look an account gets (WH17, P93): the 30-minute `round` reads its due watched posts and is
 * skipped at 80 % Meta usage; the `full_pass` after an outage reads every watched post, at the
 * lowest priority, and stops at 60 % — both at most 25 posts and comments of the last 7 days.
 *
 * @remarks
 * Notes: carried in the look's task input and its job id.
 */
export type InstagramMissedCommentLookMode = 'round' | 'full_pass';

/** The look's task input: the account and the mode — public ids only (K8). */
const missedCommentCheckInputSchema = z.object({
  channelAccountPublicId: z.string().min(1).max(28),
  mode: z.enum(['round', 'full_pass']),
});

/** The spread and priority of each mode. */
const LOOK_MODE_SETTINGS: Readonly<
  Record<
    InstagramMissedCommentLookMode,
    { spreadMinutes: number; priority: number; usageStopPercent: number }
  >
> = {
  round: {
    spreadMinutes: INSTAGRAM_MISSED_COMMENT_ROUND_MINUTES,
    priority: INSTAGRAM_MISSED_COMMENT_ROUND_PRIORITY,
    usageStopPercent: INSTAGRAM_MISSED_COMMENT_ROUND_USAGE_STOP_PERCENT,
  },
  full_pass: {
    spreadMinutes: INSTAGRAM_MISSED_COMMENT_FULL_PASS_SPREAD_MINUTES,
    priority: INSTAGRAM_MISSED_COMMENT_FULL_PASS_PRIORITY,
    usageStopPercent: INSTAGRAM_MISSED_COMMENT_FULL_PASS_USAGE_STOP_PERCENT,
  },
};

/**
 * Adds one account's missed-comment look to `instagram-tasks` (WC-26): job id
 * `missed-comments-<mode>-<cha_…>-<window>` (one per account, mode and window — a repeat in the
 * window is a no-op), at the mode's priority, after the account's place in the spread.
 *
 * @remarks
 * - **Algorithm:** the window is the current round (30 min) or full-pass spread (10 min) slot; the
 *   delay is the account's internal id modulo the spread, in seconds — so accounts spread over the
 *   interval and one account keeps its place.
 * - **Failure modes:** propagates BullMQ / Redis errors — the sweep logs them and the next round
 *   finds the account again.
 * - **Side effects:** at most one task.
 * - **Notes:** the full pass is P93's: the lowest priority on the queue.
 */
export async function enqueueInstagramMissedCommentCheck({
  organizationPublicId,
  channelAccountPublicId,
  spreadKey,
  mode,
  now = new Date(),
  enqueue = enqueueInstagramTask,
}: {
  organizationPublicId: string;
  channelAccountPublicId: string;
  /** A stable number of the account (its internal id) — its place in the spread. */
  spreadKey: number;
  mode: InstagramMissedCommentLookMode;
  now?: Date | undefined;
  enqueue?: typeof enqueueInstagramTask | undefined;
}): Promise<void> {
  const { spreadMinutes, priority } = LOOK_MODE_SETTINGS[mode];
  const spreadSeconds = spreadMinutes * 60;
  const window = Math.floor(now.getTime() / (spreadMinutes * MILLISECONDS_PER_MINUTE));
  await enqueue({
    jobName: INSTAGRAM_MISSED_COMMENT_CHECK_JOB_NAME,
    jobId: `missed-comments-${mode}-${channelAccountPublicId}-${window}`,
    organizationPublicId,
    taskInput: { channelAccountPublicId, mode },
    priority,
    delayMilliseconds: (Math.abs(Math.trunc(spreadKey)) % spreadSeconds) * 1000,
  });
}

/**
 * What one missed-comment sweep did: the watched accounts read, the looks added by mode, and the
 * adds Redis refused.
 *
 * @remarks
 * - **Algorithm:** counts only.
 * - **Failure modes:** none — a return shape.
 * - **Side effects:** none.
 * - **Notes:** logged as `app.instagram_webhook.missed_comment_sweep_completed`.
 */
export interface InstagramMissedCommentSweepResult {
  listedCount: number;
  roundCount: number;
  fullPassCount: number;
  failedAddCount: number;
}

/**
 * The mode a watched account's look takes now, or `null` when none of its posts is due.
 *
 * @remarks
 * - **Algorithm:** a due account whose watched posts were last read more than
 *   {@link INSTAGRAM_MISSED_COMMENT_OUTAGE_AFTER_MINUTES} minutes ago missed two rounds → the
 *   `full_pass`; else the `round`. Never read yet → the `round`.
 * - **Failure modes:** none; pure.
 * - **Side effects:** none.
 * - **Notes:** the outage signal lives in Postgres (the posts' read times, P32).
 */
export function chooseInstagramMissedCommentLookMode({
  account,
  now,
}: {
  account: Pick<InstagramMediaWatchedAccount, 'isDue' | 'lastCheckedAt'>;
  now: Date;
}): InstagramMissedCommentLookMode | null {
  if (!account.isDue) return null;
  const isAfterOutage =
    account.lastCheckedAt !== null &&
    now.getTime() - account.lastCheckedAt.getTime() >
      INSTAGRAM_MISSED_COMMENT_OUTAGE_AFTER_MINUTES * MILLISECONDS_PER_MINUTE;
  return isAfterOutage ? 'full_pass' : 'round';
}

/**
 * The missed-comment sweep (feat-instagram-dm-sending § 5.A WH17, WHC10; worker-changes WC-26):
 * every 30 minutes, one look per connected account that watches a post, spread over the round — and
 * the full pass for an account whose rounds were missed (an outage: the server, Redis or Postgres
 * down).
 *
 * @remarks
 * - **Algorithm:** one read across organizations under `runGlobalRetentionWorkerJob` (the media,
 *   channel account and organization policies' sweep arm, `USING` only): the connected Instagram
 *   accounts of live organizations with a watched post, each with when its watched posts were last
 *   read and whether one is due. An account with a due post gets a look — the `full_pass` when its
 *   posts were last read more than {@link INSTAGRAM_MISSED_COMMENT_OUTAGE_AFTER_MINUTES} minutes ago
 *   (two rounds missed), else the `round`. Then, with the context closed, one task per account
 *   ({@link enqueueInstagramMissedCommentCheck}).
 * - **Failure modes:** a failed read throws to BullMQ (the next round reads again); a failed add
 *   is logged (`app.instagram_webhook.missed_comment_enqueue_failed`).
 * - **Side effects:** tasks on `instagram-tasks`; nothing is written.
 * - **Notes:** a repeatable job on the intake queue, run by the intake worker (the pick-up's
 *   pattern). The webhook-off case is the subscription check's — it calls
 *   {@link lookForMissedComments} for its account (WC-25, R40). Postgres holds the outage signal
 *   (the watched posts' read times), so a Redis loss that dropped looks shows as missed rounds too.
 */
export async function runInstagramMissedCommentSweepJob({
  now = new Date(),
  enqueueLook = enqueueInstagramMissedCommentCheck,
}: {
  now?: Date | undefined;
  enqueueLook?: typeof enqueueInstagramMissedCommentCheck | undefined;
} = {}): Promise<InstagramMissedCommentSweepResult> {
  const accounts = await runGlobalRetentionWorkerJob((databaseHandle) =>
    createRetentionInstagramMediaRepository(databaseHandle).listAccountsWithCommentWatches({
      limit: INSTAGRAM_MISSED_COMMENT_SWEEP_ACCOUNT_LIMIT,
    }),
  );
  const result: InstagramMissedCommentSweepResult = {
    listedCount: accounts.length,
    roundCount: 0,
    fullPassCount: 0,
    failedAddCount: 0,
  };
  for (const account of accounts) {
    const mode = chooseInstagramMissedCommentLookMode({ account, now });
    if (mode === null) continue;
    try {
      await enqueueLook({
        organizationPublicId: account.organizationPublicId,
        channelAccountPublicId: account.channelAccountPublicId,
        spreadKey: account.channelAccountId,
        mode,
        now,
      });
      if (mode === 'full_pass') result.fullPassCount += 1;
      else result.roundCount += 1;
    } catch (error) {
      result.failedAddCount += 1;
      logger.warn(
        {
          organizationPublicId: account.organizationPublicId,
          channelAccountPublicId: account.channelAccountPublicId,
          mode,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        'app.instagram_webhook.missed_comment_enqueue_failed',
      );
    }
  }
  if (result.listedCount >= INSTAGRAM_MISSED_COMMENT_SWEEP_ACCOUNT_LIMIT) {
    logger.warn(result, 'app.instagram_webhook.missed_comment_sweep_capped');
  }
  logger.info(result, 'app.instagram_webhook.missed_comment_sweep_completed');
  return result;
}

/**
 * The full pass for one account after its webhook was off (WC-25 → WC-26, plan §34 rule 18) — the
 * function `InstagramMissedCommentPort.lookForMissedComments` (ROUTE row R40's subscription check)
 * is wired to.
 *
 * @remarks
 * - **Algorithm:** one `full_pass` look for the account, spread over the 10-minute window by a hash
 *   of its public id (the port carries public ids only).
 * - **Failure modes:** propagates BullMQ / Redis errors to the check, which logs them.
 * - **Side effects:** at most one task per account and window.
 * - **Notes:** the look itself keeps P93's limits.
 */
export async function lookForMissedComments({
  organizationPublicId,
  channelAccountPublicId,
}: {
  organizationPublicId: string;
  channelAccountPublicId: string;
}): Promise<void> {
  let spreadKey = 0;
  for (const character of channelAccountPublicId) {
    spreadKey = (spreadKey * 31 + character.charCodeAt(0)) % 1_000_003;
  }
  await enqueueInstagramMissedCommentCheck({
    organizationPublicId,
    channelAccountPublicId,
    spreadKey,
    mode: 'full_pass',
  });
}

/**
 * The services one look uses (each its owner's).
 *
 * @remarks
 * Notes: structural `Pick`s — the account, its send access and Meta usage, its comment-reply
 * switch, its live comment automations, its watched posts and their watch, and the events' store.
 */
export interface InstagramMissedCommentCheckServices {
  instagramAccountService: Pick<InstagramAccountService, 'findWebhookProcessingAccount'>;
  instagramSendAccessService: Pick<
    InstagramSendAccessService,
    'readSendAccess' | 'readUsagePercent' | 'buildUsageRecorder'
  >;
  instagramAccountSettingsService: Pick<InstagramAccountSettingsService, 'findSettings'>;
  automationService: Pick<AutomationService, 'listLiveCommentAutomations'>;
  instagramMediaService: Pick<InstagramMediaService, 'listWatchedPosts' | 'updateCommentWatch'>;
  instagramWebhookEventService: Pick<InstagramWebhookEventService, 'recordReceivedEvents'>;
}

/**
 * What one look did (logged as `app.instagram_webhook.missed_comment_look_completed`).
 *
 * @remarks
 * - **Algorithm:** `outcome` — `skipped` (no account, not connected, no token, the switch off);
 *   `paused` (Meta's usage at the mode's stop, or Meta failed: the rest waits for the next round);
 *   `done`.
 * - **Failure modes:** none — a return shape.
 * - **Side effects:** none.
 * - **Notes:** `foundCommentCount` is the comments saved as new events.
 */
export interface InstagramMissedCommentLookResult {
  outcome: 'skipped' | 'paused' | 'done';
  readPostCount: number;
  stoppedWatchCount: number;
  callCount: number;
  foundCommentCount: number;
}

/**
 * The post a read comment sits on, as the comment change carries it: its Instagram media id, its
 * product type (stored lowercase) and, for an ad's post, the ad (`media.ad_id` — intake's
 * `ad_comment`).
 *
 * @remarks
 * Notes: a stored post gives the first two; a past-comments read of an ad passes the ad id.
 */
export interface InstagramReadCommentMedia {
  instagramMediaId: string;
  mediaProductType: string | null;
  adId?: string | null | undefined;
}

/** The comment change a webhook would have delivered for this comment (WH9): `comments`, its value. */
function toCommentChangeItem({
  comment,
  media,
}: {
  comment: InstagramCommentGraphItem;
  media: InstagramReadCommentMedia;
}): Record<string, unknown> {
  return {
    field: 'comments',
    value: {
      id: comment.id,
      text: comment.text,
      timestamp: comment.timestamp,
      from: {
        id: comment.from?.id,
        username: comment.from?.username ?? comment.username,
      },
      media: {
        id: media.instagramMediaId,
        ...(media.mediaProductType === null
          ? {}
          : { media_product_type: media.mediaProductType.toUpperCase() }),
        ...(media.adId === null || media.adId === undefined ? {} : { ad_id: media.adId }),
      },
      ...(comment.parent_id === undefined ? {} : { parent_id: comment.parent_id }),
    },
  };
}

/**
 * A read comment's own time, or `null` when Meta sent none it can read.
 *
 * @remarks
 * Notes: pure; shared by the missed-comment look and the past-comments read.
 */
export function readInstagramCommentTimeOf(comment: InstagramCommentGraphItem): Date | null {
  if (comment.timestamp === undefined) return null;
  const time = new Date(comment.timestamp);
  return Number.isNaN(time.getTime()) ? null : time;
}

/** A comment's own time, or `null` when Meta sent none it can read. */
const commentTimeOf = readInstagramCommentTimeOf;

/** The comments read from one post: the new-enough ones and the newest time seen. */
interface PostRead {
  comments: InstagramCommentGraphItem[];
  newestCommentAt: Date | null;
  callCount: number;
  /** Meta's usage reached the stop before a page: the look stops after this post. */
  isStopped: boolean;
  /**
   * The read reached the cut-off or the last page — or its page cap, whose older comments are left
   * behind: only then does the post's last seen comment move on.
   */
  isComplete: boolean;
}

/** Everything one post's read needs. */
interface PostReadContext {
  scope: OrganizationPrincipalDatabaseScope;
  access: InstagramSendAccess;
  post: InstagramMediaRow;
  isRepliesIncluded: boolean;
  usageStopPercent: number;
  now: Date;
  requestId: string;
  services: InstagramMissedCommentCheckServices;
  listComments: typeof listInstagramMediaComments;
  pace: () => Promise<void>;
  logFields: Record<string, unknown>;
}

/**
 * Reads one post's comments newest first (WH17): page after page until a top-level comment is older
 * than the cut-off (the last seen comment minus 10 minutes, never before 7 days ago), at most
 * {@link INSTAGRAM_MISSED_COMMENT_MAX_PAGES_PER_POST} pages, one call a second, the usage checked
 * before each call. Replies come with their comment when asked for (D64).
 */
async function readPostComments(context: PostReadContext): Promise<PostRead> {
  const { post, now } = context;
  const oldestAllowed =
    now.getTime() - INSTAGRAM_MISSED_COMMENT_MAX_AGE_DAYS * MILLISECONDS_PER_DAY;
  const lastSeen =
    post.last_comment_at === null
      ? oldestAllowed
      : post.last_comment_at.getTime() -
        INSTAGRAM_MISSED_COMMENT_OVERLAP_MINUTES * MILLISECONDS_PER_MINUTE;
  const cutOff = Math.max(lastSeen, oldestAllowed);
  const read: PostRead = {
    comments: [],
    newestCommentAt: null,
    callCount: 0,
    isStopped: false,
    isComplete: false,
  };
  const keep = (comment: InstagramCommentGraphItem) => {
    const time = commentTimeOf(comment);
    if (time === null || time.getTime() < cutOff) return;
    read.comments.push(comment);
    if (read.newestCommentAt === null || time > read.newestCommentAt) read.newestCommentAt = time;
  };
  let after: string | undefined;
  for (let page = 0; page < INSTAGRAM_MISSED_COMMENT_MAX_PAGES_PER_POST; page += 1) {
    const usagePercent = await context.services.instagramSendAccessService.readUsagePercent({
      scope: context.scope,
      access: context.access,
      now,
    });
    if (usagePercent >= context.usageStopPercent) {
      logger.info(
        { ...context.logFields, usagePercent },
        'app.instagram_webhook.missed_comment_look_paused',
      );
      read.isStopped = true;
      return read;
    }
    await context.pace();
    read.callCount += 1;
    const answer = await context.listComments({
      encryptedAccessToken: context.access.encryptedAccessToken as string,
      instagramMediaId: post.instagram_media_id,
      isRepliesIncluded: context.isRepliesIncluded,
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
      const time = commentTimeOf(comment);
      if (time !== null && time.getTime() < cutOff) isPastCutOff = true;
    }
    if (isPastCutOff || answer.nextCursor === null) return { ...read, isComplete: true };
    after = answer.nextCursor;
  }
  logger.warn(
    { ...context.logFields, instagramMediaId: post.instagram_media_id },
    'app.instagram_webhook.missed_comment_page_cap_reached',
  );
  return { ...read, isComplete: true };
}

/**
 * Comments read from Meta, as the webhook would have saved them (WH9, WH17) — the missed-comment
 * look and the past-comments read (WC-41): each through the one classifier (key `comment:<id>`),
 * the account's own comments dropped, the comment's own time as its Meta time (its key's day,
 * WH20).
 *
 * @remarks
 * Notes: pure; the caller saves them through `recordReceivedEvents` (a key already used is not
 * saved again).
 */
export function toInstagramCommentEvents({
  comments,
  media,
  instagramUserId,
}: {
  comments: readonly InstagramCommentGraphItem[];
  media: InstagramReadCommentMedia;
  instagramUserId: string;
}): NewInstagramWebhookEvent[] {
  return comments.flatMap((comment) => {
    const time = commentTimeOf(comment);
    const classified = classifyInstagramWebhookItem({
      source: 'changes',
      item: toCommentChangeItem({ comment, media }),
      accountIds: { instagramUserId },
      entryTime: time === null ? undefined : Math.floor(time.getTime() / 1000),
    });
    if (classified === null || classified.kindSkipReason !== null) return [];
    return [
      {
        instagramUserId,
        contactInstagramUserId: classified.contactInstagramUserId,
        eventKind: classified.eventKind,
        eventKey: classified.eventKey,
        skipReason: null,
        payload: classified.payload,
        occurredAt: classified.occurredAt,
      },
    ];
  });
}

/** The account as a look needs it, or `null` (logged) when it is not one to look at. */
async function readLookAccount({
  scope,
  channelAccountPublicId,
  services,
  logFields,
}: {
  scope: OrganizationPrincipalDatabaseScope;
  channelAccountPublicId: string;
  services: InstagramMissedCommentCheckServices;
  logFields: Record<string, unknown>;
}): Promise<{
  access: InstagramSendAccess;
  channelAccount: { organizationId: number; channelAccountId: number };
} | null> {
  const account = await services.instagramAccountService.findWebhookProcessingAccount({
    scope,
    instagramAccountPublicId: channelAccountPublicId,
  });
  if (
    account === null ||
    account.connectionStatus !== 'connected' ||
    account.encryptedAccessToken === null ||
    !account.isAutomationEnabled
  ) {
    let reason = 'account_not_found';
    if (account !== null)
      reason = account.isAutomationEnabled ? 'not_connected' : 'automation_disabled';
    logger.info({ ...logFields, reason }, 'app.instagram_webhook.missed_comment_look_skipped');
    return null;
  }
  try {
    const access = await services.instagramSendAccessService.readSendAccess({
      scope,
      channelAccountPublicId,
    });
    if (!access.isSendable || access.encryptedAccessToken === null) {
      logger.info(
        { ...logFields, reason: 'not_connected' },
        'app.instagram_webhook.missed_comment_look_skipped',
      );
      return null;
    }
    return {
      access,
      channelAccount: {
        organizationId: account.instagramAccount.organizationId,
        channelAccountId: account.channelAccountId,
      },
    };
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    logger.info(
      { ...logFields, reason: 'account_not_found' },
      'app.instagram_webhook.missed_comment_look_skipped',
    );
    return null;
  }
}

/**
 * The `missed-comment-check` task (feat-instagram-dm-sending § 5.A WH17, WHC10; worker-changes
 * WC-26): one account's look for comments Meta never delivered by webhook — the 30-minute `round`
 * or the `full_pass` after an outage, both kept to P93's limits.
 *
 * @remarks
 * - **Algorithm:** in database slots: the account (connected, its token, the automation switch on),
 *   its send access (Instagram user id, connection, token), its comment-reply switch (D64, on when no
 *   settings row), its live comment and ad-comment automations, and its watched posts — the due ones
 *   for a round, every watched one for the full pass — read longest ago first, at most
 *   {@link INSTAGRAM_MISSED_COMMENT_POSTS_PER_ROUND}. A post no live automation could take, or
 *   whose post and last comment are both older than 7 days, stops being watched without a call.
 *   Before each Meta call the connection's usage is read ({@link InstagramSendAccessService.readUsagePercent},
 *   P51/S13): at 80 % (round) or 60 % (full pass) the look stops and the rest waits for the next
 *   round. Each post's comments are read newest first, one call a second, back to the last seen
 *   comment minus 10 minutes and never past 7 days; the new ones are saved through the webhook's own
 *   store function (`recordReceivedEvents`, key `comment:<id>`, so a comment Meta also delivers is
 *   saved once), the post's watch moves on (read now, the newest comment, next read in 30 minutes,
 *   `updateCommentWatch`). After the last post, one `intake-comments` job for the account when a
 *   comment was found.
 * - **Failure modes:** an account gone, not connected or switched off → skipped; Meta refusing one
 *   post (`refused`) → that post skipped; any other Meta failure (a throttle, an outage, the token)
 *   stops the look — logged, the posts stay due for the next round; database errors propagate (the
 *   queue's one attempt; the next round reads again).
 * - **Side effects:** Meta reads; event and key rows; the posts' watch fields; one intake job.
 * - **Notes:** `callsMeta` — the task asks `mayTakeTickets` first; registered as
 *   `instagramSendWork.taskHandlers['missed-comment-check']` by the app container. Live comments
 *   are not read back (a Live reply is useless after the Live). The owner's "found N missed
 *   comments" notice is the log line `app.instagram_webhook.missed_comments_found` until the
 *   notices row adds it.
 */
export function createInstagramMissedCommentCheckTaskHandler({
  services,
  listComments = listInstagramMediaComments,
  wait = (milliseconds: number) => sleep(milliseconds),
  readNow = () => new Date(),
  enqueueIntake = enqueueInstagramWebhookIntake,
}: {
  services: InstagramMissedCommentCheckServices;
  /** The comment read — the real client's by default; tests pass nock or a fake. */
  listComments?: typeof listInstagramMediaComments;
  /** The pause between two calls (1 s); tests pass a no-op. */
  wait?: (milliseconds: number) => Promise<unknown>;
  readNow?: () => Date;
  enqueueIntake?: InstagramWebhookIntakeEnqueue;
}): InstagramTaskHandler {
  return {
    callsMeta: true,
    inputSchema: missedCommentCheckInputSchema,
    async run({ organizationPublicId, taskInput, context }) {
      const { channelAccountPublicId, mode } = missedCommentCheckInputSchema.parse(taskInput);
      const result = await runMissedCommentLook({
        organizationPublicId,
        channelAccountPublicId,
        mode,
        requestId: context.jobId,
        runInDatabaseSlot: (callback) => context.runInDatabaseSlot(callback),
        services,
        listComments,
        wait,
        now: readNow(),
        enqueueIntake,
      });
      logger.info(
        { jobId: context.jobId, organizationPublicId, channelAccountPublicId, mode, ...result },
        'app.instagram_webhook.missed_comment_look_completed',
      );
    },
  };
}

/** What one look shares across its posts. */
interface LookAtPostContext {
  scope: OrganizationPrincipalDatabaseScope;
  access: InstagramSendAccess;
  channelAccount: Parameters<
    InstagramMissedCommentCheckServices['instagramMediaService']['updateCommentWatch']
  >[0]['channelAccount'];
  automations: Parameters<typeof isPostWatchedByCommentAutomations>[0]['candidates'];
  oldestAllowed: number;
  now: Date;
  requestId: string;
  logFields: Record<string, unknown>;
}

/**
 * One watched post of a look: its watch stopped when nothing watches it any more, else its comments
 * read back, saved and its watch moved on; `paused` when the look must stop (Meta down, or its usage
 * reached the stop).
 */
async function lookAtPost({
  post,
  look,
  isRepliesIncluded,
  usageStopPercent,
  runInDatabaseSlot,
  services,
  listComments,
  pace,
  result,
}: {
  post: InstagramMediaRow;
  look: LookAtPostContext;
  isRepliesIncluded: boolean;
  usageStopPercent: number;
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => Promise<T>;
  services: InstagramMissedCommentCheckServices;
  listComments: typeof listInstagramMediaComments;
  pace: () => Promise<void>;
  result: InstagramMissedCommentLookResult;
}): Promise<'paused' | 'next'> {
  const { scope, access, channelAccount, now, requestId, logFields } = look;
  const newestKnown = Math.max(
    post.published_at.getTime(),
    post.last_comment_at?.getTime() ?? Number.NEGATIVE_INFINITY,
  );
  const isWatched =
    newestKnown >= look.oldestAllowed &&
    isPostWatchedByCommentAutomations({
      candidates: look.automations,
      mediaId: post.instagram_media_id,
      mediaPublishedAt: post.published_at,
    });
  if (!isWatched) {
    await runInDatabaseSlot(() =>
      services.instagramMediaService.updateCommentWatch({
        scope,
        channelAccount,
        instagramMediaId: post.instagram_media_id,
        watch: { commentsNextCheckAt: null },
      }),
    );
    result.stoppedWatchCount += 1;
    return 'next';
  }
  let read: PostRead;
  try {
    read = await readPostComments({
      scope,
      access,
      post,
      isRepliesIncluded,
      usageStopPercent,
      now,
      requestId,
      services,
      listComments,
      pace,
      logFields,
    });
  } catch (error) {
    if (!(error instanceof MetaGraphApiError)) throw error;
    result.callCount += 1;
    logger.warn(
      {
        ...logFields,
        instagramMediaId: post.instagram_media_id,
        errorClass: error.errorClass,
        instagramErrorCode: error.instagramErrorCode,
      },
      'app.instagram_webhook.missed_comment_read_failed',
    );
    return error.errorClass === 'refused' ? 'next' : 'paused';
  }
  result.callCount += read.callCount;
  if (read.isStopped && read.callCount === 0) return 'paused';
  const savedCount = await saveReadComments({ post, read, look, runInDatabaseSlot, services });
  result.readPostCount += 1;
  result.foundCommentCount += savedCount;
  return read.isStopped ? 'paused' : 'next';
}

/** A post's read comments saved as webhook events, and its watch moved on, in one unit. */
async function saveReadComments({
  post,
  read,
  look,
  runInDatabaseSlot,
  services,
}: {
  post: InstagramMediaRow;
  read: PostRead;
  look: LookAtPostContext;
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => Promise<T>;
  services: InstagramMissedCommentCheckServices;
}): Promise<number> {
  const { scope, access, channelAccount, now, requestId } = look;
  const events = toInstagramCommentEvents({
    comments: read.comments,
    media: {
      instagramMediaId: post.instagram_media_id,
      mediaProductType: post.media_product_type,
    },
    instagramUserId: access.instagramUserId,
  });
  // The last seen comment moves on only when the read completed (its older comments all read).
  const lastSeen =
    read.newestCommentAt !== null && read.isComplete ? { lastCommentAt: read.newestCommentAt } : {};
  return runInDatabaseSlot(async () => {
    const rows = await services.instagramWebhookEventService.recordReceivedEvents({
      scope,
      channelAccount,
      requestId,
      events,
      now,
    });
    await services.instagramMediaService.updateCommentWatch({
      scope,
      channelAccount,
      instagramMediaId: post.instagram_media_id,
      watch: {
        commentsCheckedAt: now,
        commentsNextCheckAt: new Date(
          now.getTime() + INSTAGRAM_MISSED_COMMENT_ROUND_MINUTES * MILLISECONDS_PER_MINUTE,
        ),
        ...lastSeen,
      },
    });
    return rows.length;
  });
}

/** The look's saved comments handed to intake; a failed add leaves them for the pick-up (WH17). */
async function handFoundCommentsToIntake({
  organizationPublicId,
  channelAccountPublicId,
  requestId,
  enqueueIntake,
  logFields,
  foundCommentCount,
}: {
  organizationPublicId: string;
  channelAccountPublicId: string;
  requestId: string;
  enqueueIntake: InstagramWebhookIntakeEnqueue;
  logFields: Record<string, unknown>;
  foundCommentCount: number;
}): Promise<void> {
  logger.info({ ...logFields, foundCommentCount }, 'app.instagram_webhook.missed_comments_found');
  try {
    await enqueueIntake({
      organizationPublicId,
      channelAccountPublicId,
      intakeKind: 'comments',
      requestId,
    });
  } catch (error) {
    // The saved events wait `received`; the every-minute pick-up hands them to intake (WH17).
    logger.warn(
      { ...logFields, errorName: error instanceof Error ? error.name : typeof error },
      'app.instagram_webhook.missed_comment_intake_enqueue_failed',
    );
  }
}

/** One look, as {@link createInstagramMissedCommentCheckTaskHandler} describes it. */
async function runMissedCommentLook({
  organizationPublicId,
  channelAccountPublicId,
  mode,
  requestId,
  runInDatabaseSlot,
  services,
  listComments,
  wait,
  now,
  enqueueIntake,
}: {
  organizationPublicId: string;
  channelAccountPublicId: string;
  mode: InstagramMissedCommentLookMode;
  requestId: string;
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => Promise<T>;
  services: InstagramMissedCommentCheckServices;
  listComments: typeof listInstagramMediaComments;
  wait: (milliseconds: number) => Promise<unknown>;
  now: Date;
  enqueueIntake: InstagramWebhookIntakeEnqueue;
}): Promise<InstagramMissedCommentLookResult> {
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
  const logFields = { jobId: requestId, organizationPublicId, channelAccountPublicId, mode };
  const result: InstagramMissedCommentLookResult = {
    outcome: 'done',
    readPostCount: 0,
    stoppedWatchCount: 0,
    callCount: 0,
    foundCommentCount: 0,
  };
  const prepared = await runInDatabaseSlot(async () => {
    const account = await readLookAccount({ scope, channelAccountPublicId, services, logFields });
    if (account === null) return null;
    const { channelAccount } = account;
    const settings = await services.instagramAccountSettingsService.findSettings({
      scope,
      channelAccount,
    });
    const automations = await services.automationService.listLiveCommentAutomations({
      scope,
      channelAccount,
    });
    const posts = await services.instagramMediaService.listWatchedPosts({
      scope,
      channelAccount,
      isDueOnly: mode === 'round',
      limit: INSTAGRAM_MISSED_COMMENT_POSTS_PER_ROUND,
    });
    return {
      ...account,
      isRepliesIncluded: settings?.is_comment_reply_trigger_enabled ?? true,
      automations,
      posts,
    };
  });
  if (prepared === null) return { ...result, outcome: 'skipped' };
  const { access, channelAccount, automations, posts } = prepared;
  const oldestAllowed =
    now.getTime() - INSTAGRAM_MISSED_COMMENT_MAX_AGE_DAYS * MILLISECONDS_PER_DAY;
  let lastCallAt: number | null = null;
  const pace = async () => {
    if (lastCallAt !== null) {
      const gap = INSTAGRAM_MISSED_COMMENT_CALL_GAP_MILLISECONDS - (Date.now() - lastCallAt);
      if (gap > 0) await wait(gap);
    }
    lastCallAt = Date.now();
  };
  for (const post of posts) {
    const step = await lookAtPost({
      post,
      look: {
        scope,
        access,
        channelAccount,
        automations,
        oldestAllowed,
        now,
        requestId,
        logFields,
      },
      isRepliesIncluded: prepared.isRepliesIncluded,
      usageStopPercent: LOOK_MODE_SETTINGS[mode].usageStopPercent,
      runInDatabaseSlot,
      services,
      listComments,
      pace,
      result,
    });
    if (step === 'paused') {
      result.outcome = 'paused';
      break;
    }
  }
  if (result.foundCommentCount > 0) {
    await handFoundCommentsToIntake({
      organizationPublicId,
      channelAccountPublicId,
      requestId,
      enqueueIntake,
      logFields,
      foundCommentCount: result.foundCommentCount,
    });
  }
  return result;
}
