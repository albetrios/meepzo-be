import { z } from 'zod';
import { traceContextJobFieldsSchema } from '@/infrastructure/observability/tracing/trace-context-job-fields.schema.js';
import { dlqReplayJobFieldsSchema } from '@/infrastructure/queue/dlq/dlq-replay-job-fields.schema.js';

/**
 * Redis payload of one account's event-processing job (WH5, WHC4): the organization whose job
 * scope the worker opens (`organizationPublicId`, K8), the channel account (`cha_…`) whose waiting
 * events it works through, and the request id of the delivery (or pick-up) that added it — public ids
 * only, never a bigserial. The events themselves are read from Postgres, oldest first, so Redis
 * never holds their order or their content. Merges the trace-context fields and the dead-letter
 * replay metadata.
 */
export const instagramWebhookAccountJobDataSchema = z
  .object({
    organizationPublicId: z.string().min(1).max(28),
    channelAccountPublicId: z.string().min(1).max(28),
    requestId: z.string().min(1).max(128).optional(),
  })
  .extend(traceContextJobFieldsSchema.shape)
  .extend(dlqReplayJobFieldsSchema.shape);

/** Type inferred from {@link instagramWebhookAccountJobDataSchema}. */
export type InstagramWebhookAccountJobDataValidated = z.infer<
  typeof instagramWebhookAccountJobDataSchema
>;
