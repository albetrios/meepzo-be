import { z } from 'zod';
import { traceContextJobFieldsSchema } from '@/infrastructure/observability/tracing/trace-context-job-fields.schema.js';
import { dlqReplayJobFieldsSchema } from '@/infrastructure/queue/dlq/dlq-replay-job-fields.schema.js';

/**
 * Redis payload of one database-heavy task on `instagram-database-tasks` (scale review S19, P97):
 * the organization (`organizationPublicId`, K8) and the task's own input, which its handler
 * validates with its own strict schema (the job name says which handler).
 *
 * @remarks
 * Unlike the Meta-calling queue's flat record of ids, a value here may be a list or an object: a
 * bulk change names up to 500 contact public ids or the list's filters, a segment count carries
 * the conditions it counts (P217). Public ids and filters only — never a message's text or a
 * person's data; the handler's schema bounds each.
 */
export const instagramDatabaseTaskJobDataSchema = z
  .object({
    organizationPublicId: z.string().min(1).max(28),
    taskInput: z.record(z.string().max(64), z.unknown()),
  })
  .extend(traceContextJobFieldsSchema.shape)
  .extend(dlqReplayJobFieldsSchema.shape);

/** Type inferred from {@link instagramDatabaseTaskJobDataSchema}. */
export type InstagramDatabaseTaskJobData = z.infer<typeof instagramDatabaseTaskJobDataSchema>;
