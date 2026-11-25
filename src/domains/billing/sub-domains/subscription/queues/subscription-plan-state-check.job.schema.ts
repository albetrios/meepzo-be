import { z } from 'zod';
import { traceContextJobFieldsSchema } from '@/infrastructure/observability/tracing/trace-context-job-fields.schema.js';
import { dlqReplayJobFieldsSchema } from '@/infrastructure/queue/dlq/dlq-replay-job-fields.schema.js';

/**
 * Redis payload of one subscription's plan-state check (routes-final § 8.B BL17, BLC10 — WC-59): the
 * organization whose scope the worker opens (`organizationPublicId`, K8) and the subscription —
 * public ids only. The job re-reads the row inside the organization and decides there. Merges the
 * trace-context fields and the dead-letter replay metadata.
 */
export const subscriptionPlanStateCheckJobDataSchema = z
  .object({
    organizationPublicId: z.string().min(1).max(28),
    subscriptionPublicId: z.string().min(1).max(28),
  })
  .extend(traceContextJobFieldsSchema.shape)
  .extend(dlqReplayJobFieldsSchema.shape);

/** Type inferred from {@link subscriptionPlanStateCheckJobDataSchema}. */
export type SubscriptionPlanStateCheckJobData = z.infer<
  typeof subscriptionPlanStateCheckJobDataSchema
>;
