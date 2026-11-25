import { z } from 'zod';
import { traceContextJobFieldsSchema } from '@/infrastructure/observability/tracing/trace-context-job-fields.schema.js';
import { dlqReplayJobFieldsSchema } from '@/infrastructure/queue/dlq/dlq-replay-job-fields.schema.js';
import { INSTAGRAM_SLOW_QUEUE_LANES } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';

/**
 * Redis payload of one lane turn on `instagram-send-slow` (SN2, plan §24.4): the organization whose
 * job scope the worker opens (`organizationPublicId`, K8), the channel account (`cha_…`), the lane
 * (`slow`, `reply` or `broadcast`) and the turn number the ticket is for — ids only. The messages,
 * their text and the person are read from Postgres at the last moment.
 */
export const instagramSendSlowJobDataSchema = z
  .object({
    organizationPublicId: z.string().min(1).max(28),
    channelAccountPublicId: z.string().min(1).max(28),
    lane: z.enum(INSTAGRAM_SLOW_QUEUE_LANES),
    turnNumber: z.number().int().min(0),
  })
  .extend(traceContextJobFieldsSchema.shape)
  .extend(dlqReplayJobFieldsSchema.shape);

/** Type inferred from {@link instagramSendSlowJobDataSchema}. */
export type InstagramSendSlowJobData = z.infer<typeof instagramSendSlowJobDataSchema>;
