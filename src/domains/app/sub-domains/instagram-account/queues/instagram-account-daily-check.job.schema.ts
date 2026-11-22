import { z } from 'zod';
import { traceContextJobFieldsSchema } from '@/infrastructure/observability/tracing/trace-context-job-fields.schema.js';
import { dlqReplayJobFieldsSchema } from '@/infrastructure/queue/dlq/dlq-replay-job-fields.schema.js';

/**
 * Redis payload of one daily account check (IA8, IAC8): the organization whose scope the worker
 * opens (`organizationPublicId`, K8) and its connected account — public ids only, never a
 * bigserial. The worker re-reads the account and its token; nothing about them rides in the job.
 * Merges the trace-context fields and the dead-letter replay metadata.
 */
export const instagramAccountDailyCheckJobDataSchema = z
  .object({
    organizationPublicId: z.string().min(1).max(28),
    instagramAccountPublicId: z.string().min(1).max(28),
  })
  .extend(traceContextJobFieldsSchema.shape)
  .extend(dlqReplayJobFieldsSchema.shape);

/** Type inferred from {@link instagramAccountDailyCheckJobDataSchema}. */
export type InstagramAccountDailyCheckJobDataValidated = z.infer<
  typeof instagramAccountDailyCheckJobDataSchema
>;
