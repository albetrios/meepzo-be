import { z } from 'zod';
import { trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';
import {
  CHANNEL_ACCOUNT_PICK_MAX,
  CHANNEL_CONNECTION_CHANNELS,
  CHANNEL_CONNECTION_PROVIDERS,
} from './channel-connection.constants.js';

/** Longest login code a callback accepts (routes-final § 1.8). */
const CHANNEL_CONNECT_CODE_MAX_LENGTH = 2000;
/** What Meta appends to the code in the redirect, not part of it (1.8) — the validator strips it. */
export const CHANNEL_CONNECT_CODE_REDIRECT_SUFFIX = '#_';
/** A login state: 32 random bytes as base64url — 43 characters (MC4). */
const CHANNEL_CONNECT_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** A provider's account id — digits (Instagram user ids). */
const PROVIDER_ACCOUNT_ID_PATTERN = /^[0-9]{1,64}$/;

/** Path of routes 1, 2 (and Meta's callbacks 16–17, ROUTE row R9): `{provider}` — `meta` only. */
export const channelConnectionProviderParamsDto = z
  .object({ provider: z.enum(CHANNEL_CONNECTION_PROVIDERS) })
  .strict();

/** Path of routes 3, 5, 40, 42 (and 15, 41): `{channel_connection_id}`. */
export const channelConnectionIdParamsDto = z
  .object({ channel_connection_id: trimmedStringMinMax({ min: 1, max: 28 }) })
  .strict();

/**
 * Body of `POST /app/social/channel-connections/{provider}/callback` (route 2, 1.8): the code Meta
 * sent to the frontend's return page (its trailing `#_` stripped by the validator — a transform has
 * no JSON Schema) and the state route 1 or 40 minted.
 * Strict: an unknown field is a `400`.
 */
export const channelConnectCallbackDto = z
  .object({
    code: trimmedStringMinMax({ min: 1, max: CHANNEL_CONNECT_CODE_MAX_LENGTH }),
    state: z.string().regex(CHANNEL_CONNECT_STATE_PATTERN),
  })
  .strict();

/**
 * Body of `POST /app/social/channel-connections/{channel_connection_id}/accounts` (route 3, 1.8):
 * the channel and 1–10 provider account ids, digits, no repeats. Strict.
 */
export const channelAccountPickDto = z
  .object({
    channel: z.enum(CHANNEL_CONNECTION_CHANNELS),
    provider_account_ids: z
      .array(z.string().regex(PROVIDER_ACCOUNT_ID_PATTERN))
      .min(1)
      .max(CHANNEL_ACCOUNT_PICK_MAX)
      .refine((identifiers) => new Set(identifiers).size === identifiers.length, {
        message: 'errors:validation.eachValueOnce',
      }),
  })
  .strict();

/** Query of `GET /app/social/channel-connections` (route 4): `include_revoked` (default `false`). */
export const listChannelConnectionsQueryDto = z
  .object({ include_revoked: z.enum(['true', 'false']).optional() })
  .strict();

/** An empty body (routes 1 and 40 take none): absent, `null` or `{}`; any field is a `400`. */
export const emptyChannelConnectionBodyDto = z.object({}).strict().nullish();

/** The parsed body of {@link channelConnectCallbackDto}. */
export type ChannelConnectCallbackInput = z.infer<typeof channelConnectCallbackDto>;

/** The parsed body of {@link channelAccountPickDto}. */
export type ChannelAccountPickInput = z.infer<typeof channelAccountPickDto>;
