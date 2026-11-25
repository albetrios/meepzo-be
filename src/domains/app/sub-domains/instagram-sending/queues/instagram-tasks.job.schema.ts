import { z } from 'zod';
import { traceContextJobFieldsSchema } from '@/infrastructure/observability/tracing/trace-context-job-fields.schema.js';
import { dlqReplayJobFieldsSchema } from '@/infrastructure/queue/dlq/dlq-replay-job-fields.schema.js';

/**
 * One value of a task's input: a public id, a number, a flag or nothing — ids, never documents (plan
 * §24.4).
 */
const instagramTaskInputValueSchema = z.union([
  z.string().max(64),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * Redis payload of one task on `instagram-tasks` (SN2): the organization (`organizationPublicId`, K8)
 * and the task's own input — a flat record of ids, which the task's handler validates with its own
 * schema (the job name says which handler). The owners register their job names (file upload and
 * retry-failed here, account set-up and starter questions by the account, segment count and
 * broadcast audience by 7, past comments by the automation).
 */
export const instagramTaskJobDataSchema = z
  .object({
    organizationPublicId: z.string().min(1).max(28),
    taskInput: z.record(z.string().max(64), instagramTaskInputValueSchema),
  })
  .extend(traceContextJobFieldsSchema.shape)
  .extend(dlqReplayJobFieldsSchema.shape);

/** Type inferred from {@link instagramTaskJobDataSchema}. */
export type InstagramTaskJobData = z.infer<typeof instagramTaskJobDataSchema>;
