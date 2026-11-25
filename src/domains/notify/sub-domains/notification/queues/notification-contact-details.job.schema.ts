import { z } from 'zod';
import { traceContextJobFieldsSchema } from '@/infrastructure/observability/tracing/trace-context-job-fields.schema.js';
import { dlqReplayJobFieldsSchema } from '@/infrastructure/queue/dlq/dlq-replay-job-fields.schema.js';

/**
 * Redis payload of one grouped "new contact details" note (feat-instagram-dm-sending UN13, UNC10):
 * the organization whose scope the worker opens, the channel account and the window's start (the
 * first detail's time, ISO 8601). Public ids only — Postgres holds the contacts' times.
 */
export const notificationContactDetailsJobDataSchema = z
  .object({
    organizationPublicId: z.string().min(1).max(28),
    channelAccountPublicId: z.string().min(1).max(28),
    windowStartedAt: z.iso.datetime(),
  })
  .extend(traceContextJobFieldsSchema.shape)
  .extend(dlqReplayJobFieldsSchema.shape);

/** Type inferred from {@link notificationContactDetailsJobDataSchema}. */
export type NotificationContactDetailsJobData = z.infer<
  typeof notificationContactDetailsJobDataSchema
>;
