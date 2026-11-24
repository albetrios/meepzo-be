import { z } from 'zod';
import { traceContextJobFieldsSchema } from '@/infrastructure/observability/tracing/trace-context-job-fields.schema.js';
import { dlqReplayJobFieldsSchema } from '@/infrastructure/queue/dlq/dlq-replay-job-fields.schema.js';

/**
 * Redis payload of one reconnect notice (IA9, IAC9): the organization whose scope the worker
 * opens (`organizationPublicId`, K8), the broken account, and the break itself — the status it
 * moved to and when (the channel account's `updated_at` at the break, ISO 8601 — R6), which names this break among the
 * account's breaks. Public ids only; the worker re-reads the account and finds the recipients.
 * Merges the trace-context fields and the dead-letter replay metadata.
 */
export const instagramReconnectNoticeJobDataSchema = z
  .object({
    organizationPublicId: z.string().min(1).max(28),
    instagramAccountPublicId: z.string().min(1).max(28),
    connectionStatus: z.enum(['expired', 'error']),
    connectionStatusChangedAt: z.iso.datetime(),
    requestId: z.string().min(1).max(128).optional(),
  })
  .extend(traceContextJobFieldsSchema.shape)
  .extend(dlqReplayJobFieldsSchema.shape);

/** Type inferred from {@link instagramReconnectNoticeJobDataSchema}. */
export type InstagramReconnectNoticeJobDataValidated = z.infer<
  typeof instagramReconnectNoticeJobDataSchema
>;
