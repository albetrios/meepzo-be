import { z } from 'zod';
import { traceContextJobFieldsSchema } from '@/infrastructure/observability/tracing/trace-context-job-fields.schema.js';
import { dlqReplayJobFieldsSchema } from '@/infrastructure/queue/dlq/dlq-replay-job-fields.schema.js';

/**
 * Redis payload of one organization's weekly summary (feat-instagram-dm-sending UN12, UNC9): the
 * organization whose scope the worker opens and its Monday (`YYYY-MM-DD` in its time zone), which
 * names the week. Public ids only.
 */
export const notificationWeeklySummaryJobDataSchema = z
  .object({
    organizationPublicId: z.string().min(1).max(28),
    weekStart: z.iso.date(),
  })
  .extend(traceContextJobFieldsSchema.shape)
  .extend(dlqReplayJobFieldsSchema.shape);

/** Type inferred from {@link notificationWeeklySummaryJobDataSchema}. */
export type NotificationWeeklySummaryJobData = z.infer<
  typeof notificationWeeklySummaryJobDataSchema
>;
