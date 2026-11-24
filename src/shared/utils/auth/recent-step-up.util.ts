import type { Redis } from 'ioredis';

/** Redis TTL for a successful step-up authentication (MFA verify) before credential mutations. */
export const RECENT_STEP_UP_TTL_SECONDS = 10 * 60;

/**
 * The factor a caller used to complete step-up. Stored as the sentinel value so a
 * destructive-mutation gate can require a STRONG factor.
 *
 * @remarks There is no `password` factor — passwords are off (P84). `email_code` is the step-up of
 * a person WITHOUT settled 2FA (feat-instagram-dm-sending AT15): `POST /auth/step-up` refuses it
 * (`403 mfa_step_up_required`) for anyone holding a settled 2FA factor, so every `email_code`
 * window belongs to a person whose mailbox can already sign them in — it is STRONG (it can revoke
 * sessions and remove a passkey, a sign-in way or the 2FA factor). A person with only a
 * provisional factor still opens it with an email code (A-1). `provisional_mfa` is an MFA step-up
 * with a factor that was enrolled under an email-code window and is still provisional
 * (`PROVISIONAL_FACTOR_PERIOD_SECONDS`, or the enrolling session) — weak: enough to enroll, not to
 * revoke.
 */
export const STEP_UP_FACTORS = ['mfa', 'email_code', 'provisional_mfa'] as const;
/** A factor accepted by `POST /auth/step-up` / MFA verify — see {@link STEP_UP_FACTORS}. */
export type StepUpFactor = (typeof STEP_UP_FACTORS)[number];

/** Factors strong enough to authorize destructive credential/session mutations (AT15 — never `provisional_mfa`). */
const STRONG_STEP_UP_FACTORS: readonly StepUpFactor[] = ['mfa', 'email_code'];

const RECENT_STEP_UP_KEY_PREFIX = 'step-up:';

/**
 * Composes the Redis key for the step-up sentinel — `step-up:<userPublicId>:<sessionPublicId>`.
 *
 * @remarks
 * The sentinel is per-(user, session), NOT per-user (sec-A2). Without session binding, a
 * holder of a stolen session could wait for the legitimate user's next routine step-up
 * (Account → Add passkey, MFA verify, etc.) and inherit the 10-minute window on every
 * other session for the same user. With binding, only the session that earned the step-up
 * can present it for `requireRecentStepUpPreHandler`.
 */
function buildRecentStepUpKey({
  userPublicId,
  sessionPublicId,
}: {
  userPublicId: string;
  sessionPublicId: string;
}): string {
  return `${RECENT_STEP_UP_KEY_PREFIX}${userPublicId}:${sessionPublicId}`;
}

/**
 * Records that the user recently completed step-up authentication on the specific session that
 * earned it, tagging the sentinel with the {@link StepUpFactor} used.
 *
 * @remarks Requires a non-empty `sessionPublicId` so the sentinel is per-session (sec-A2);
 * an empty/missing session id is a programming error and would defeat the binding. The stored
 * value is the factor (not the session id) so {@link hasRecentStrongStepUp} can exclude
 * `provisional_mfa` windows from destructive mutations.
 */
export async function recordRecentStepUp({
  redis,
  userPublicId,
  sessionPublicId,
  factor,
}: {
  redis: Redis;
  userPublicId: string;
  sessionPublicId: string;
  factor: StepUpFactor;
}): Promise<void> {
  if (!sessionPublicId) {
    throw new Error('recordRecentStepUp requires a non-empty sessionPublicId');
  }
  await redis.set(
    buildRecentStepUpKey({ userPublicId, sessionPublicId }),
    factor,
    'EX',
    RECENT_STEP_UP_TTL_SECONDS,
  );
}

/**
 * The factor of the session's current step-up window, or `undefined` when it has none.
 *
 * @remarks A-1 — MFA enrollment reads it to tell an enrollment under an email-code window (a
 * provisional factor) from one under an MFA window. Fails closed on a missing session
 * id (`undefined`) and on a stored value that is not a known factor.
 */
export async function findRecentStepUpFactor({
  redis,
  userPublicId,
  sessionPublicId,
}: {
  redis: Redis;
  userPublicId: string;
  sessionPublicId: string | undefined;
}): Promise<StepUpFactor | undefined> {
  if (!sessionPublicId) return undefined;
  const value = await redis.get(buildRecentStepUpKey({ userPublicId, sessionPublicId }));
  return STEP_UP_FACTORS.find((factor) => factor === value);
}

/**
 * Returns true when the given session has a recent step-up within
 * {@link RECENT_STEP_UP_TTL_SECONDS}.
 *
 * @remarks Fails closed when `sessionPublicId` is undefined: returns false so a caller that
 * cannot identify the session never satisfies the gate (sec-A2). This protects against a
 * future regression where an authenticator forgets to populate the session id.
 */
export async function hasRecentStepUp({
  redis,
  userPublicId,
  sessionPublicId,
}: {
  redis: Redis;
  userPublicId: string;
  sessionPublicId: string | undefined;
}): Promise<boolean> {
  if (!sessionPublicId) {
    return false;
  }
  const value = await redis.get(buildRecentStepUpKey({ userPublicId, sessionPublicId }));
  return value !== null;
}

/**
 * Returns true only when the session's recent step-up was completed via a STRONG factor
 * (`mfa`, or `email_code` — only a person without settled 2FA can open that one, AT15) — used to
 * gate destructive credential/session mutations.
 *
 * @remarks Excludes `provisional_mfa` windows: a factor enrolled minutes ago under an email-code
 * window must not by itself revoke sessions or delete credentials. Fails closed on a missing
 * session id and on any stored value that is not a strong factor.
 */
export async function hasRecentStrongStepUp({
  redis,
  userPublicId,
  sessionPublicId,
}: {
  redis: Redis;
  userPublicId: string;
  sessionPublicId: string | undefined;
}): Promise<boolean> {
  if (!sessionPublicId) {
    return false;
  }
  const value = await redis.get(buildRecentStepUpKey({ userPublicId, sessionPublicId }));
  return value !== null && STRONG_STEP_UP_FACTORS.includes(value as StepUpFactor);
}
