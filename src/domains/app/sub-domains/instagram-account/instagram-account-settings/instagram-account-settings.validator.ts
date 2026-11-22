import { fieldValidationError } from '@/shared/errors/index.js';
import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import {
  UpdateInstagramAccountSettingsDto,
  type UpdateInstagramAccountSettingsInput,
} from './instagram-account-settings.dto.js';

/**
 * Parses the `PATCH /app/social/instagram/account/settings` body with the strict
 * {@link UpdateInstagramAccountSettingsDto}; throws `ValidationError` (400) on a value out of range
 * or not a whole number (`errors[].field` names the setting), an unknown field, or a body with no
 * setting.
 */
export function validateUpdateInstagramAccountSettings(
  data: unknown,
): UpdateInstagramAccountSettingsInput {
  return parseWithSchema({ schema: UpdateInstagramAccountSettingsDto, data });
}

/**
 * Refuses a save whose merged result puts the maximum gap between public replies below the minimum
 * (IA15): each end is the body's value when sent, else the saved one. Throws `ValidationError`
 * (400) on `body.public_reply_gap_max_seconds` — named like every body field error — whichever end was sent; equal ends pass.
 *
 * @remarks
 * The table's `chk_instagram_account_settings_gap_order` holds the same rule; this check runs first
 * so the caller gets a 400 naming the field, never a constraint error.
 */
export function assertPublicReplyGapOrder({
  saved,
  changes,
}: {
  /** The settings as saved. */
  saved: { public_reply_gap_min_seconds: number; public_reply_gap_max_seconds: number };
  /** The validated change — either end may be absent. */
  changes: Pick<
    UpdateInstagramAccountSettingsInput,
    'public_reply_gap_min_seconds' | 'public_reply_gap_max_seconds'
  >;
}): void {
  const minimum = changes.public_reply_gap_min_seconds ?? saved.public_reply_gap_min_seconds;
  const maximum = changes.public_reply_gap_max_seconds ?? saved.public_reply_gap_max_seconds;
  if (maximum < minimum) {
    throw fieldValidationError({
      field: 'body.public_reply_gap_max_seconds',
      messageKey: 'errors:validation.publicReplyGapMaxBelowMin',
    });
  }
}
