import type { Redis } from 'ioredis';
import {
  consumeOneUseValue,
  generateOneUseToken,
  storeOneUseValue,
} from '@/infrastructure/cache/redis-one-use-value.util.js';
import { ValidationError } from '@/shared/errors/index.js';
import { CONNECT_STATE_MINUTES } from '@/shared/constants/instagram.constants.js';

/** Logical Redis key prefix of a channel connection's login state (routes-final § 1 MC4). */
export const CHANNEL_CONNECT_STATE_KEY_PREFIX = 'app:channel-connect-state:';

/** Seconds in a minute, for the state's lifetime. */
const SECONDS_PER_MINUTE = 60;

/** The providers a channel connection logs in with — `meta` only this iteration (MC1). */
export type ChannelConnectionProvider = 'meta';

/**
 * What a channel connection's login state holds (routes-final § 1 MC4): who started the login, in
 * which organization, for which provider, with which Meta login configuration (P356) and — for a
 * reconnect (route 40, MC17) — which connection.
 */
export interface ChannelConnectStatePayload {
  provider: ChannelConnectionProvider;
  organization_public_id: string;
  user_public_id: string;
  /** Set by route 40 (a reconnect bound to this connection); `null` for route 1. */
  channel_connection_public_id: string | null;
  /**
   * The Meta login configuration the login address carried (`META_CONFIG_ID` when the state was
   * minted) — the callback stores this one on the connection, never a later setting (P356).
   */
  config_id: string;
}

/**
 * Mints a channel connection's one-use login state (routes 1 and 40, routes-final § 1 MC4, MC17,
 * P26).
 *
 * @remarks
 * - **Algorithm:** 32 random bytes, base64url ({@link generateOneUseToken}); the payload stored
 *   under `app:channel-connect-state:<state>` for {@link CONNECT_STATE_MINUTES} minutes through the
 *   one-use helper the OAuth sign-in shares (MCC3).
 * - **Failure modes:** a Redis error propagates (the route cannot answer a login address whose
 *   state was not stored).
 * - **Side effects:** one Redis key.
 * - **Notes:** Redis only — short-lived login state, nothing lost if it goes (P26). A repeat mints
 *   another harmless state, so the routes need no idempotency key. Routes 1 and 40 call it.
 */
export async function mintChannelConnectState({
  redis,
  payload,
}: {
  redis: Redis;
  payload: ChannelConnectStatePayload;
}): Promise<string> {
  const state = generateOneUseToken('base64url');
  await storeOneUseValue({
    redis,
    key: `${CHANNEL_CONNECT_STATE_KEY_PREFIX}${state}`,
    value: JSON.stringify(payload),
    ttlSeconds: CONNECT_STATE_MINUTES * SECONDS_PER_MINUTE,
  });
  return state;
}

/** The 400 `channel_connect_state_invalid` every refused state answers (MC5 step 1). */
function channelConnectStateInvalidError(): ValidationError {
  return new ValidationError('errors:channelConnectStateInvalid').withReason(
    'channel_connect_state_invalid',
  );
}

/** The stored payload when it has the payload's shape, else `null`. */
function parseStatePayload(raw: string): ChannelConnectStatePayload | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const payload = value as Partial<ChannelConnectStatePayload>;
    if (
      payload.provider !== 'meta' ||
      typeof payload.organization_public_id !== 'string' ||
      typeof payload.user_public_id !== 'string' ||
      typeof payload.config_id !== 'string' ||
      payload.config_id.length === 0 ||
      !(
        payload.channel_connection_public_id === null ||
        typeof payload.channel_connection_public_id === 'string'
      )
    ) {
      return null;
    }
    return payload as ChannelConnectStatePayload;
  } catch {
    return null;
  }
}

/**
 * Reads and deletes a channel connection's login state, and refuses one that is not this caller's
 * (route 2 step 1, routes-final § 1 MC5).
 *
 * @remarks
 * - **Algorithm:** `GETDEL` through the shared one-use helper, so the state is spent on its first
 *   use whatever the outcome; then the stored provider, organization and user must equal the
 *   caller's.
 * - **Failure modes:** missing, empty, used, older than {@link CONNECT_STATE_MINUTES} minutes,
 *   malformed, another provider's, another organization's or another user's →
 *   `400 channel_connect_state_invalid`, nothing saved.
 * - **Side effects:** deletes the Redis key.
 * - **Notes:** the callback's network retry is answered by the idempotency replay
 *   (`channel-connect:<state>`), never by reading the state twice. Route 2 calls it.
 */
export async function consumeChannelConnectState({
  redis,
  state,
  provider,
  organizationPublicId,
  userPublicId,
}: {
  redis: Redis;
  state: string | undefined;
  provider: ChannelConnectionProvider;
  organizationPublicId: string;
  userPublicId: string;
}): Promise<ChannelConnectStatePayload> {
  if (state === undefined || state.length === 0) throw channelConnectStateInvalidError();
  const raw = await consumeOneUseValue({
    redis,
    key: `${CHANNEL_CONNECT_STATE_KEY_PREFIX}${state}`,
  });
  const payload = raw === null ? null : parseStatePayload(raw);
  if (
    payload === null ||
    payload.provider !== provider ||
    payload.organization_public_id !== organizationPublicId ||
    payload.user_public_id !== userPublicId
  ) {
    throw channelConnectStateInvalidError();
  }
  return payload;
}
