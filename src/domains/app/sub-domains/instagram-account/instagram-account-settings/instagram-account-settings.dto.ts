import { z } from 'zod';
import { expectedUpdatedAtSchema } from '@/shared/utils/validation/record-fields.util.js';
import {
  BROADCAST_HOUR_LIMIT_MAX,
  DAY_LIMIT_MAX_FACTOR,
  EXTRA_DELAY_MAX_SECONDS,
  EXTRA_STOP_WORD_MAX_LENGTH,
  EXTRA_STOP_WORDS_MAX,
  FAST_HOUR_LIMIT_MAX,
  OPENING_HOUR_LIMIT_MAX,
  PERSON_HOUR_LIMIT_RANGE,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';

/**
 * One owner limit of a `PATCH`: a whole number within `range`, `null` to clear it back to the
 * settings file's value, or left out to keep it.
 */
function ownerLimit(range: { min: number; max: number }) {
  return z.number().int().min(range.min).max(range.max).nullable().optional();
}

/**
 * The owner's stop words: at most 50, each trimmed and lower-cased to 1–50 characters, no repeats
 * once normalised (IA12, D49).
 */
const extraStopWordsSchema = z
  .array(z.string().trim().toLowerCase().min(1).max(EXTRA_STOP_WORD_MAX_LENGTH))
  .max(EXTRA_STOP_WORDS_MAX)
  .refine((words) => new Set(words).size === words.length, {
    message: 'errors:validation.eachStopWordOnce',
  });

/**
 * Body of `PATCH /app/social/instagram/accounts/{channel_account_id}/settings` (route 12,
 * routes-final § 2.B.8, IA12): any of the fourteen settings or the automation switch, at least one,
 * and an optional `expected_updated_at`.
 *
 * @remarks
 * Every limit is nullable — `null` clears it to the settings file's value. API ranges:
 * `opening_hour_limit` 1–700, `opening_day_limit` ≥ 1 (its bounds against the hour limit are checked
 * on the merged result), `fast_hour_limit` 1–20,000, `person_hour_limit` 5–100,
 * `broadcast_hour_limit` 1–2,000, each extra delay end 1–20 seconds — whole numbers only. Strict: an
 * unknown field is a `400` — the five public-reply fields the launch had included (AC-3.9) — and so
 * is a body with no setting. The extra delay's both-or-neither and order, and the day limit's
 * bounds, are checked on the merged result against the saved row (`assertMergedSettingsValid`).
 */
export const UpdateInstagramAccountSettingsDto = z
  .object({
    is_automation_enabled: z.boolean().optional(),
    opening_hour_limit: ownerLimit({ min: 1, max: OPENING_HOUR_LIMIT_MAX }),
    opening_day_limit: ownerLimit({ min: 1, max: OPENING_HOUR_LIMIT_MAX * DAY_LIMIT_MAX_FACTOR }),
    fast_hour_limit: ownerLimit({ min: 1, max: FAST_HOUR_LIMIT_MAX }),
    person_hour_limit: ownerLimit(PERSON_HOUR_LIMIT_RANGE),
    broadcast_hour_limit: ownerLimit({ min: 1, max: BROADCAST_HOUR_LIMIT_MAX }),
    is_automatic_notice_enabled: z.boolean().optional(),
    extra_stop_words: extraStopWordsSchema.optional(),
    is_comment_reply_trigger_enabled: z.boolean().optional(),
    is_once_per_person_per_post_enabled: z.boolean().optional(),
    is_mark_seen_after_reply_enabled: z.boolean().optional(),
    extra_delay_seconds_min: ownerLimit({ min: 1, max: EXTRA_DELAY_MAX_SECONDS }),
    extra_delay_seconds_max: ownerLimit({ min: 1, max: EXTRA_DELAY_MAX_SECONDS }),
    expected_updated_at: expectedUpdatedAtSchema,
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expected_updated_at'), {
    message: 'errors:validation.sendAtLeastOneField',
  });

/** The parsed body of {@link UpdateInstagramAccountSettingsDto}. */
export type UpdateInstagramAccountSettingsInput = z.infer<typeof UpdateInstagramAccountSettingsDto>;
