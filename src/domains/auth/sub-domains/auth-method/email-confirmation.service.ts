import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_LANGUAGE, type SupportedLanguage } from '@/shared/constants/i18n.constants.js';
import { ConflictError, RateLimitedError, ValidationError } from '@/shared/errors/index.js';
import {
  MILLISECONDS_PER_HOUR,
  MILLISECONDS_PER_SECOND,
} from '@/shared/constants/ttl.constants.js';
import { eventBus } from '@/core/events/event-bus.js';
import { withTransaction } from '@/infrastructure/database/transaction.js';
import {
  runWithPinnedDatabaseHandle,
  type RequestScopedPostgresDatabase,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { UserService } from '@/domains/user/user.service.js';
import {
  validateEmailConfirm,
  validateRequestEmailConfirmation,
} from '@/domains/auth/auth.validator.js';
import {
  EMAIL_CONFIRM_LINK_HOURS,
  EMAIL_CONFIRMATION_FAILURE_REASON,
  VERIFICATION_TOKEN_TYPE,
} from '@/domains/auth/sub-domains/auth-method/auth-method.constants.js';
import { VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS } from '@/domains/auth/sub-domains/auth-method/verification-code.js';
import {
  AUTH_EVENT,
  type EmailConfirmLinkPayload,
} from '@/domains/auth/sub-domains/auth-method/events/auth.events.js';
import type { VerificationTokenRepository } from './verification-token/verification-token.repository.js';

/** Bytes of CSPRNG entropy in a confirm-email link token (base64url-encoded on the wire). */
const EMAIL_CONFIRM_TOKEN_BYTES = 32;

/** SHA-256 hex of a confirm-email link token — the only form `auth.verification_tokens` stores. */
function hashEmailConfirmToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** `400 email_confirm_token_invalid` — the token is unknown, spent, expired or its person is gone (UN7). */
function emailConfirmTokenInvalidError(): ValidationError {
  return new ValidationError('errors:emailConfirmTokenInvalid', undefined, undefined, [
    { field: 'token', messageKey: 'errors:emailConfirmTokenInvalid' },
  ]).withReason(EMAIL_CONFIRMATION_FAILURE_REASON.EMAIL_CONFIRM_TOKEN_INVALID);
}

/**
 * What `POST /users/me/email-confirmation` answers: when a new link may be asked, and when this one ends.
 *
 * @remarks
 * - **Notes:** serialized by `UserSerializer.emailConfirmationSent` (`expires_at` as ISO-8601).
 */
export interface EmailConfirmationSent {
  resend_after_seconds: number;
  expires_at: Date;
}

/**
 * What `POST /auth/email/confirm` answers, plus the person it confirmed (for the audit row).
 *
 * @remarks
 * - **Notes:** `user_public_id` never reaches the response — the public route answers only
 *   `{ is_email_verified: true }` (`AuthSerializer.emailConfirmed`); it names the audit actor.
 */
export interface EmailConfirmed {
  is_email_verified: true;
  user_public_id: string;
}

/**
 * Confirm your email (feat-instagram-dm-sending § 11.B, UN6–UN7): emails a one-use confirm link to
 * the signed-in person and confirms the email with the link's token.
 *
 * @remarks
 * - **Algorithm:** `requestLink` — the person's email already confirmed → `409`; their newest
 *   `EMAIL_CONFIRM` token made under {@link VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS} ago → `429`
 *   with the wait; else, in one pinned transaction, end their live links, store the SHA-256 of a
 *   fresh 32-byte token for {@link EMAIL_CONFIRM_LINK_HOURS} hours and emit
 *   `AUTH_EVENT.EMAIL_CONFIRM_LINK_REQUESTED`, whose handler records the email in the mail outbox
 *   in the same transaction. `confirm` — in one pinned transaction, atomically consume the token
 *   (`consumeIfValid(hash, EMAIL_CONFIRM)`), resolve its person and set `is_email_verified`; a
 *   person already confirmed (a code sign-in did it) gets the same success with nothing changed.
 * - **Failure modes:** `409 email_already_confirmed`; `429 email_confirmation_resend_too_soon` +
 *   `retry_after_seconds` + `Retry-After`; `400 email_confirm_token_invalid` for an unknown, spent
 *   or expired token, a token whose person is deleted, or one sent to an address the person no
 *   longer has (the consume rolls back on those); `503` when mail is not configured (the new link
 *   rolls back).
 * - **Side effects:** writes `auth.verification_tokens`, `auth.users.is_email_verified` and one
 *   `mail_outbox` row (its queue dispatch is post-commit). Mints no session.
 * - **Notes:** the 60 s wait is read from Postgres (the newest link's `created_at`), so it holds
 *   across instances without Redis; two requests in the same instant can both pass and the later
 *   link ends the earlier one. The raw token leaves only through the event payload and the email.
 */
export class EmailConfirmationService {
  constructor(
    private readonly userService: UserService,
    private readonly verificationTokenRepository: VerificationTokenRepository,
  ) {}

  /** Route 133: email the signed-in person a confirm link (UN6). */
  async requestLink({
    userPublicId,
    body,
    locale,
  }: {
    userPublicId: string;
    body: unknown;
    locale?: SupportedLanguage | undefined;
  }): Promise<EmailConfirmationSent> {
    validateRequestEmailConfirmation(body);
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (user.is_email_verified) {
      throw new ConflictError('errors:emailAlreadyConfirmed').withReason(
        EMAIL_CONFIRMATION_FAILURE_REASON.EMAIL_ALREADY_CONFIRMED,
      );
    }
    const token = randomBytes(EMAIL_CONFIRM_TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + EMAIL_CONFIRM_LINK_HOURS * MILLISECONDS_PER_HOUR);

    await withTransaction({
      callback: (transaction) =>
        runWithPinnedDatabaseHandle({
          databaseHandle: transaction as RequestScopedPostgresDatabase,
          callback: async () => {
            await this.assertResendWaitOver(user.id);
            // One live link per person: a new one ends the old.
            await this.verificationTokenRepository.invalidateAllForUser(
              user.id,
              VERIFICATION_TOKEN_TYPE.EMAIL_CONFIRM,
            );
            await this.verificationTokenRepository.create(
              VERIFICATION_TOKEN_TYPE.EMAIL_CONFIRM,
              user.id,
              user.email,
              hashEmailConfirmToken(token),
              expiresAt,
            );
            await eventBus.emitStrict({
              type: AUTH_EVENT.EMAIL_CONFIRM_LINK_REQUESTED,
              payload: {
                email: user.email,
                token,
                expires_in_hours: EMAIL_CONFIRM_LINK_HOURS,
                locale: locale ?? DEFAULT_LANGUAGE,
              } satisfies EmailConfirmLinkPayload,
              timestamp: new Date(),
            });
          },
        }),
    });

    return {
      resend_after_seconds: VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS,
      expires_at: expiresAt,
    };
  }

  /** Route 134: confirm the email with the link's token (UN7). PUBLIC — the token is the proof. */
  async confirm({ body }: { body: unknown }): Promise<EmailConfirmed> {
    const parsed = validateEmailConfirm(body);
    const tokenHash = hashEmailConfirmToken(parsed.token);

    const userPublicId = await withTransaction({
      callback: (transaction) =>
        runWithPinnedDatabaseHandle({
          databaseHandle: transaction as RequestScopedPostgresDatabase,
          callback: async () => {
            const record = await this.verificationTokenRepository.consumeIfValid(
              tokenHash,
              VERIFICATION_TOKEN_TYPE.EMAIL_CONFIRM,
            );
            if (!record) throw emailConfirmTokenInvalidError();
            const user = await this.userService.findById(record.user_id);
            // The link proves control of the address it was sent to — not of a later one.
            if (!user || user.deleted_at || user.email !== record.email) {
              throw emailConfirmTokenInvalidError();
            }
            if (!user.is_email_verified) {
              await this.userService.updateEmailVerified(user.public_id);
            }
            return user.public_id;
          },
        }),
    });

    return { is_email_verified: true, user_public_id: userPublicId };
  }

  /** `429 email_confirmation_resend_too_soon` while the person's newest link is under the 60 s wait. */
  private async assertResendWaitOver(userId: number): Promise<void> {
    const newest = await this.verificationTokenRepository.findNewestForUser(
      userId,
      VERIFICATION_TOKEN_TYPE.EMAIL_CONFIRM,
    );
    if (!newest) return;
    const elapsedSeconds = Math.floor(
      (Date.now() - newest.created_at.getTime()) / MILLISECONDS_PER_SECOND,
    );
    if (elapsedSeconds >= VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS) return;
    const retryAfterSeconds = Math.max(
      1,
      VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS - elapsedSeconds,
    );
    throw new RateLimitedError('errors:emailConfirmationResendTooSoon')
      .withReason(EMAIL_CONFIRMATION_FAILURE_REASON.EMAIL_CONFIRMATION_RESEND_TOO_SOON)
      .withRetryAfter(retryAfterSeconds)
      .withFields({ retry_after_seconds: retryAfterSeconds });
  }
}
