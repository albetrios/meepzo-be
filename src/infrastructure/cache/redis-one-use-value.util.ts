import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

/** Random bytes in a one-use token (256 bits). */
const ONE_USE_TOKEN_BYTES = 32;

/**
 * A fresh random one-use token (32 bytes) in the given encoding — the `state` of a login
 * round-trip.
 *
 * @remarks
 * `hex` for the OAuth sign-in's state (as built), `base64url` for the channel connection's login
 * state (routes-final § 1 MC4).
 */
export function generateOneUseToken(encoding: 'hex' | 'base64url'): string {
  return randomBytes(ONE_USE_TOKEN_BYTES).toString(encoding);
}

/**
 * Stores a value under a one-use key for `ttlSeconds` (`SET … EX`) — the set half of the one-use
 * login state the OAuth sign-in and the channel connection share (routes-final § 1 MC4, MCC3).
 *
 * @remarks
 * - **Algorithm:** one `SET key value EX ttl`.
 * - **Failure modes:** a Redis error propagates — the caller cannot answer a login address whose
 *   state was not stored.
 * - **Side effects:** one Redis key that lives `ttlSeconds`.
 * - **Notes:** `key` is the LOGICAL key; ioredis prepends the deployment prefix. Short-lived login
 *   state only — Redis is its only holder by design (P26): nothing is lost if it goes.
 */
export async function storeOneUseValue({
  redis,
  key,
  value,
  ttlSeconds,
}: {
  redis: Redis;
  key: string;
  value: string;
  ttlSeconds: number;
}): Promise<void> {
  await redis.set(key, value, 'EX', ttlSeconds);
}

/**
 * Reads and deletes a one-use value in one step (`GETDEL`) — the use half of
 * {@link storeOneUseValue}.
 *
 * @remarks
 * - **Algorithm:** one atomic `GETDEL`, so of two concurrent uses only one reads the value.
 * - **Failure modes:** a Redis error propagates.
 * - **Side effects:** deletes the key.
 * - **Notes:** `null` for a missing, expired or already used key — the caller refuses it.
 */
export async function consumeOneUseValue({
  redis,
  key,
}: {
  redis: Redis;
  key: string;
}): Promise<string | null> {
  const value = await redis.getdel(key);
  return value === null || value.length === 0 ? null : value;
}
