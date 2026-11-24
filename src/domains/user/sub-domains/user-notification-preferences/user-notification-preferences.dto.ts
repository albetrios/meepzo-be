import { z } from 'zod';
import {
  NOTIFICATION_KIND_NAMES,
  NOTIFICATION_KINDS,
  NOTIFICATION_PREFERENCE_CHANNELS,
} from '@/shared/constants/index.js';

/** Most items one save carries: every kind × every channel (7 × 3). */
export const NOTIFICATION_PREFERENCE_ITEMS_MAX =
  NOTIFICATION_KINDS.length * NOTIFICATION_PREFERENCE_CHANNELS.length;

/**
 * Zod schema for the `PUT /api/v1/users/me/notification-preferences` request body
 * (feat-instagram-dm-sending UN10, route 136, P87).
 *
 * @remarks
 * The body speaks kinds: 1–21 `{ kind, channel, is_enabled }` items, no kind × channel twice.
 * Only the items sent change — the screen saves each switch as it is flipped. `SMS` is not a
 * channel here. An unknown kind or channel, an empty list, over 21 items or a repeat is a `400`.
 */
export const PutNotificationPreferencesDto = z
  .object({
    kinds: z
      .array(
        z
          .object({
            kind: z.enum(NOTIFICATION_KIND_NAMES),
            channel: z.enum(NOTIFICATION_PREFERENCE_CHANNELS),
            is_enabled: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(NOTIFICATION_PREFERENCE_ITEMS_MAX)
      .superRefine((items, context) => {
        const seen = new Set<string>();
        for (const item of items) {
          const key = `${item.kind} ${item.channel}`;
          if (seen.has(key)) {
            context.addIssue({
              code: 'custom',
              message: `Repeated kind and channel: ${item.kind} ${item.channel}`,
            });
            return;
          }
          seen.add(key);
        }
      }),
  })
  .strict();

/** Inferred body type from {@link PutNotificationPreferencesDto}. */
export type PutNotificationPreferencesInput = z.infer<typeof PutNotificationPreferencesDto>;
