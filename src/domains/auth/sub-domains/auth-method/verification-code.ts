import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { deriveSecretsSubKey } from '@/shared/utils/security/secrets-sub-key.util.js';

/** Number of characters in an email verification code. */
export const VERIFICATION_CODE_LENGTH = 6;

/**
 * Alphabet a verification code is drawn from: digits only (AT6, plan:L7634) — six digits are typed on
 * a phone keypad and read off an email without a letter/number mix-up. The 10^6 keyspace is guarded
 * online by {@link VERIFICATION_CODE_MAX_VERIFY_ATTEMPTS} per code, {@link EMAIL_CODE_WRONG_TRIES_PER_DAY}
 * per email, the {@link VERIFICATION_CODE_TTL_MINUTES} lifetime and single-use consume.
 */
export const VERIFICATION_CODE_CHARSET = '0123456789';

/** Minutes an issued verification code stays valid before it must be re-requested. */
export const VERIFICATION_CODE_TTL_MINUTES = 15;

/**
 * Per-user verification attempts allowed within a code's lifetime before further tries are rejected.
 * This online cap (paired with the short TTL + single-use consume + the bounded number of concurrent
 * live codes) is what makes guessing infeasible — mirrors the MFA TOTP verification budget.
 */
export const VERIFICATION_CODE_MAX_VERIFY_ATTEMPTS = 5;

/** Seconds a caller must wait between successive code resends for the same purpose (anti-spam). */
export const VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS = 60;

/**
 * Wrong email-code sign-in tries one email may spend in {@link EMAIL_CODE_WRONG_TRIES_DAY_SECONDS}
 * before `POST /auth/email/login` answers `429 code_day_limit` (AT8). Counted in Redis by the email's
 * hash — it limits, it does not record; a successful sign-in clears it.
 */
export const EMAIL_CODE_WRONG_TRIES_PER_DAY = 20;

/** Window of the {@link EMAIL_CODE_WRONG_TRIES_PER_DAY} counter: 24 hours, from its first wrong try. */
export const EMAIL_CODE_WRONG_TRIES_DAY_SECONDS = 24 * 60 * 60;

/** HMAC pepper for verification codes — a labelled sub-key of `SECRETS_ENCRYPTION_KEY`. */
function verificationCodePepper(): Buffer {
  return deriveSecretsSubKey('verification-code-pepper');
}

/**
 * Generates a cryptographically-random digits-only verification code of
 * {@link VERIFICATION_CODE_LENGTH} characters drawn from {@link VERIFICATION_CODE_CHARSET}.
 *
 * @remarks
 * - **Algorithm:** one `crypto.randomInt(0, charset.length)` draw per position (uniform CSPRNG —
 *   never `Math.random`), so every code is exactly {@link VERIFICATION_CODE_LENGTH} chars.
 * - **Side effects:** none.
 * - **Notes:** the raw code is emailed to the user and never persisted; only
 *   {@link hashVerificationCode} of it is stored. Guess-resistance comes from the large keyspace,
 *   short TTL, single-use consume, the per-code attempt cap and the per-email day limit.
 */
export function generateVerificationCode(): string {
  let code = '';
  for (let index = 0; index < VERIFICATION_CODE_LENGTH; index += 1) {
    code += VERIFICATION_CODE_CHARSET[randomInt(0, VERIFICATION_CODE_CHARSET.length)];
  }
  return code;
}

/**
 * Normalizes a user-submitted verification code: trims surrounding whitespace, removes internal
 * spaces/hyphens (some clients chunk the code for readability), and uppercases it so a letter code
 * issued before the digits-only change (AT6) still matches its stored hash until it expires.
 *
 * @remarks
 * - **Side effects:** none.
 * - **Notes:** generation only ever emits {@link VERIFICATION_CODE_CHARSET} characters, so a valid
 *   code is always in-charset after normalization; a transcription error simply fails to match and
 *   surfaces as a `code_wrong` rejection rather than a validation error.
 */
export function normalizeVerificationCode(raw: string): string {
  return raw.trim().replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Keyed, user-scoped HMAC digest of a verification code — the only form persisted (in
 * `verification_tokens.token_hash`).
 *
 * @remarks
 * - **Algorithm:** `HMAC_SHA256(pepper, \`${tokenType}:${userId}:${normalizedCode}\`)` hex (64 chars,
 *   matching the column width). The pepper ({@link verificationCodePepper}) is derived from the
 *   server secret, so a database-only leak cannot rainbow-reverse the small code space; binding the
 *   user id additionally makes the digest unique per user, so the global `UNIQUE(token_hash)`
 *   constraint never cross-user-collides for two users who happen to draw the same code.
 * - **Side effects:** none.
 * - **Notes:** the consume lookup is still scoped to `(user_id, token_type)` and gated by a per-user
 *   attempt cap — the keyed hash hardens at-rest storage, it is not on its own the access control.
 */
export function hashVerificationCode(options: {
  tokenType: string;
  userId: number;
  code: string;
}): string {
  const normalized = normalizeVerificationCode(options.code);
  return createHmac('sha256', verificationCodePepper())
    .update(`${options.tokenType}:${options.userId}:${normalized}`)
    .digest('hex');
}

/** Constant-time comparison of two hex digests of equal length (defence-in-depth for hash matching). */
export function verificationHashesEqual({ left, right }: { left: string; right: string }): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
