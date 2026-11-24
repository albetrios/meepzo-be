import { fieldValidationError } from '@/shared/errors/index.js';
import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import {
  DAY_LIMIT_MAX_FACTOR,
  OPENING_HOUR_LIMIT_DEFAULT,
} from './instagram-account-settings.constants.js';
import {
  UpdateInstagramAccountSettingsDto,
  type UpdateInstagramAccountSettingsInput,
} from './instagram-account-settings.dto.js';
import type { InstagramAccountSettingsChanges } from './instagram-account-settings.types.js';

/**
 * Parses the `PATCH /app/social/instagram/accounts/{channel_account_id}/settings` body with the
 * strict {@link UpdateInstagramAccountSettingsDto}; throws `ValidationError` (400) on a value out of
 * range or not a whole number (`errors[].field` names the setting), a stop word empty, too long or
 * repeated, more than 50, an unknown field (the launch's public-reply fields included), or a body
 * with no setting.
 */
export function validateUpdateInstagramAccountSettings(
  data: unknown,
): UpdateInstagramAccountSettingsInput {
  return parseWithSchema({ schema: UpdateInstagramAccountSettingsDto, data });
}

/** The settings columns the merged checks read. */
export interface InstagramAccountSettingsMergeable {
  opening_hour_limit: number | null;
  opening_day_limit: number | null;
  extra_delay_seconds_min: number | null;
  extra_delay_seconds_max: number | null;
}

/** Each column the change sends, else the saved one. */
function mergedValue<Key extends keyof InstagramAccountSettingsMergeable>({
  saved,
  changes,
  key,
}: {
  saved: InstagramAccountSettingsMergeable;
  changes: InstagramAccountSettingsChanges;
  key: Key;
}): InstagramAccountSettingsMergeable[Key] {
  const sent = changes[key];
  return sent === undefined ? saved[key] : sent;
}

/**
 * Refuses a save whose merged result breaks a rule across two fields (IA12, IA13): each value is
 * the body's when sent, else the saved one.
 *
 * @remarks
 * - **Algorithm:**
 *   1. The extra delay — both ends or neither: one end alone → `400` on the missing end
 *      (`errors:validation.extraDelayBothOrNeither`); the maximum below the minimum → `400` on
 *      `extra_delay_seconds_max` (`errors:validation.extraDelayMaxBelowMin`).
 *   2. The opening day limit, when set: from the hour limit (the owner's, else
 *      `OPENING_HOUR_LIMIT_DEFAULT`) to 24 times it → else `400` on `opening_day_limit`
 *      (`errors:validation.openingDayLimitOutOfRange`). Checked whether or not the day limit is
 *      read — a stored value must be usable once it is.
 * - **Failure modes:** `ValidationError` naming `body.<field>`, like every merged body check.
 * - **Notes:** the table's `chk_instagram_account_settings_extra_delay` holds rule 1 too; this runs
 *   first so the caller gets a 400 naming the field, never a constraint error.
 */
export function assertMergedSettingsValid({
  saved,
  changes,
}: {
  /** The settings as saved. */
  saved: InstagramAccountSettingsMergeable;
  /** The validated change. */
  changes: InstagramAccountSettingsChanges;
}): void {
  const delayMinimum = mergedValue({ saved, changes, key: 'extra_delay_seconds_min' });
  const delayMaximum = mergedValue({ saved, changes, key: 'extra_delay_seconds_max' });
  if ((delayMinimum === null) !== (delayMaximum === null)) {
    throw fieldValidationError({
      field:
        delayMinimum === null ? 'body.extra_delay_seconds_min' : 'body.extra_delay_seconds_max',
      messageKey: 'errors:validation.extraDelayBothOrNeither',
    });
  }
  if (delayMinimum !== null && delayMaximum !== null && delayMaximum < delayMinimum) {
    throw fieldValidationError({
      field: 'body.extra_delay_seconds_max',
      messageKey: 'errors:validation.extraDelayMaxBelowMin',
    });
  }
  const dayLimit = mergedValue({ saved, changes, key: 'opening_day_limit' });
  if (dayLimit === null) return;
  const hourLimit =
    mergedValue({ saved, changes, key: 'opening_hour_limit' }) ?? OPENING_HOUR_LIMIT_DEFAULT;
  if (dayLimit < hourLimit || dayLimit > hourLimit * DAY_LIMIT_MAX_FACTOR) {
    throw fieldValidationError({
      field: 'body.opening_day_limit',
      messageKey: 'errors:validation.openingDayLimitOutOfRange',
      messageParams: { minimum: hourLimit, maximum: hourLimit * DAY_LIMIT_MAX_FACTOR },
    });
  }
}
