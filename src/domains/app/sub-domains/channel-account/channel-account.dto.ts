import { z } from 'zod';
import { trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';

/** Path of routes 7–11: `{channel_account_id}` (routes-final § 1B.5). */
export const channelAccountIdParamsDto = z
  .object({ channel_account_id: trimmedStringMinMax({ min: 1, max: 28 }) })
  .strict();

/**
 * Query of `GET /app/social/channel-accounts` (route 6, 1B.8): `channel` — one or more channels,
 * comma-separated (`instagram`); absent = every channel. Strict: an unknown field is a `400`.
 */
export const listChannelAccountsQueryDto = z
  .object({ channel: trimmedStringMinMax({ min: 1, max: 100 }).optional() })
  .strict();

/** Body of routes 9 and 10 (1B.8): none — absent, `null` or `{}`; any field is a `400`. */
export const emptyChannelAccountBodyDto = z.object({}).strict().nullish();

/**
 * Body of `POST /app/social/channel-accounts/{channel_account_id}/activate` (route 11, 1B.8):
 * optional `stop_channel_account_id` (`cha_…`), required at the plan's limit. Strict.
 */
export const activateChannelAccountDto = z
  .object({ stop_channel_account_id: trimmedStringMinMax({ min: 1, max: 28 }).optional() })
  .strict()
  .nullish();

/** The parsed body of {@link activateChannelAccountDto}. */
export type ActivateChannelAccountInput = z.infer<typeof activateChannelAccountDto>;
