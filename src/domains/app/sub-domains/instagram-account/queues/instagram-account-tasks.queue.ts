import { z } from 'zod';
import {
  MILLISECONDS_PER_MINUTE,
  MILLISECONDS_PER_SECOND,
} from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { enqueueInstagramTask } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.queue.js';

/**
 * Job name of the account set-up on `instagram-tasks` (feat-instagram-dm-sending WC-30, IA6): the six
 * webhook fields, the starter questions, the message-access probe.
 */
export const INSTAGRAM_ACCOUNT_SETUP_JOB_NAME = 'instagram-account-setup';

/** Job name of one account's webhook subscription check on `instagram-tasks` (WC-25, IA6). */
export const INSTAGRAM_WEBHOOK_SUBSCRIPTION_CHECK_JOB_NAME = 'instagram-webhook-subscription-check';

/** Job name of the starter-question sync on `instagram-tasks` (WC-31, IA6). */
export const INSTAGRAM_STARTER_QUESTION_SYNC_JOB_NAME = 'instagram-starter-question-sync';

/**
 * The minutes a failed set-up or starter-question sync waits before its next try (WC-30, WC-31):
 * 1, 5, 15, then 60; after the last one, a try every {@link INSTAGRAM_ACCOUNT_TASK_HOURLY_RETRY_MINUTES}.
 *
 * @remarks
 * Rationale: the plan's retry ladder (plan:L4627–L4646, `META_TASK_RETRY_MINUTES`) — quick tries for a
 * one-off Meta hiccup, then hourly so an account whose set-up Meta keeps refusing is never left alone.
 *
 * Consequences of change:
 * - Shorter steps → more Meta calls against an account Meta refuses.
 * - Longer steps → an account stays unsubscribed (missing webhooks) longer after a hiccup.
 */
export const INSTAGRAM_ACCOUNT_TASK_RETRY_MINUTES: readonly number[] = [1, 5, 15, 60];

/**
 * The wait between tries once {@link INSTAGRAM_ACCOUNT_TASK_RETRY_MINUTES} is spent (WC-30 "once an
 * hour after that").
 *
 * @remarks
 * Rationale: the plan's hourly task retry (§34 rule 26). Consequences of change: shorter → more calls
 * to a refusing Meta; longer → a fixed account is found later.
 */
export const INSTAGRAM_ACCOUNT_TASK_HOURLY_RETRY_MINUTES = 60;

/**
 * How often each connected account's webhook subscription is checked (WC-25, `WEBHOOK_CHECK_MINUTES`).
 *
 * @remarks
 * Rationale: plan §34 rule 18 — a lost field costs at most this long of missed events (the
 * missed-comment look, WC-26, covers the comments). Consequences of change: shorter → more Meta
 * reads per account; longer → longer blind spots. The sweep's cron (`scheduler.ts`) must match.
 */
export const INSTAGRAM_WEBHOOK_SUBSCRIPTION_CHECK_MINUTES = 10;

/** Connected accounts one subscription sweep page reads (one short retention read per page, the adds after it). */
export const INSTAGRAM_WEBHOOK_SUBSCRIPTION_SWEEP_PAGE_SIZE = 500;

/**
 * Most pages one subscription sweep reads — 100 000 connected accounts, the bound that keeps one
 * sweep run finite.
 *
 * @remarks
 * Rationale: the launch daily check's bound, kept when that check was retired (R40 × R51 merge).
 * Consequences of change: an estate past it logs `…webhook_subscription_check.sweep_capped` at
 * error and the accounts past the cap wait for a raised cap (or page size).
 */
export const INSTAGRAM_WEBHOOK_SUBSCRIPTION_SWEEP_MAX_PAGES = 200;

/** Input of the set-up and the starter-question sync: the account, its chain of tries and the try. */
export const instagramAccountChainTaskInputSchema = z.object({
  channelAccountPublicId: z.string().min(1).max(28),
  /** The first try's job id; every later try is `<chainKey>-try-<n>`. */
  chainKey: z.string().min(1).max(64),
  /** 0 for the first try, then 1, 2, … (the index into the retry ladder). */
  tryNumber: z.number().int().min(0),
});

/** Validated input of {@link instagramAccountChainTaskInputSchema}. */
export type InstagramAccountChainTaskInput = z.infer<typeof instagramAccountChainTaskInputSchema>;

/** Input of one account's webhook subscription check. */
export const instagramWebhookSubscriptionCheckInputSchema = z.object({
  channelAccountPublicId: z.string().min(1).max(28),
});

/** Validated input of {@link instagramWebhookSubscriptionCheckInputSchema}. */
export type InstagramWebhookSubscriptionCheckInput = z.infer<
  typeof instagramWebhookSubscriptionCheckInputSchema
>;

/** The two account jobs that retry along the ladder. */
export type InstagramAccountChainJobName =
  | typeof INSTAGRAM_ACCOUNT_SETUP_JOB_NAME
  | typeof INSTAGRAM_STARTER_QUESTION_SYNC_JOB_NAME;

/**
 * The wait before the try after `failedTryNumber` failed: the ladder's step, then hourly.
 *
 * @remarks
 * - **Algorithm:** {@link INSTAGRAM_ACCOUNT_TASK_RETRY_MINUTES}`[failedTryNumber]`, else
 *   {@link INSTAGRAM_ACCOUNT_TASK_HOURLY_RETRY_MINUTES}, in milliseconds.
 * - **Failure modes:** none — pure.
 * - **Side effects:** none.
 */
