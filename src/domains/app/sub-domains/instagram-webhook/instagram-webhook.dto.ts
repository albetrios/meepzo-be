import { z } from 'zod';
import { INSTAGRAM_WEBHOOK_CHALLENGE_MAX_LENGTH } from '@/shared/constants/instagram.constants.js';

/**
 * Query of `GET /app/social/channel-connections/meta/webhooks/instagram` (route 60, Meta's subscription check — 5.A.8):
 * `hub.mode`, `hub.verify_token` and `hub.challenge` (1–256 characters, no spaces), each required.
 *
 * @remarks
 * Meta's own parameter names pass through as received (the third-party exception of the
 * body-key rule), and other parameters Meta adds are ignored — not strict, unlike the signed-in
 * lists. A missing part or a challenge too long is a `400 invalid_field`; the mode and the token
 * are compared by the service (`400 invalid_webhook_verify_token`, WH7), never here.
 */
export const InstagramWebhookSubscriptionQueryDto = z.object({
  'hub.mode': z.string().min(1),
  'hub.verify_token': z.string().min(1),
  'hub.challenge': z.string().min(1).max(INSTAGRAM_WEBHOOK_CHALLENGE_MAX_LENGTH).regex(/^\S+$/),
});

/** The parsed query of {@link InstagramWebhookSubscriptionQueryDto}. */
export type InstagramWebhookSubscriptionQuery = z.infer<
  typeof InstagramWebhookSubscriptionQueryDto
>;

/**
 * One `entry[]` item of a Meta delivery (schema-routes §5.6): the account's webhook user id, Meta's
 * time, and its `changes[]` and `messaging[]` items. Unknown Meta fields are kept.
 *
 * @remarks
 * Lenient on purpose: an entry whose `id` is missing or not digits — or that does not parse at all
 * (`changes` / `messaging` not a list) — is dropped by the receiver with a log line (WH9), not
 * refused; the other entries of the same delivery are still stored. `id` and `time` are read by the
 * classifier's helpers (digits; Unix seconds or milliseconds), the items stay `unknown` here and the
 * classifier reads each one (WH9).
 */
export const InstagramWebhookEntryDto = z.looseObject({
  id: z.unknown().optional(),
  time: z.unknown().optional(),
  changes: z.array(z.unknown()).optional(),
  messaging: z.array(z.unknown()).optional(),
});

/** The parsed {@link InstagramWebhookEntryDto}. */
export type InstagramWebhookEntry = z.infer<typeof InstagramWebhookEntryDto>;

/**
 * Body of `POST /app/social/channel-connections/meta/webhooks/instagram` (route 61) as Meta sends it (schema-routes §5.6):
 * `object` and `entry[]`. Parsed only after `X-Hub-Signature-256` passed (WH8) — never as the
 * route's `schema.body`, which Fastify would run before the signature check.
 *
 * @remarks
 * A body that does not match (no `object`, `entry` not a list) is treated like an unreadable one:
 * `200 OK`, a warning log, nothing stored (WH10). Unknown Meta fields are kept.
 */
export const InstagramWebhookDeliveryDto = z.looseObject({
  object: z.string(),
  entry: z.array(z.unknown()),
});

/** The parsed {@link InstagramWebhookDeliveryDto}. */
export type InstagramWebhookDelivery = z.infer<typeof InstagramWebhookDeliveryDto>;
