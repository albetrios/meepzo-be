import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { UnauthorizedError } from '@/shared/errors/index.js';

import { MFA_SESSION_TTL_SECONDS } from '@/shared/constants/index.js';
/** Redis key prefix for short-lived "password verified, MFA pending" handles handed back to clients between login and `verifyMfa`. */
export const MFA_SESSION_KEY_PREFIX = 'mfa:session:';

/** Payload stored under `mfa:session:<token>` — just the user's public id (no privileges granted until MFA completes). */
export interface MfaSessionPayload {
  user_public_id: string;
}

/** Rejects schema-invalid cached values before they can authorize an MFA continuation. */
function isMfaSessionPayload(payload: unknown): payload is MfaSessionPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const candidate = payload as Record<string, unknown>;
  return typeof candidate.user_public_id === 'string' && candidate.user_public_id.trim().length > 0;
}

/** `401 mfa_session_invalid` — the MFA session token is unknown, spent, expired or malformed (routes-final § 10.C.9). */
function mfaSessionInvalidError(): UnauthorizedError {
  return new UnauthorizedError('errors:mfaInvalidOrExpiredSession').withReason(
    'mfa_session_invalid',
  );
}

/** Mints a 32-byte hex MFA session token, stores `{user_public_id}` under `mfa:session:<token>` with {@link MFA_SESSION_TTL_SECONDS} TTL, and returns the token for the client to echo back. */
export async function createMfaSession({
  redis,
  userPublicId,
}: {
  redis: Redis;
  userPublicId: string;
}): Promise<string> {
  const mfaSessionToken = randomBytes(32).toString('hex');
  const payload: MfaSessionPayload = { user_public_id: userPublicId };
  await redis.set(
    `${MFA_SESSION_KEY_PREFIX}${mfaSessionToken}`,
    JSON.stringify(payload),
    'EX',
    MFA_SESSION_TTL_SECONDS,
  );
  return mfaSessionToken;
}

/** Single-use lookup: atomically reads-and-deletes the Redis entry (`GETDEL`), parses the JSON payload, and returns the original user public id; throws `UnauthorizedError` (`errors:mfaInvalidOrExpiredSession`, reason `mfa_session_invalid`) on any failure. The atomic consume guarantees only one of two concurrent verifies can read a non-null value, preventing token replay in a GET-then-DEL race. */
export async function verifyMfaSession({
  redis,
  mfaSessionToken,
}: {
  redis: Redis;
  mfaSessionToken: string;
}): Promise<MfaSessionPayload> {
  if (!mfaSessionToken || mfaSessionToken.length === 0) {
    throw mfaSessionInvalidError();
  }

  const storedPayloadRaw = await redis.getdel(`${MFA_SESSION_KEY_PREFIX}${mfaSessionToken}`);
  if (!storedPayloadRaw) {
    throw mfaSessionInvalidError();
  }

  let storedPayload: unknown;
  try {
    storedPayload = JSON.parse(storedPayloadRaw);
  } catch {
    throw mfaSessionInvalidError();
  }

  if (!isMfaSessionPayload(storedPayload)) {
    throw mfaSessionInvalidError();
  }

  return storedPayload;
}