export function instagramAccountTaskRetryDelayMilliseconds(failedTryNumber: number): number {
  const minutes =
    INSTAGRAM_ACCOUNT_TASK_RETRY_MINUTES[failedTryNumber] ??
    INSTAGRAM_ACCOUNT_TASK_HOURLY_RETRY_MINUTES;
  return minutes * MILLISECONDS_PER_MINUTE;
}

/**
 * Adds one try of the set-up or the starter-question sync (WC-30, WC-31) on `instagram-tasks`.
 *
 * @remarks
 * - **Algorithm:** job id `<chainKey>-try-<tryNumber>`, so one chain never holds the same try twice
 *   (a stalled job's re-run adds nothing new); `delayMilliseconds` for a retry.
 * - **Failure modes:** propagates BullMQ / Redis errors.
 * - **Side effects:** at most one job.
 */
export async function enqueueInstagramAccountChainTask({
  jobName,
  organizationPublicId,
  input,
  delayMilliseconds,
}: {
  jobName: InstagramAccountChainJobName;
  organizationPublicId: string;
  input: InstagramAccountChainTaskInput;
  delayMilliseconds?: number;
}): Promise<void> {
  await enqueueInstagramTask({
    jobName,
    jobId: `${input.chainKey}-try-${input.tryNumber}`,
    organizationPublicId,
    taskInput: { ...input },
    ...(delayMilliseconds === undefined ? {} : { delayMilliseconds }),
  });
}

/**
 * Starts a new chain of the set-up or the sync for one account: its first try, at once (or after
 * `delayMilliseconds`). Never throws — a failed add is logged
 * (`app.instagram_account.task_enqueue_failed`); the account then shows as not subscribed (or its
 * starter questions as not set) and the next owner action or check adds it again.
 *
 * @remarks
 * - **Algorithm:** chain key `<setup|starters>-<cha_…>-<now ms>`, try 0.
 * - **Failure modes:** none — logged.
 * - **Side effects:** at most one job on `instagram-tasks`.
 */
export async function startInstagramAccountChainBestEffort({
  jobName,
  organizationPublicId,
  channelAccountPublicId,
  delayMilliseconds,
}: {
  jobName: InstagramAccountChainJobName;
  organizationPublicId: string;
  channelAccountPublicId: string;
  delayMilliseconds?: number;
}): Promise<void> {
  const prefix = jobName === INSTAGRAM_ACCOUNT_SETUP_JOB_NAME ? 'setup' : 'starters';
  try {
    await enqueueInstagramAccountChainTask({
      jobName,
      organizationPublicId,
      input: {
        channelAccountPublicId,
        chainKey: `${prefix}-${channelAccountPublicId}-${Date.now()}`,
        tryNumber: 0,
      },
      ...(delayMilliseconds === undefined ? {} : { delayMilliseconds }),
    });
  } catch (error) {
    logger.warn(
      { error, jobName, organizationPublicId, channelAccountPublicId },
      'app.instagram_account.task_enqueue_failed',
    );
  }
}

/** One connected account the 10-minute sweep hands a subscription check to. */
export interface InstagramWebhookSubscriptionCheckTarget {
  /** `app.instagram_accounts.id` — it decides the account's second inside the window. */
  id: number;
  organizationPublicId: string;
  channelAccountPublicId: string;
}

/**
 * The delay that spreads an account's check over the window, by its id (WC-25: "spread by account").
 *
 * @remarks
 * - **Algorithm:** `id mod (window seconds)` seconds, so each account keeps its own second.
 * - **Failure modes:** none — pure.
 * - **Side effects:** none.
 */
export function instagramWebhookSubscriptionCheckDelayMilliseconds(id: number): number {
  const windowSeconds =
    (INSTAGRAM_WEBHOOK_SUBSCRIPTION_CHECK_MINUTES * MILLISECONDS_PER_MINUTE) /
    MILLISECONDS_PER_SECOND;
  return (id % windowSeconds) * MILLISECONDS_PER_SECOND;
}

/**
 * Adds one subscription check per account for the window starting at `windowStart` (WC-25); returns
 * how many adds were sent.
 *
 * @remarks
 * - **Algorithm:** job id `subscription-check-<cha_…>-<window start ms>` — a second sweep in the same
 *   window adds nothing (BullMQ keeps the id); each delayed by
 *   {@link instagramWebhookSubscriptionCheckDelayMilliseconds}.
 * - **Failure modes:** propagates the first failed add — the sweep logs it and the next window adds
 *   the accounts again.
 * - **Side effects:** at most one job per account per window.
 */
export async function enqueueInstagramWebhookSubscriptionChecks({
  targets,
  windowStart,
}: {
  targets: readonly InstagramWebhookSubscriptionCheckTarget[];
  windowStart: Date;
}): Promise<number> {
  for (const target of targets) {
    await enqueueInstagramTask({
      jobName: INSTAGRAM_WEBHOOK_SUBSCRIPTION_CHECK_JOB_NAME,
      jobId: `subscription-check-${target.channelAccountPublicId}-${windowStart.getTime()}`,
      organizationPublicId: target.organizationPublicId,
      taskInput: { channelAccountPublicId: target.channelAccountPublicId },
      delayMilliseconds: instagramWebhookSubscriptionCheckDelayMilliseconds(target.id),
    });
  }
  return targets.length;
}
