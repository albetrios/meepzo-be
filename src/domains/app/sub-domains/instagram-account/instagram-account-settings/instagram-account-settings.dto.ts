import { z } from 'zod';
import { expectedUpdatedAtSchema } from '@/shared/utils/validation/record-fields.util.js';

/** Public reply chance, in percent (routes-final § 1.B.3). */
const PUBLIC_REPLY_CHANCE_PERCENT_RANGE = { min: 0, max: 100 } as const;
/** Public replies an hour (routes-final § 1.B.3). */
const PUBLIC_REPLY_HOUR_LIMIT_RANGE = { min: 1, max: 1000 } as const;
/** Each gap between public replies, in seconds (routes-final § 1.B.3). */
const PUBLIC_REPLY_GAP_SECONDS_RANGE = { min: 5, max: 3600 } as const;

/** A whole number within `range`, optional — one setting a `PATCH` may leave out. */
function wholeNumberInRange(range: { min: number; max: number }) {
  return z.number().int().min(range.min).max(range.max).optional();
}

/**
 * Body of `PATCH /app/social/instagram/account/settings` (route 3, routes-final § 1.B.8, IA15):
 * any of the six settings, at least one, and an optional `expected_updated_at`.
 *
 * @remarks
 * Ranges as the table's checks hold them: `public_reply_chance_percent` 0–100,
 * `public_reply_hour_limit` 1–1000, each gap 5–3600 seconds — whole numbers only. Strict: an
 * unknown field is a `400`, and so is a body with no setting (`expected_updated_at` alone is not a
 * change). The minimum gap never above the maximum is checked on the merged result, against the
 * saved row (`assertPublicReplyGapOrder`), not here — a body may send one end only.
 * `expected_updated_at` is the settings' `updated_at` as the client read it; an older one is
 * refused with `409 record_changed` (D43).
 */
export const UpdateInstagramAccountSettingsDto = z
  .object({
    is_automation_enabled: z.boolean().optional(),
    is_public_reply_safety_enabled: z.boolean().optional(),
    public_reply_chance_percent: wholeNumberInRange(PUBLIC_REPLY_CHANCE_PERCENT_RANGE),
    public_reply_hour_limit: wholeNumberInRange(PUBLIC_REPLY_HOUR_LIMIT_RANGE),
    public_reply_gap_min_seconds: wholeNumberInRange(PUBLIC_REPLY_GAP_SECONDS_RANGE),
    public_reply_gap_max_seconds: wholeNumberInRange(PUBLIC_REPLY_GAP_SECONDS_RANGE),
    expected_updated_at: expectedUpdatedAtSchema,
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expected_updated_at'), {
    message: 'errors:validation.sendAtLeastOneField',
  });

/** The parsed body of {@link UpdateInstagramAccountSettingsDto}. */
export type UpdateInstagramAccountSettingsInput = z.infer<typeof UpdateInstagramAccountSettingsDto>;
