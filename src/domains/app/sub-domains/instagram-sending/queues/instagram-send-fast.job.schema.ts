import { z } from 'zod';
import { traceContextJobFieldsSchema } from '@/infrastructure/observability/tracing/trace-context-job-fields.schema.js';
import { dlqReplayJobFieldsSchema } from '@/infrastructure/queue/dlq/dlq-replay-job-fields.schema.js';
import { instantSchema } from '@/shared/utils/validation/record-fields.util.js';

/**
 * Redis payload of one fast message on `instagram-send-fast` (SN2, plan §24.4): the organization
 * (`organizationPublicId`, K8), the channel account (`cha_…`), the message (`igm_…`), its run's start
 * time (the message table's split key, SNC13) and the try it is for — ids only; text and person are
 * read from Postgres at the last moment.
 */
export const instagramSendFastJobDataSchema = z
  .object({
    organizationPublicId: z.string().min(1).max(28),
    channelAccountPublicId: z.string().min(1).max(28),
    instagramMessagePublicId: z.string().min(1).max(28),
    automationRunStartedAt: instantSchema,
    tries: z.number().int().min(0),
  })
  .extend(traceContextJobFieldsSchema.shape)
  .extend(dlqReplayJobFieldsSchema.shape);

/** Type inferred from {@link instagramSendFastJobDataSchema}. */
export type InstagramSendFastJobData = z.infer<typeof instagramSendFastJobDataSchema>;
