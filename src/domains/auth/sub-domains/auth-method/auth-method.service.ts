import type { SupportedLanguage } from '@/shared/constants/i18n.constants.js';
import { ConflictError, ForbiddenError, NotFoundError } from '@/shared/errors/index.js';
import { MAX_LINKED_AUTH_METHODS_PER_USER } from '@/shared/constants/security.constants.js';
import { WebauthnCredentialRepository } from '@/domains/auth/sub-domains/auth-webauthn/webauthn-credential.repository.js';
import { eventBus } from '@/core/events/event-bus.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { UserService } from '@/domains/user/user.service.js';
import {
  AUTH_EVENT,
  type AccountSecurityNotice,
  type AccountSecurityNoticePayload,
} from '@/domains/auth/sub-domains/auth-method/events/auth.events.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import { AUTH_METHOD_TYPE } from '@/domains/auth/sub-domains/auth-method/auth-method.constants.js';
import type { AuthMethodCreateData } from './auth-method.types.js';
import type { AuthMethodRepository } from './auth-method.repository.js';
import type { VerificationTokenRepository } from './verification-token/verification-token.repository.js';
import { validateCreateAuthMethod } from '@/domains/auth/auth.validator.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

/**
 * Auth-method types that can mint a session on their own (sec-A5). Used by
 * {@link AuthMethodService.delete} to refuse revoking the user's last login surface.
 * MFA types are intentionally excluded — they are second factors and never the only
 * credential a user has, and `PASSWORD` is off everywhere (P84 — its rows are revoked).
 */
const LOGIN_CAPABLE_METHOD_TYPES = new Set<string>([
  AUTH_METHOD_TYPE.OAUTH,
  AUTH_METHOD_TYPE.EMAIL_CODE,
]);

/**
 * Owns the lifecycle of {@link auth_methods} rows — a person's ways in (the email code, OAuth, the
 * MFA factors) — and the account-security notices about them.
 *
 * @remarks
 * - **Algorithm:** authenticated callers manage their linked auth methods
 *   (OAUTH / EMAIL_CODE / MFA_TOTP) via `list` / `create` / `delete`. Passwords are off everywhere
 *   (P84): no password is set, checked or reset here, and the `PASSWORD` rows are revoked by the
 *   `auth_passwords_off` migration.
 * - **Failure modes:** unknown users surface `NotFoundError`; removing the email-code way is
 *   `409 email_code_always_on`; removing the last login-capable way is `403`.
 * - **Side effects:** revokes rows in `auth.auth_methods`; emits
 *   `AUTH_EVENT.ACCOUNT_SECURITY_NOTICE_REQUESTED` (mail enqueue happens in the auth-method event
 *   handlers).
 * - **Notes:** OAuth linkage is idempotent via {@link AuthMethodService.linkOAuthProviderIfMissing}.
 */
export class AuthMethodService {
  constructor(
    private readonly userService: UserService,
    private readonly authMethodRepository: AuthMethodRepository,
    private readonly verificationTokenRepository: VerificationTokenRepository,
    private readonly webauthnCredentialRepository: WebauthnCredentialRepository = new WebauthnCredentialRepository(),
  ) {}

