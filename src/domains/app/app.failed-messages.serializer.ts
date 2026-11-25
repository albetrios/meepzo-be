import type {
  ChannelFailedMessageBlock,
  ChannelFailedMessagesRetry,
  ChannelFailedMessagesSummary,
} from './app.channel-ports.js';

/** The audit action of one press of "Retry failed messages" (SN18, routes 26 and 37). */
export const FAILED_MESSAGES_RETRY_AUDIT_ACTION = 'app.instagram_message.retry';

/** The Failed messages summary object (feat-instagram-dm-sending routes-final § 3.A.6 — routes 25, 36). */
export interface FailedMessagesSummaryOutput {
  failed_count: number;
  retryable_count: number;
  not_retryable: Record<ChannelFailedMessageBlock, number>;
  horizon_days: number;
}

/** The Failed messages retry object (§ 3.A.6 — routes 26, 37). */
export interface FailedMessagesRetryOutput {
  expected_retry_count: number;
  is_queued: boolean;
}

/**
 * Shapes a channel's failed-message summary for routes 25 and 36 (shared by contacts and
 * automations, M6): counts only, never a message.
 */
export function serializeFailedMessagesSummary(
  summary: ChannelFailedMessagesSummary,
): FailedMessagesSummaryOutput {
  return {
    failed_count: summary.failedCount,
    retryable_count: summary.retryableCount,
    not_retryable: { ...summary.notRetryable },
    horizon_days: summary.horizonDays,
  };
}

/** Shapes one retry press for routes 26 and 37: how many go again and whether a job does it. */
export function serializeFailedMessagesRetry(
  retry: ChannelFailedMessagesRetry,
): FailedMessagesRetryOutput {
  return { expected_retry_count: retry.expectedRetryCount, is_queued: retry.isQueued };
}

/** The retry's audit metadata (SN18 `app.instagram_message.retry`): counts only. */
export function failedMessagesRetryAuditMetadata(
  retry: ChannelFailedMessagesRetry,
): Record<string, unknown> {
  return {
    failed_count: retry.summary.failedCount,
    retried_count: retry.expectedRetryCount,
    not_retryable: { ...retry.summary.notRetryable },
    is_queued: retry.isQueued,
  };
}
