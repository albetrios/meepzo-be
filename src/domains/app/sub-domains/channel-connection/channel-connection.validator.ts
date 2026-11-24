import { ValidationError } from '@/shared/errors/index.js';
import { validatePublicIdParam } from '@/shared/utils/identity/public-id-param.util.js';
import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import { CHANNEL_CONNECTION_PROVIDERS } from './channel-connection.constants.js';
import {
  CHANNEL_CONNECT_CODE_REDIRECT_SUFFIX,
  type ChannelAccountPickInput,
  type ChannelConnectCallbackInput,
  channelAccountPickDto,
  channelConnectCallbackDto,
  emptyChannelConnectionBodyDto,
  listChannelConnectionsQueryDto,
} from './channel-connection.dto.js';
import type { ChannelConnectionProvider } from './channel-connection-state.js';

/**
 * The `{provider}` path parameter of routes 1 and 2 (routes-final § 1.5): `meta` only — another
 * value is `400` with `errors[].field` `provider`.
 */
export function validateChannelConnectionProvider(value: string): ChannelConnectionProvider {
  const providers: readonly string[] = CHANNEL_CONNECTION_PROVIDERS;
  if (!providers.includes(value)) {
    throw new ValidationError('errors:invalidInput', undefined, undefined, [
      { field: 'provider', messageKey: 'errors:validation.invalidInput' },
    ]);
  }
  return value as ChannelConnectionProvider;
}

/** The `{channel_connection_id}` path parameter, checked as a public id (1.5). */
export function validateChannelConnectionIdParam(value: string): string {
  return validatePublicIdParam({ value, fieldName: 'channel_connection_id' });
}

/** Route 1 and 40's body: none, or an empty object (strict). */
export function validateEmptyChannelConnectionBody(data: unknown): void {
  parseWithSchema({ schema: emptyChannelConnectionBodyDto, data });
}

/** Route 2's body: `code` (trailing `#_` stripped) and `state` (1.8). */
export function validateChannelConnectCallback(data: unknown): ChannelConnectCallbackInput {
  const parsed = parseWithSchema({ schema: channelConnectCallbackDto, data });
  return {
    ...parsed,
    code: parsed.code.endsWith(CHANNEL_CONNECT_CODE_REDIRECT_SUFFIX)
      ? parsed.code.slice(0, -CHANNEL_CONNECT_CODE_REDIRECT_SUFFIX.length)
      : parsed.code,
  };
}

/** Route 3's body: `channel` and 1–10 distinct digit ids (1.8). */
export function validateChannelAccountPick(data: unknown): ChannelAccountPickInput {
  return parseWithSchema({ schema: channelAccountPickDto, data });
}

/** Route 4's query: `include_revoked` as a boolean (default `false`). */
export function validateListChannelConnectionsQuery(data: unknown): { includeRevoked: boolean } {
  const parsed = parseWithSchema({ schema: listChannelConnectionsQueryDto, data: data ?? {} });
  return { includeRevoked: parsed.include_revoked === 'true' };
}