  async list(userPublicId: string) {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    // auth.auth_methods is FORCE RLS (audit #7); pin the owner context so the owner policy authorizes
    // the read for this user's own credentials.
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }),
      callback: () => this.authMethodRepository.listByUserId(user.id),
    });
  }

  /**
   * Whether the user retains at least one active login-capable auth method
   * (`OAUTH` / `EMAIL_CODE`) — i.e. a way to authenticate that does NOT depend on a
   * passkey.
   *
   * @remarks
   * - **Algorithm:** lists the user's active `auth_methods` under the owner DB context and tests
   *   membership in {@link LOGIN_CAPABLE_METHOD_TYPES} (the same set used by the last-method delete
   *   guard). MFA factors (`MFA_TOTP`) are second factors and are intentionally excluded.
   * - **Failure modes:** `NotFoundError` when the user record is missing.
   * - **Side effects:** transient owner-scoped DB context only.
   * - **Notes:** sec-r5-M3 — consulted by {@link WebauthnService.revokeCredential} so a passkey-only
   *   user cannot delete their last passkey and lock themselves out, while a user with an
   *   OAuth / email-code method may remove every passkey.
   */
  async hasLoginCapableMethod(userPublicId: string): Promise<boolean> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    const methods = await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }),
      callback: () => this.authMethodRepository.listByUserId(user.id),
    });
    return methods.some((method) => LOGIN_CAPABLE_METHOD_TYPES.has(String(method.method_type)));
  }

  /**
   * Whether the user holds ANY active authentication credential — a login-capable `auth_methods`
   * row (`OAUTH` / `EMAIL_CODE`) **or** an active WebAuthn passkey. Used to decide
   * whether a pre-existing account is a still-unclaimed bare invited placeholder (and therefore
   * safe to claim via OAuth / signup) vs. a real account that must never be silently merged into.
   *
   * @remarks
   * - **Algorithm:** under the owner DB context, short-circuits on the first login-capable
   *   `auth_methods` row; otherwise checks for at least one non-revoked `webauthn_credentials` row.
   *   Both tables are FORCE RLS keyed on the owner, so the read runs inside `withAppDatabaseContext (user scope)`.
   * - **Failure modes:** `NotFoundError` when the user record is missing.
   * - **Side effects:** transient owner-scoped DB context only.
   * - **Notes:** unlike {@link AuthMethodService.hasLoginCapableMethod} (which intentionally EXCLUDES
   *   passkeys so a passkey-only user can still delete their last passkey), this counts passkeys —
   *   the account-claim guards must treat a passkey-only account as a real, non-bare account so
   *   takeover safety does not rely on the implicit "passkey ⇒ verified email" invariant.
   *   A-7 — an `EMAIL_CODE` row on a still-unverified email is not counted: the first code sign-in
   *   verifies the email, so that row was never used — it is what `POST /auth/email/send-code`
   *   leaves behind for an address anyone can type, and counting it let a stranger's send-code block
   *   the owner's OAuth sign-in.
   */
  async hasActiveLoginCredential(userPublicId: string): Promise<boolean> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    const isCountedMethod = (methodType: string): boolean =>
      LOGIN_CAPABLE_METHOD_TYPES.has(methodType) &&
      (user.is_email_verified || methodType !== AUTH_METHOD_TYPE.EMAIL_CODE);
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }),
      callback: async () => {
        const methods = await this.authMethodRepository.listByUserId(user.id);
        if (methods.some((method) => isCountedMethod(String(method.method_type)))) {
          return true;
        }
        const passkeys = await this.webauthnCredentialRepository.listActiveByUserId(user.id);
        return passkeys.length > 0;
      },
    });
  }

  async create({ userPublicId, body }: { userPublicId: string; body: unknown }) {
    // route-#3: the DTO restricts method_type to EMAIL_CODE — the only type that is a functional
    // credential-less row. MFA_* (need a stored secret) and OAUTH (proves an external
    // identity, written only by the verified callback) are rejected at validation, so none can be
    // inserted here as non-functional phantom rows that the last-credential guard would miscount.
    const parsed = validateCreateAuthMethod(body);
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }),
      callback: async () => {
        // Serialize the count + insert under the same per-user credential-mutation advisory lock the
        // delete guard uses, so concurrent creates cannot both pass the cap check and overshoot
        // MAX_LINKED_AUTH_METHODS_PER_USER. The xact lock auto-releases at commit.
        await this.authMethodRepository.acquireCredentialMutationLock(user.id);
        const activeCount = await this.authMethodRepository.countActiveByUserId(user.id);
        if (activeCount >= MAX_LINKED_AUTH_METHODS_PER_USER) {
          throw new ConflictError('errors:authMethodMaxReached', {
            max: MAX_LINKED_AUTH_METHODS_PER_USER,
          });
        }
        return this.authMethodRepository.create(
          omitUndefined({
            user_id: user.id,
            method_type: parsed.method_type,
            is_primary: parsed.is_primary,
            created_by_user_id: user.id,
          }),
        );
      },
    });
  }

  /**
   * Revokes a user's auth method identified by its opaque `public_id` (sec-new-B4).
   *
   * @remarks
   * AT13 (AC-13.4): the email-code way is always on — revoking an `EMAIL_CODE` row is refused with
   * `409 email_code_always_on`. sec-A5: refuses to revoke the user's LAST login-capable credential.
   * Login-capable types are `OAUTH` and `EMAIL_CODE` (server-issued auth methods of those
   * kinds) — MFA factors (`MFA_TOTP`, `MFA_SMS`, `MFA_EMAIL`) are second factors and
   * never grant a session on their own, so revoking the last MFA method is permitted
   * here (the organization-policy guard on `MfaService.deleteMfa` covers the MFA-required-by-organization
   * case — sec-A4). Without this guard, a user could revoke their only OAUTH
   * and lock themselves out of every login surface — recovery requires admin intervention.
   */
  async delete({ userPublicId, methodPublicId }: { userPublicId: string; methodPublicId: string }) {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }),
      callback: async () => {
        const existing = await this.authMethodRepository.findByPublicIdForUser(
          methodPublicId,
          user.id,
        );
        if (!existing) throw new NotFoundError('Auth method');
        if (existing.method_type === AUTH_METHOD_TYPE.EMAIL_CODE) {
          throw new ConflictError('errors:emailCodeAlwaysOn').withReason('email_code_always_on');
        }
        const isLoginCapable = LOGIN_CAPABLE_METHOD_TYPES.has(existing.method_type);
        // Atomic count-aware revoke: the "is another login-capable method still active?" check and
        // the revoke run in ONE statement, so two concurrent deletes cannot each see "one other left"
        // and both succeed, zeroing out the user's credentials (route-audit C1 lockout race).
        const revoked = await this.authMethodRepository.revokeUnlessLastLoginCapable(
          existing.id,
          user.id,
          [...LOGIN_CAPABLE_METHOD_TYPES],
        );
        if (!revoked) {
          // `existing` was found above, so a zero-row update means either the last-login-capable guard
          // tripped (for a login-capable method) or the row was concurrently revoked.
          if (isLoginCapable) throw new ForbiddenError('errors:cannotRemoveLastAuthMethod');
          throw new NotFoundError('Auth method');
        }
      },
    });
  }

  async revokeAllForUser(userPublicId: string): Promise<void> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }),
      callback: () => this.authMethodRepository.revokeAllByUserId(user.id),
    });
  }

  /**
   * Invalidate every outstanding verification token (email-code, email-
   * verify, email-change) for a user. Called by the user-offboarding sequence (sec-U1)
   * so a token issued seconds before soft-delete cannot be redeemed to mint a session
   * for the deleted user.
   *
   * @remarks
   * Runs inside `withAppDatabaseContext (user scope)` so the RLS-scoped UPDATE only touches rows
   * owned by the target user; the operation is idempotent (already-used or expired
   * tokens are no-ops). Safe to call at any point in the offboarding sequence — there is
   * no rollback risk because invalidation is a strict superset of natural token expiry.
   */
  async invalidateAllVerificationTokensForUser(userPublicId: string): Promise<void> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }),
      callback: () => this.verificationTokenRepository.invalidateAllByUser(user.id),
    });
  }

  /**
   * Whether the user turned a login method off: they hold a revoked `methodType` row (of `provider`,
   * for OAuth) and no active one.
   *
   * @remarks
   * - **Algorithm:** one aggregate read of the user's `auth_methods` rows of that type, revoked ones
   *   included, under the owner database context.
   * - **Failure modes:** none — a user who never held the method reads `false`.
   * - **Side effects:** none.
   * - **Notes:** A-5 — removing the email-code or an OAuth method used to leave that login path
   *   open (email-code login never looked at the method; OAuth re-linked a fresh row). The email-code
   *   and OAuth sign-ins consult this and refuse a turned-off method. A user who never held the row
   *   (an older account signing in by email code) is unaffected.
   */
  async isLoginMethodTurnedOff({
    userPublicId,
    userId,
    methodType,
    provider,
  }: {
    userPublicId: string;
    userId: number;
    methodType: string;
    provider?: string;
  }): Promise<boolean> {
    const state = await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId }),
      callback: () =>
        this.authMethodRepository.findMethodRevocationState(userId, methodType, provider),
    });
    return state.hasRevoked && !state.hasActive;
  }

  /**
   * Emails the account owner that their account changed — a new second factor or passkey, every
   * other session signed out — with a "this wasn't me" line.
   *
   * @remarks
   * - **Algorithm:** resolves the owner's address, then emits
   *   `AUTH_EVENT.ACCOUNT_SECURITY_NOTICE_REQUESTED`; the auth-method event handler records the
   *   outbox email in `locale`.
   * - **Failure modes:** none surfaced — best-effort: the change has already happened, so a missing
   *   user or a failed enqueue is logged, never thrown.
   * - **Side effects:** a `mail_outbox` row and its post-commit dispatch.
   * - **Notes:** A-1 — brief access to the mailbox of a passwordless account could enroll a factor
   *   or sign the owner out everywhere unseen; the notice tells the owner at once.
   */
  async sendAccountSecurityNotice({
    userPublicId,
    notice,
    locale,
  }: {
    userPublicId: string;
    notice: AccountSecurityNotice;
    locale: SupportedLanguage;
  }): Promise<void> {
    try {
      const user = await this.userService.findUserRecordByPublicId(userPublicId);
      if (!user) return;
      await eventBus.emit({
        type: AUTH_EVENT.ACCOUNT_SECURITY_NOTICE_REQUESTED,
        payload: { email: user.email, notice, locale } satisfies AccountSecurityNoticePayload,
        timestamp: new Date(),
      });
    } catch (error) {
      logger.warn({ error, notice }, 'auth.account_security_notice.failed');
    }
  }

  async findByProviderUserId({
    provider,
    provider_user_id,
  }: {
    provider: string;
    provider_user_id: string;
  }) {
    return this.authMethodRepository.findByProviderUserId(provider, provider_user_id);
  }

  async linkOAuthProviderIfMissing({
    ownerPublicId,
    data,
  }: {
    ownerPublicId: string;
    data: AuthMethodCreateData;
  }): Promise<void> {
    if (!(data.provider && data.provider_user_id)) {
      return;
    }
    // findByProviderUserId goes through the SECURITY DEFINER resolver (pre-session safe); the INSERT
    // must satisfy the owner WITH CHECK, so pin the owner context for the linkage write.
    const existing = await this.authMethodRepository.findByProviderUserId(
      data.provider,
      data.provider_user_id,
    );
    if (!existing) {
      await withAppDatabaseContext({
        scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: ownerPublicId }),
        callback: () => this.authMethodRepository.create(data),
      });
    }
  }

  async findTotpByUserId(user_id: number) {
    return this.authMethodRepository.findTotpByUserId(user_id);
  }

  async createAuthMethodRecord(data: AuthMethodCreateData) {
    return this.authMethodRepository.create(data);
  }

  /**
   * Creates the user's `EMAIL_CODE` auth_method row during email verification-code auto-signup.
   *
   * @remarks
   * - **Algorithm:** inserts one `method_type=EMAIL_CODE` row owned by the user, pinning the owner
   *   `withAppDatabaseContext (user scope)` so the FORCE-RLS owner WITH CHECK authorizes the write. Intended to
   *   run inside the auto-signup pinned transaction so it commits atomically with the user row.
   * - **Failure modes:** propagates the insert error (e.g. a CHECK/constraint violation) to roll the
   *   auto-signup transaction back.
   * - **Side effects:** one `auth.auth_methods` insert.
   * - **Notes:** `EMAIL_CODE` is a functional credential-less row (no stored secret), so an
   *   email-code-only user has a real login-capable method that appears in
   *   `GET /auth/me/auth-methods` and is counted by the last-login-capable-credential guard.
   */
  async createEmailCodeMethod({
    userId,
    userPublicId,
  }: {
    userId: number;
    userPublicId: string;
  }): Promise<void> {
    await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }),
      callback: () =>
        this.authMethodRepository.create({
          user_id: userId,
          method_type: AUTH_METHOD_TYPE.EMAIL_CODE,
          is_primary: true,
          created_by_user_id: userId,
        }),
    });
  }

  async updateAuthMethodLastUsedAt({
    methodId,
    userId,
  }: {
    methodId: number;
    userId: number;
  }): Promise<void> {
    await this.authMethodRepository.updateLastUsedAt(methodId, userId);
  }

  async findAuthMethodByIdForUser({ methodId, userId }: { methodId: number; userId: number }) {
    return this.authMethodRepository.findByIdForUser(methodId, userId);
  }

  /** route-#10: resolves an auth method by its opaque public id (scoped to the owning user). */
  async findAuthMethodByPublicIdForUser({
    methodPublicId,
    userId,
  }: {
    methodPublicId: string;
    userId: number;
  }) {
    return this.authMethodRepository.findByPublicIdForUser(methodPublicId, userId);
  }

  async listMfaMethodsByUserId(userId: number) {
    return this.authMethodRepository.listMfaByUserId(userId);
  }

  /**
   * Serializes concurrent credential mutations for one user via a transaction-scoped advisory lock.
   * Must be called inside the caller's `withAppDatabaseContext (user scope)` transaction, before a
   * count-then-mutate, so concurrent requests cannot interleave the count and the write.
   */
  async acquireCredentialMutationLock(userId: number): Promise<void> {
    await this.authMethodRepository.acquireCredentialMutationLock(userId);
  }

  async revokeAuthMethod({
    methodId,
    userId,
  }: {
    methodId: number;
    userId: number;
  }): Promise<void> {
    const revoked = await this.authMethodRepository.revoke(methodId, userId);
    if (!revoked) throw new NotFoundError('Auth method');
  }
}
