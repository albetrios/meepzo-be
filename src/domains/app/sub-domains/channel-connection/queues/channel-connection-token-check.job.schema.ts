import { z } from 'zod';
import { traceContextJobFieldsSchema } from '@/infrastructure/observability/tracing/trace-context-job-fields.schema.js';
import { dlqReplayJobFieldsSchema } from '@/infrastructure/queue/dlq/dlq-replay-job-fields.schema.js';

/**
 * Redis payload of one connection's daily token check (routes-final § 1 MC10, MCC6): the
 * organization whose scope the worker opens (`organizationPublicId`, K8) and the channel connection
 * — public ids only, never a bigserial or a token. The worker re-reads the connection, its token and
 * its accounts. Merges the trace-context fields and the dead-letter replay metadata.
 */
export const channelConnectionTokenCheckJobDataSchema = z
  .object({
    organizationPublicId: z.string().min(1).max(28),
    channelConnectionPublicId: z.string().min(1).max(28),
  })
  .extend(traceContextJobFieldsSchema.shape)
  .extend(dlqReplayJobFieldsSchema.shape);

/** Type inferred from {@link channelConnectionTokenCheckJobDataSchema}. */
export type ChannelConnectionTokenCheckJobDataValidated = z.infer<
  typeof channelConnectionTokenCheckJobDataSchema
>;
