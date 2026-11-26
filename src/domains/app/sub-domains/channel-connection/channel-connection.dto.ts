import { z } from 'zod';
import { trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';
import {
  CHANNEL_ACCOUNT_PICK_MAX,
  CHANNEL_CONNECTION_CHANNELS,
  CHANNEL_CONNECTION_PROVIDERS,
  META_AD_CURSOR_MAX_LENGTH,
  META_AD_PAGE_SIZE,
} from './channel-connection.constants.js';
import { INSTAGRAM_ID_REGEX } from '@/shared/constants/instagram.constants.js';

/** Longest login code a callback accepts (routes-final § 1.8). */
const CHANNEL_CONNECT_CODE_MAX_LENGTH = 2000;
/** What Meta appends to the code in the redirect, not part of it (1.8) — the validator strips it. */
export const CHANNEL_CONNECT_CODE_REDIRECT_SUFFIX = '#_';
/** A login state: 32 random bytes as base64url — 43 characters (MC4). */
const CHANNEL_CONNECT_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Path of routes 1, 2 (and Meta's callbacks 16–17, ROUTE row R9): `{provider}` — `meta` only. */
export const channelConnectionProviderParamsDto = z
  .object({ provider: z.enum(CHANNEL_CONNECTION_PROVIDERS) })
  .strict();

/** Path of routes 3, 5, 15, 40–42: `{channel_connection_id}`. */
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
      .array(z.string().regex(INSTAGRAM_ID_REGEX))
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

/** Meta's ad account id — digits, without the `act_` prefix (route 15's `ad_account_id`, 1.8). */
const META_AD_ACCOUNT_ID_PATTERN = /^\d{1,32}$/;

/** Query of `GET /app/social/channel-connections/{channel_connection_id}/ad-accounts` (route 41): none. Strict. */
export const listChannelConnectionAdAccountsQueryDto = z.object({}).strict();

/**
 * Query of `GET /app/social/channel-connections/{channel_connection_id}/ads` (route 15, 1.8): one
 * ad account at a time (P57) and Meta's own paging.
 *
 * @remarks
 * `ad_account_id` required, digits (an ad account of route 41); `limit` 1–50, default 25, passed on
 * as Meta's `limit`; `after` is Meta's cursor from the previous page's `meta.pagination.next`,
 * 1–1000 characters, passed back untouched. Strict: an unknown query field is a `400`.
 */
export const listChannelConnectionAdsQueryDto = z
  .object({
    ad_account_id: z.string().regex(META_AD_ACCOUNT_ID_PATTERN),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(META_AD_PAGE_SIZE.maximum)
      .default(META_AD_PAGE_SIZE.default),
    after: z.string().min(1).max(META_AD_CURSOR_MAX_LENGTH).optional(),
  })
  .strict();

/** The parsed query of {@link listChannelConnectionAdsQueryDto}. */
export type ListChannelConnectionAdsQueryInput = z.infer<typeof listChannelConnectionAdsQueryDto>;

/**
 * Body of routes 1 and 40 (start and reconnect): absent, `null`, `{}` or `{ with_page }` — any other
 * field is a `400`.
 *
 * @remarks
 * `with_page: true` asks for the second login configuration (`META_PAGE_CONFIG_ID`, P358), which
 * also requests the account's linked Facebook Page and `pages_show_list` — for an account shared
 * without its Page, whose `messages` webhooks Meta may not send. Absent or `false`: the default
 * configuration (`META_CONFIG_ID`). Strict.
 */
export const channelConnectStartBodyDto = z
  .object({ with_page: z.boolean().optional() })
  .strict()
  .nullish();

/** The parsed body of {@link channelConnectStartBodyDto}. */
export type ChannelConnectStartBodyInput = z.infer<typeof channelConnectStartBodyDto>;

/** The parsed body of {@link channelConnectCallbackDto}. */
export type ChannelConnectCallbackInput = z.infer<typeof channelConnectCallbackDto>;

/** The parsed body of {@link channelAccountPickDto}. */
export type ChannelAccountPickInput = z.infer<typeof channelAccountPickDto>;
