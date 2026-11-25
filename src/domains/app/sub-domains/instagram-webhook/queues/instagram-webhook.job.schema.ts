import { z } from 'zod';
import { traceContextJobFieldsSchema } from '@/infrastructure/observability/tracing/trace-context-job-fields.schema.js';
import { dlqReplayJobFieldsSchema } from '@/infrastructure/queue/dlq/dlq-replay-job-fields.schema.js';
import { CONTACT_TAG_EVENT_INTAKE_CONTACTS_PER_JOB } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.constants.js';
import { INSTAGRAM_WEBHOOK_EVENT_INTAKE_GROUPS } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.constants.js';

/**
 * Redis payload of one intake job of a kind group (feat-instagram-dm-sending § 5 WH5, WHC4): the
 * organization whose job scope the worker opens (`organizationPublicId`, K8), the channel account
 * (`cha_…`) whose waiting events of `intakeKind` (`messages` · `live` · `comments`) it works
 * through, and the request id of the delivery (or pick-up) that added it — public ids only, never a
 * bigserial. The events themselves are read from Postgres, so Redis never holds their order or
 * their content. Merges the trace-context fields and the dead-letter replay metadata.
 */
export const instagramWebhookIntakeJobDataSchema = z
  .object({
    organizationPublicId: z.string().min(1).max(28),
    channelAccountPublicId: z.string().min(1).max(28),
    intakeKind: z.enum(INSTAGRAM_WEBHOOK_EVENT_INTAKE_GROUPS),
    requestId: z.string().min(1).max(128).optional(),
  })
  .extend(traceContextJobFieldsSchema.shape)
  .extend(dlqReplayJobFieldsSchema.shape);

/** Type inferred from {@link instagramWebhookIntakeJobDataSchema}. */
export type InstagramWebhookIntakeJobDataValidated = z.infer<
  typeof instagramWebhookIntakeJobDataSchema
>;

/**
 * Redis payload of one tag-intake job (WH15, WC-4, scale review S20): the organization and 1 to
 * {@link CONTACT_TAG_EVENT_INTAKE_CONTACTS_PER_JOB} contacts (`con_…`) whose undone tag events the
 * job works, oldest first — a tag event has no public id, so the job names the contacts and reads
 * their rows from Postgres.
 */
export const instagramTagEventIntakeJobDataSchema = z
  .object({
    organizationPublicId: z.string().min(1).max(28),
    contactPublicIds: z
      .array(z.string().min(1).max(28))
      .min(1)
      .max(CONTACT_TAG_EVENT_INTAKE_CONTACTS_PER_JOB),
    requestId: z.string().min(1).max(128).optional(),
  })
  .extend(traceContextJobFieldsSchema.shape)
  .extend(dlqReplayJobFieldsSchema.shape);

/** Type inferred from {@link instagramTagEventIntakeJobDataSchema}. */
export type InstagramTagEventIntakeJobDataValidated = z.infer<
  typeof instagramTagEventIntakeJobDataSchema
>;
