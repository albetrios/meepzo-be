import type { AutomationTriggerType } from '@/domains/app/sub-domains/automation/automation.constants.js';

/**
 * Every value of `app.automation_backfills.status` (feat-instagram-dm-sending routes-final § 4.C.3,
 * AU31, AU32): `queued` (saved by route 38, waiting for the account's one read), `reading` (the read
 * job runs — ROUTE row R41), `done`, `failed`. Mirrors `chk_automation_backfills_status`.
 */
export const AUTOMATION_BACKFILL_STATUSES = ['queued', 'reading', 'done', 'failed'] as const;

/** One value of {@link AUTOMATION_BACKFILL_STATUSES}. */
export type AutomationBackfillStatus = (typeof AUTOMATION_BACKFILL_STATUSES)[number];

/**
 * The open statuses — at most one per automation (`idx_automation_backfills_open`, AU31), and the
 * read's watch (`idx_automation_backfills_watch`, AU32).
 */
export const AUTOMATION_BACKFILL_OPEN_STATUSES = [
  'queued',
  'reading',
] as const satisfies readonly AutomationBackfillStatus[];

/**
 * Why a read ended `failed` (4.C.3, AU32): `meta_error` (Meta kept failing after the retries) or
 * `plan_feature_off` (a move down turned the plan's `past_comments` switch off). Set exactly when
 * `failed` (`chk_automation_backfills_fail_reason`).
 */
export const AUTOMATION_BACKFILL_FAIL_REASONS = ['meta_error', 'plan_feature_off'] as const;

/** One value of {@link AUTOMATION_BACKFILL_FAIL_REASONS}. */
export type AutomationBackfillFailReason = (typeof AUTOMATION_BACKFILL_FAIL_REASONS)[number];

/** The fewest days back a read covers (AU31, D69). */
export const PAST_COMMENTS_MIN_DAYS = 1;

/** The most days back a read covers (AU31, D69 — plan's `PAST_COMMENTS_MAX_DAYS`). */
export const PAST_COMMENTS_MAX_DAYS = 7;

/**
 * The ways to start whose past comments can be read (AU31): a comment or an ad comment — never a
 * Live comment (a Live ends; its comments cannot be read back).
 */
export const AUTOMATION_BACKFILL_TRIGGER_TYPES: readonly AutomationTriggerType[] = [
  'comment',
  'ad_comment',
];

/** The longest `last_error` the read job keeps — codes only, never Meta's text (4.C.3). */
export const AUTOMATION_BACKFILL_LAST_ERROR_MAX_LENGTH = 500;

/** The audit resource type of a past-comments start (AU7, K9). */
export const AUTOMATION_BACKFILL_AUDIT_RESOURCE_TYPE = 'automation_backfill';

/**
 * The most posts one "any post" read covers (AU32 — plan's `PAST_COMMENTS_POSTS_MAX`): the newest
 * posts with comments.
 */
export const PAST_COMMENTS_POSTS_MAX = 50;

/**
 * A `reading` read whose last page is older than this is started again by the watch (AU32, WC-41):
 * 30 minutes without a new page.
 */
export const AUTOMATION_BACKFILL_STUCK_READ_MINUTES = 30;

/**
 * A `queued` read older than this with no read of its account running is woken by the watch — its
 * job was lost (Redis) or never added (AU32).
 */
export const AUTOMATION_BACKFILL_STUCK_QUEUED_MINUTES = 10;

/** How often the watch runs (AU32): every 10 minutes. */
export const AUTOMATION_BACKFILL_WATCH_MINUTES = 10;

/** The most open reads one watch round wakes — the rest wait for the next round. */
export const AUTOMATION_BACKFILL_WATCH_LIMIT = 500;

/**
 * The waits before Meta is tried again on a read (AU32 — `META_TASK_RETRY_MINUTES`): 1, 5, 15 and
 * 60 minutes; after the last the read ends `failed` · `meta_error`.
 */
export const META_TASK_RETRY_MINUTES: readonly number[] = [1, 5, 15, 60];

/**
 * The newest comment age a read saves (AC-8.5): 7 days minus 30 minutes — a private reply to an
 * older comment could not go before the window closes, so it is never sent.
 */
export const PAST_COMMENTS_MAX_AGE_MINUTES = 7 * 24 * 60 - 30;
