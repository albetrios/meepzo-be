import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { DEFAULT_LANGUAGE, type SupportedLanguage } from '@/shared/constants/i18n.constants.js';
import {
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from '@/shared/errors/index.js';
import {
  ACCOUNT_LOCKOUT_MINUTES,
  IP_FAILED_LOGIN_THRESHOLD,
  IP_FAILED_LOGIN_WINDOW_SECONDS,
  MAX_FAILED_LOGIN_ATTEMPTS,
  PASSWORD_RESET_EXPIRES_IN_MINUTES,
} from '@/shared/constants/index.js';
import { assertUserAccountActive } from '@/shared/utils/auth/account-status.util.js';
import { rateLimitIpKey } from '@/shared/utils/http/rate-limit-ip-key.util.js';
import { isDisposableEmailBlocked } from '@/shared/utils/text/email.util.js';
import {
  DUMMY_ARGON2_HASH,
  hashPassword,
  verifyPassword,
} from '@/shared/utils/security/password.util.js';
import { enforceMinimumDuration } from '@/shared/utils/security/anti-enumeration.util.js';
import { incrementWithExpiryOnFirst } from '@/shared/utils/infrastructure/redis-counter.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { captureException, captureMessage } from '@/infrastructure/observability/sentry/sentry.js';
import { eventBus } from '@/core/events/event-bus.js';
import { withTransaction } from '@/infrastructure/database/transaction.js';
import {
  runWithPinnedDatabaseHandle,
  type RequestScopedPostgresDatabase,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { UserAuthRecord } from '@/domains/user/user.types.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import {
  validateChangePassword,
  validateForgotPassword,
  validateLogin,
  validateResetPassword,
} from '@/domains/auth/auth.validator.js';
import {
  completeFirstFactorAuth,
  type FirstFactorAuthResult,
} from '@/domains/auth/shared/complete-first-factor-auth.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import type { MfaService } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa.service.js';
import { VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS } from './verification-code.js';
import { VERIFICATION_TOKEN_TYPE } from './auth-method.constants.js';
import type { VerificationTokenRepository } from './verification-token/verification-token.repository.js';
import { AUTH_EVENT, type PasswordResetEmailPayload } from './events/auth.events.js';

const IP_FAILED_LOGIN_KEY_PREFIX = 'auth:failed_login:ip:';

/** Redis key prefix for the per-email password-reset send cooldown (anti-mail-bomb spacing). */
const PASSWORD_RESET_COOLDOWN_KEY_PREFIX = 'auth:password_reset_cooldown:';

/**
 * PASSWORD-ROUTES-DISABLED — outcome of {@link PasswordAuthService.resetPassword}: the auto-login it
 * completed, plus the user whose password was reset.
 *
 * @remarks
 * The handler attributes the `auth.password.reset` audit event to `userPublicId` — the MFA branch
 * issues no access token to read the actor from — and returns only `loginResult`.
 */
export interface PasswordResetResult {
  /** Public id of the user whose password was reset. Never part of the response. */
  userPublicId: string;
  /** The auto-login: an access token + session, or an `mfa_required` challenge. */
  loginResult: FirstFactorAuthResult;
}

/**
 * PASSWORD-ROUTES-DISABLED — the password sign-in and password management flows behind the four
 * password routes (`POST /auth/login`, `/auth/password/forgot`, `/auth/password/reset`,
 * `/auth/password/change`), restored from R30 and registered only when `PASSWORD_ROUTES_ENABLED`
 * is true (owner instruction 2026-11-25, feat-instagram-dm-sending P251, superseding P84).
 *
 * @remarks
 * - **Algorithm:** login looks the user up by email, verifies the password (argon2id, rehash on
 *   parameter drift), then hands the first factor to {@link completeFirstFactorAuth} (a session or
 *   the `mfa_required` challenge). The lockout is checked *after* the password so a correct
 *   credential always lifts it. Forgot mints a random 32-byte token, stores its SHA-256 with a
 *   {@link PASSWORD_RESET_EXPIRES_IN_MINUTES} TTL and emits `AUTH_EVENT.PASSWORD_RESET_REQUESTED` in
 *   one transaction; reset consumes the token, stores the new hash, verifies the email, clears the
 *   lockout and revokes every session in one pinned transaction, then signs the user in; change
 *   re-verifies the current password and revokes every other session with the new hash.
 * - **Failure modes:** a disposable email → `ValidationError` (when blocking is on); unknown email,
 *   no stored hash (every hash was emptied by `auth_passwords_off`) or a wrong password →
 *   `401 errors:invalidEmailOrPassword` (uniform, timing-floored); an IP over its failed-login
 *   budget → `429` with `Retry-After`; a bad or expired reset token →
 *   `401 errors:invalidOrExpiredResetToken`; change without a hash → `401 errors:passwordAuthNotEnabled`,
 *   a wrong current password → `401 errors:currentPasswordIncorrect`; an inactive account → `401`.
 * - **Side effects:** writes `auth.users` (`password_hash`, the lockout fields,
 *   `is_email_verified`), `auth.verification_tokens` (`PASSWORD_RESET`) and `auth.sessions`; the
 *   per-IP counter and the reset cooldown in Redis; the reset email through the mail outbox.
 * - **Notes:** the forgot answer is the same for a known and an unknown email (anti-enumeration).
 *   No `PASSWORD` auth-method row is created — the type stays retired; login reads
 *   `auth.users.password_hash` only.
 */
export class PasswordAuthService {
  constructor(
    private readonly userService: UserService,
    private readonly authSessionService: AuthSessionService,
    private readonly mfaService: MfaService,
    private readonly organizationSettingsService: OrganizationSettingsService,
    private readonly verificationTokenRepository: VerificationTokenRepository,
    private readonly redis: Redis,
  ) {}

  private buildIpKey(ipAddress: string): string {
    // The bucket is the caller's rate-limit identity (an IPv6 /64, not the full address — D-3).
    const bucket = rateLimitIpKey(ipAddress);
    return `${IP_FAILED_LOGIN_KEY_PREFIX}${createHash('sha256').update(bucket).digest('hex')}`;
  }

  /**
   * Refuses the login with 429 + `Retry-After` (the counter's remaining TTL) once this IP has
   * {@link IP_FAILED_LOGIN_THRESHOLD} failures in the window. Fails open on Redis errors.
   */
  private async checkIpLoginLimit(ipAddress: string): Promise<void> {
    const key = this.buildIpKey(ipAddress);
    let retryAfterSeconds: number | null = null;
    try {
      const raw = await this.redis.get(key);
      if (raw !== null && Number(raw) >= IP_FAILED_LOGIN_THRESHOLD) {
        const remainingSeconds = await this.redis.ttl(key);
        retryAfterSeconds =
          remainingSeconds === -1 ? IP_FAILED_LOGIN_WINDOW_SECONDS : Math.max(1, remainingSeconds);
      }
    } catch (error) {
      // Redis unavailable — fail open; the per-user lockout and the rate limits still protect.
      logger.warn({ error }, 'auth.ip_limit.check.failed');
    }
    if (retryAfterSeconds !== null) {
      throw new RateLimitedError().withRetryAfter(retryAfterSeconds);
    }
  }

  private async recordIpFailedLogin(ipAddress: string): Promise<void> {
    try {
      const key = this.buildIpKey(ipAddress);
      // Atomic INCR + first-increment EXPIRE — never a no-TTL counter.
      const count = await incrementWithExpiryOnFirst({
        redis: this.redis,
        key,
        ttlSeconds: IP_FAILED_LOGIN_WINDOW_SECONDS,
      });
      if (count === IP_FAILED_LOGIN_THRESHOLD) {
        captureMessage({
          message: 'auth.ip_failed_login.threshold_reached',
          options: { level: 'warning', extra: { ip_hash: key, count } },
        });
        logger.warn({ ip_hash: key, count }, 'auth.ip_failed_login.threshold_reached');
      }
    } catch (error) {
      logger.warn({ error }, 'auth.ip_limit.record.failed');
    }
  }

  private assertEmailAllowed(email: string): void {
    if (isDisposableEmailBlocked(email)) {
      throw new ValidationError('errors:disposableEmail', undefined, undefined, [
        { field: 'email', messageKey: 'errors:disposableEmail' },
      ]).withReason('disposable_email');
    }
  }

  private async signIn({
    user,
    ipAddress,
    userAgent,
  }: {
    user: UserAuthRecord;
    ipAddress: string;
    userAgent?: string | undefined;
  }): Promise<FirstFactorAuthResult> {
    return completeFirstFactorAuth({
      user: {
        id: user.id,
        public_id: user.public_id,
        email: user.email,
        status: user.status,
        is_email_verified: user.is_email_verified,
        is_mfa_enabled: user.is_mfa_enabled,
      },
      ipAddress,
      userAgent,
      organizationSettingsService: this.organizationSettingsService,
      mfaService: this.mfaService,
      authSessionService: this.authSessionService,
      // Non-pinned path: self-heal a missing personal organization into the token.
      ensurePersonalOrganizationOnMiss: true,
    });
  }

  /**
   * PASSWORD-ROUTES-DISABLED — `POST /auth/login`: email + password → a session or the MFA
   * challenge.
   */
  async login({
    body,
    ipAddress,
    userAgent,
  }: {
    body: unknown;
    ipAddress: string;
    userAgent?: string | undefined;
  }): Promise<FirstFactorAuthResult> {
    const parsed = validateLogin(body);
    this.assertEmailAllowed(parsed.email);

    // Reject before expensive argon2 work when this IP has exceeded its failure budget.
    await this.checkIpLoginLimit(ipAddress);

    // Floor every failure branch to a common minimum duration, measured from before the branches
    // diverge, so the extra Postgres write of the wrong-password branch is not a timing oracle.
    const startedAtMillis = Date.now();

    const user = await this.userService.findByEmail(parsed.email);
    if (!user?.password_hash) {
      // Equalize the unknown-email / no-password path with a wrong password (no enumeration).
      await verifyPassword({ plaintext: parsed.password, storedHash: DUMMY_ARGON2_HASH });
      await this.recordIpFailedLogin(ipAddress);
      await enforceMinimumDuration({ startedAtMillis });
      throw new UnauthorizedError('errors:invalidEmailOrPassword');
    }

    // Lockout is checked AFTER the password, so a correct credential always lifts it (never a
    // victim-DoS); it only throttles failed attempts.
    const isLockedOut = Boolean(
      user.account_locked_until && new Date(user.account_locked_until) > new Date(),
    );

    const { valid: isValid, needsRehash } = await verifyPassword({
      plaintext: parsed.password,
      storedHash: user.password_hash,
    });

    if (!isValid) {
      await this.userService.registerFailedLoginAttempt({
        public_id: user.public_id,
        options: {
          maxAttempts: MAX_FAILED_LOGIN_ATTEMPTS,
          lockoutMinutes: ACCOUNT_LOCKOUT_MINUTES,
        },
      });
      await this.recordIpFailedLogin(ipAddress);
      if (isLockedOut) {
        logger.info({ user_public_id: user.public_id }, 'auth.login.attempt_during_lockout');
      }
      await enforceMinimumDuration({ startedAtMillis });
      // One uniform message for unknown email, wrong password and locked-out wrong password.
      throw new UnauthorizedError('errors:invalidEmailOrPassword');
    }

    assertUserAccountActive({ status: user.status, deleted_at: user.deleted_at });

    if ((user.failed_login_count ?? 0) > 0 || isLockedOut) {
      await this.userService.updateLoginAttempt({
        public_id: user.public_id,
        failed_login_count: 0,
        account_locked_until: null,
      });
    }

    if (needsRehash) {
      const newHash = await hashPassword(parsed.password);
      await this.userService.updatePassword({ public_id: user.public_id, password_hash: newHash });
    }

    return this.signIn({ user, ipAddress, userAgent });
  }

  /**
   * PASSWORD-ROUTES-DISABLED — `POST /auth/password/forgot`: emails a reset link when the account
   * exists; the same answer either way.
   */
  async forgotPassword({
    body,
    context,
  }: {
    body: unknown;
    context?: { locale?: SupportedLanguage } | undefined;
  }): Promise<{ messageKey: string }> {
    const startedAtMillis = Date.now();
    const parsed = validateForgotPassword(body);
    this.assertEmailAllowed(parsed.email);

    // Anti-mail-bomb spacing: one reset per email per cooldown, keyed on the requested email
    // whether or not an account exists (never an existence oracle).
    const cooldownKey = `${PASSWORD_RESET_COOLDOWN_KEY_PREFIX}${createHash('sha256')
      .update(parsed.email)
      .digest('hex')}`;
    const cooldownClaimed = await this.redis.set(
      cooldownKey,
      '1',
      'EX',
      VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS,
      'NX',
    );
    if (cooldownClaimed) {
      try {
        await this.issuePasswordResetIfUserExists({
          email: parsed.email,
          locale: context?.locale ?? DEFAULT_LANGUAGE,
        });
      } catch (error) {
        // Never a status oracle: answer exactly like an unknown email, release the cooldown so a
        // retry is not refused, and report it. The issue is atomic — no token without its email.
        logger.error({ err: error }, 'auth.password_reset.issue_failed');
        captureException({ error, context: { tags: { flow: 'password_reset_request' } } });
        await this.releasePasswordResetCooldown(cooldownKey);
      }
    }
    await enforceMinimumDuration({ startedAtMillis });
    return { messageKey: 'success:passwordResetEmailSent' };
  }

  private async releasePasswordResetCooldown(cooldownKey: string): Promise<void> {
    try {
      await this.redis.del(cooldownKey);
    } catch (error) {
      logger.warn({ err: error }, 'auth.password_reset.cooldown_release_failed');
    }
  }

  private async issuePasswordResetIfUserExists({
    email,
    locale,
  }: {
    email: string;
    locale: SupportedLanguage;
  }): Promise<void> {
    const user = await this.userService.findByEmail(email);
    if (!user) return;

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRES_IN_MINUTES * 60_000);

    // Invalidate prior tokens, store the new one and record the outbound mail (in the event
    // handler) as ONE unit, so a new valid token is never left undelivered.
    await withTransaction({
      callback: (transaction) =>
        runWithPinnedDatabaseHandle({
          databaseHandle: transaction as RequestScopedPostgresDatabase,
          callback: async () => {
            await this.verificationTokenRepository.invalidateAllForUser(
              user.id,
              VERIFICATION_TOKEN_TYPE.PASSWORD_RESET,
            );
            await this.verificationTokenRepository.create(
              VERIFICATION_TOKEN_TYPE.PASSWORD_RESET,
              user.id,
              user.email,
              tokenHash,
              expiresAt,
            );
            await eventBus.emitStrict({
              type: AUTH_EVENT.PASSWORD_RESET_REQUESTED,
              payload: {
                email: user.email,
                reset_token: rawToken,
                expires_in_minutes: PASSWORD_RESET_EXPIRES_IN_MINUTES,
                locale,
              } satisfies PasswordResetEmailPayload,
              timestamp: new Date(),
            });
          },
        }),
    });
  }

  /**
   * PASSWORD-ROUTES-DISABLED — `POST /auth/password/reset`: consumes the reset token, sets the new
   * password, revokes every session and signs the user straight back in (or answers the MFA
   * challenge — a reset never bypasses MFA).
   */
  async resetPassword({
    body,
    ipAddress,
    userAgent,
  }: {
    body: unknown;
    ipAddress: string;
    userAgent?: string | undefined;
  }): Promise<PasswordResetResult> {
    const parsed = validateResetPassword(body);
    const tokenHash = createHash('sha256').update(parsed.token).digest('hex');
    // argon2 is CPU-bound: hash before the transaction holds a pooled connection.
    const passwordHash = await hashPassword(parsed.password);

    const user = await withTransaction({
      callback: (transaction) =>
        runWithPinnedDatabaseHandle({
          databaseHandle: transaction as RequestScopedPostgresDatabase,
          callback: async () => {
            const record = await this.verificationTokenRepository.consumeIfValid(
              tokenHash,
              VERIFICATION_TOKEN_TYPE.PASSWORD_RESET,
            );
            if (!record) {
              throw new UnauthorizedError('errors:invalidOrExpiredResetToken');
            }
            const owner = await this.userService.findById(record.user_id);
            if (!owner) throw new NotFoundError('User');

            await this.userService.updatePassword({
              public_id: owner.public_id,
              password_hash: passwordHash,
            });
            // The token was delivered to the email, so completing the reset proves control of it.
            await this.userService.updateEmailVerified(owner.public_id);
            const recovered = await this.userService.updateLoginAttempt({
              public_id: owner.public_id,
              failed_login_count: 0,
              account_locked_until: null,
            });
            await this.verificationTokenRepository.invalidateAllForUser(
              owner.id,
              VERIFICATION_TOKEN_TYPE.PASSWORD_RESET,
            );
            // A reset is the recovery path of a possibly compromised account: end every session.
            await this.authSessionService.revokeAllSessions(owner.public_id);
            return recovered ?? owner;
          },
        }),
    });

    assertUserAccountActive({ status: user.status, deleted_at: user.deleted_at });
    const loginResult = await this.signIn({ user, ipAddress, userAgent });
    return { userPublicId: user.public_id, loginResult };
  }

  /**
   * PASSWORD-ROUTES-DISABLED — `POST /auth/password/change`: re-verifies the current password, sets
   * the new one and revokes every other session (all of them without a current token), atomically.
   */
  async changePassword({
    userPublicId,
    body,
    currentAccessToken,
  }: {
    userPublicId: string;
    body: unknown;
    currentAccessToken?: string | undefined;
  }): Promise<void> {
    const parsed = validateChangePassword(body);
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user.password_hash) throw new UnauthorizedError('errors:passwordAuthNotEnabled');
    const { valid } = await verifyPassword({
      plaintext: parsed.current_password,
      storedHash: user.password_hash,
    });
    if (!valid) throw new UnauthorizedError('errors:currentPasswordIncorrect');
    const passwordHash = await hashPassword(parsed.new_password);

    // The password update and the session revocation are one atomic unit.
    await withTransaction({
      callback: (transaction) =>
        runWithPinnedDatabaseHandle({
          databaseHandle: transaction as RequestScopedPostgresDatabase,
          callback: async () => {
            const updatedUser = await this.userService.updatePassword({
              public_id: user.public_id,
              password_hash: passwordHash,
            });
            if (!updatedUser) throw new NotFoundError('User');
            if (currentAccessToken) {
              await this.authSessionService.revokeAllSessionsExceptCurrent({
                userPublicId: user.public_id,
                currentAccessToken,
              });
            } else {
              await this.authSessionService.revokeAllSessions(user.public_id);
            }
          },
        }),
    });
  }
}
