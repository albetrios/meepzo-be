import { ValidationError } from '@/shared/errors/index.js';
import { PUBLIC_ID_PREFIXES } from '@/shared/utils/identity/public-id.util.js';
import { validatePublicIdParam } from '@/shared/utils/identity/public-id-param.util.js';
import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import {
  CHANNEL_ACCOUNT_CHANNELS,
  type ChannelAccountChannel,
} from './channel-account.constants.js';
import {
  activateChannelAccountDto,
  emptyChannelAccountBodyDto,
  listChannelAccountsQueryDto,
} from './channel-account.dto.js';
import { stopChannelAccountInvalidError } from './channel-account-error.util.js';

/** A channel account public id: `cha_` and 21 lower-case letters or digits. */
const CHANNEL_ACCOUNT_PUBLIC_ID_PATTERN = new RegExp(
  `^${PUBLIC_ID_PREFIXES.channelAccount}_[a-z0-9]{21}$`,
);

/** The `{channel_account_id}` path parameter of routes 7–11, checked as a public id (1B.9). */
export function validateChannelAccountIdParam(value: string): string {
  return validatePublicIdParam({ value, fieldName: 'channel_account_id' });
}

/**
 * Route 6's query: `channel` — comma-separated known channels, no repeats; absent = every channel.
 * An unknown channel is `400` with `errors[].field` `channel` (1B.9).
 */
export function validateListChannelAccountsQuery(data: unknown): {
  channels: ChannelAccountChannel[];
} {
  const parsed = parseWithSchema({ schema: listChannelAccountsQueryDto, data: data ?? {} });
  if (parsed.channel === undefined) return { channels: [...CHANNEL_ACCOUNT_CHANNELS] };
  const known: readonly string[] = CHANNEL_ACCOUNT_CHANNELS;
  const values = parsed.channel.split(',').map((value) => value.trim());
  if (values.some((value) => !known.includes(value))) {
    throw new ValidationError('errors:invalidInput', undefined, undefined, [
      { field: 'channel', messageKey: 'errors:validation.invalidInput' },
    ]);
  }
  return { channels: [...new Set(values)] as ChannelAccountChannel[] };
}

/** Routes 9 and 10's body: none, or an empty object (strict). */
export function validateEmptyChannelAccountBody(data: unknown): void {
  parseWithSchema({ schema: emptyChannelAccountBodyDto, data });
}

/**
 * Route 11's body: the optional `stop_channel_account_id`, a `cha_…` id — any other shape is
 * `400` on that field (1B.9).
 */
export function validateActivateChannelAccount(data: unknown): {
  stopChannelAccountPublicId: string | null;
} {
  const parsed = parseWithSchema({ schema: activateChannelAccountDto, data });
  const stop = parsed?.stop_channel_account_id;
  if (stop === undefined) return { stopChannelAccountPublicId: null };
  if (!CHANNEL_ACCOUNT_PUBLIC_ID_PATTERN.test(stop)) throw stopChannelAccountInvalidError();
  return { stopChannelAccountPublicId: stop };
}
