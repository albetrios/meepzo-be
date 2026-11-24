import { ForbiddenError, NotFoundError, UnauthorizedError } from '@/shared/errors/index.js';
import { resolveAccessTokenRoleForUser } from '@/shared/utils/auth/global-admin-role.util.js';
import { MFA_AUTHENTICATION_METHOD, signAccessToken } from '@/shared/utils/security/jwt.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { AuthSessionService } from './sub-domains/auth-session/auth-session.service.js';
import {
  findSessionLapse,
  SESSION_LAPSE_REASON,
} from './sub-domains/auth-session/session-lifetime.js';
import {
  resolveDefaultActiveOrganizationPublicId,
  findUserActiveOrganizationByPublicId,
  findUserActiveOrganizationPublicIdByInternalId,
  ensurePersonalOrganization,
  resolvePersonalOrganizationPublicId,
} from '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js';
import { organizationRequiresMfa } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-mfa-policy.js';
import type { UserAuthRecord } from '@/domains/user/user.types.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

/**
 * Session lifecycle orchestrator of the auth domain: logout, refresh, and switching the active
 * organization. Sign-in itself lives in the first-factor services (email code, OAuth, passkey) —
 * passwords are off (P84), so this class verifies no credential.
 *
 * @remarks
 * - **Algorithm:** refresh validates the session cookie and rotates the session's hash; the switch
 *   routes re-mint the access token with the new `org` claim after checking membership and the
 *   organization's MFA policy.
 * - **Failure modes:** expired/revoked session → `UnauthorizedError('errors:invalidOrExpiredSession')`;
 *   an inactive user → `UnauthorizedError('errors:accountNotActive')`; a 2FA organization without
 *   an MFA-verified session → `ForbiddenError`.
 * - **Side effects:** rotates and revokes rows in `auth.sessions` via {@link AuthSessionService}.
 * - **Notes:** access tokens are signed RS256 with a SHA-256 hash persisted on the
 *   session row (refresh uses the session, not the JWT, as the source of truth).
 */
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly authSessionService: AuthSessionService,
  ) {}

  async logout(token: string): Promise<void> {
    await this.authSessionService.revokeSessionByAccessToken(token);
  }

  async refreshToken({
    sessionPublicId,
    refreshSecret,
    ipAddress,
  }: {
    sessionPublicId: string;
    refreshSecret: string;
    /** The refreshing request's IP — a new one moves the session's address and place (§ 10.D AT18). */
    ipAddress?: string;
  }): Promise<{ access_token: string; refresh_secret: string }> {
    // sec-re-05: look the session up via the INCLUDING-REVOKED path so a
    // refresh-secret replay against an already-revoked session reaches
    // `refreshSessionCredentials`'s reuse-detection block (the sec-A #9
    // `findByPublicIdIncludingRevoked` lookup). The prior
    // `findActiveSessionByPublicId` filtered `is_revoked = true` rows out
    // here and threw `errors:invalidOrExpiredSession` before the rotation
    // ran — silently disabling the Sentry `auth.refresh_token.reuse_detected`
    // signal exactly when it is most informative. Revoked sessions still
    // fail to refresh because `refreshSessionCredentials`'s rotation UPDATE
    // filters `is_revoked = false` internally and throws after firing the
    // reuse-detection block.
    const session =
      await this.authSessionService.findSessionByPublicIdIncludingRevoked(sessionPublicId);
    if (!session) {
      throw new UnauthorizedError('errors:invalidOrExpiredSession');
    }

    // E-2: the server owns the idle and absolute limits. A live session idle past
    // AUTH_SESSION_IDLE_TIMEOUT_SECONDS, or older than AUTH_SESSION_ABSOLUTE_TIMEOUT_SECONDS, is
    // revoked and refused with the `error.reason` meepzo-fe reads to say why. A revoked row skips
    // this and reaches the reuse detection below (sec-re-05).
    if (!session.is_revoked) {
      const lapse = findSessionLapse({
        createdAt: session.created_at,
        lastActiveAt: session.last_active_at,
        expiresAt: session.expires_at,
      });
      if (lapse !== null) {
        await this.authSessionService.revokeLapsedSession({
          sessionPublicId,
          userId: session.user_id,
        });
        throw new UnauthorizedError(
          lapse === SESSION_LAPSE_REASON.IDLE_TIMEOUT
            ? 'errors:sessionIdleTimeout'
            : 'errors:sessionExpired',
        ).withReason(lapse);
      }
    }

    if (new Date(session.expires_at) <= new Date()) {
      throw new UnauthorizedError('errors:sessionExpired').withReason(
        SESSION_LAPSE_REASON.SESSION_EXPIRED,
      );
    }

    const user = await this.userService.findById(session.user_id);
    if (!user) throw new UnauthorizedError('errors:userNotFound');

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedError('errors:accountNotActive');
    }

    // audit-#3: preserve the organization the caller switched to. The selected organization is
    // persisted on the session (`organization_id`) by `rebindAccessToken`; refresh must
    // revalidate it (the user could have lost membership, or the organization could have been
    // deleted/suspended) and only fall back to the default when it is no longer valid —
    // never silently move the caller to a different tenant while the UI still shows A.
    const sessionMfaVerified = session.mfa_verified_at != null;
    const signForSessionOrganization = async (organizationInternalId: number | null) => {
      const persistedOrganizationPublicId =
        organizationInternalId != null
          ? await findUserActiveOrganizationPublicIdByInternalId({
              userInternalId: user.id,
              organizationInternalId,
            })
          : undefined;
      const organizationPublicId = await this.withoutUnmetOrganizationMfa({
        userId: user.id,
        organizationPublicId:
          persistedOrganizationPublicId ??
          (await resolveDefaultActiveOrganizationPublicId(user.id)),
        sessionMfaVerified,
      });
      return signAccessToken({
        userId: user.public_id,
        role: resolveAccessTokenRoleForUser({
          email: user.email,
          status: user.status,
          isEmailVerified: user.is_email_verified,
          isMfaEnabled: user.is_mfa_enabled,
        }),
        organizationPublicId,
        authenticationMethods: sessionMfaVerified ? [MFA_AUTHENTICATION_METHOD] : undefined,
      });
    };

    const jsonWebToken = await signForSessionOrganization(session.organization_id);
    const rotated = await this.authSessionService.refreshSessionCredentials({
      sessionPublicId,
      userPublicId: user.public_id,
      refreshSecret,
      nextAccessToken: jsonWebToken,
      ipAddress,
    });

    // One live access token per session: a switch that committed between the read above and the
    // rotation moved the session to another organization, and the token just made live names the
    // one the caller left. Mint for the organization the session now names and swap it in. A
    // switch always names an organization, so a null here is never a move.
    if (rotated.organization_id == null || rotated.organization_id === session.organization_id) {
      return { access_token: jsonWebToken, refresh_secret: rotated.refresh_secret };
    }
    const movedAccessToken = await signForSessionOrganization(rotated.organization_id);
    await this.authSessionService.replaceRefreshedAccessToken({
      sessionPublicId,
      refreshedAccessToken: jsonWebToken,
      nextAccessToken: movedAccessToken,
    });
    return { access_token: movedAccessToken, refresh_secret: rotated.refresh_secret };
  }

  /**
   * Switch the active organization to a TEAM (or any) organization the caller is an active
   * member of: validate membership, re-mint the access token with the new `org` claim, re-bind
   * the session to it, then remember it as the caller's login default. Rejects with 403 when the
   * caller is not an active member.
   *
   * @remarks
   * Remembering (`auth.users.last_active_organization_id`, read back by
   * `resolveDefaultActiveOrganizationPublicId`) runs after the session is re-bound and is
   * best-effort: the old token is already retired, so failing the response here would strand the
   * client without its new one. A failure is logged and the next switch writes it again.
   */
  async switchToOrganization({
    userPublicId,
    sessionPublicId,
    organizationPublicId,
  }: {
    userPublicId: string;
    sessionPublicId: string;
    organizationPublicId: string;
  }): Promise<{ access_token: string; organization_public_id: string }> {
    // Both reads below run under `app.current_user_public_id` set to the SAME value, so they share one
    // context instead of opening a transaction each. `findUserActiveOrganizationByPublicId` takes
    // an INTERNAL id and resolves it back to the public id we already hold — inside the shared
    // context that resolve is a plain query on an open checkout rather than a second BEGIN.
    //
    // `mintForActiveOrganization` stays OUTSIDE deliberately. It re-binds the session under
    // `app.current_session_public_id`, a different guc, so it must own its transaction — and
    // nesting it here would hold this checkout open across it, making the request peak at two
    // concurrent connections instead of taking them one after another.
    const { user, resolved } = await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }),
      callback: async () => {
        const record = await this.userService.requireUserRecordByPublicId(userPublicId);
        if (record.status !== 'ACTIVE') throw new UnauthorizedError('errors:accountNotActive');
        const organization = await findUserActiveOrganizationByPublicId({
          userInternalId: record.id,
          organizationPublicId,
        });
        if (!organization) throw new ForbiddenError('errors:insufficientOrganizationPermissions');
        return { user: record, resolved: organization };
      },
    });
    const switched = await this.mintForActiveOrganization({
      user,
      sessionPublicId,
      organization: resolved,
    });
    await this.userService
      .rememberLastActiveOrganization({ userPublicId, organizationId: resolved.id })
      .catch((error: unknown) => {
        logger.warn(
          { err: error, userPublicId, organizationPublicId: resolved.public_id },
          'auth.switch_to_organization.remember_failed',
        );
      });
    return switched;
  }

  /**
   * Switch the active organization to the caller's own PERSONAL organization. No body — the
   * server resolves the personal organization from the authenticated user; it can never 403
   * (you always own your personal organization). 404 only if personal is disabled / missing.
   */
  async switchToPersonal({
    userPublicId,
    sessionPublicId,
  }: {
    userPublicId: string;
    sessionPublicId: string;
  }): Promise<{ access_token: string; organization_public_id: string }> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (user.status !== 'ACTIVE') throw new UnauthorizedError('errors:accountNotActive');
    // Self-heal: provision the personal organization on demand when personal is enabled but missing,
    // so this can no longer 404 for a personal-enabled deployment. Returns undefined only when
    // personal organizations are disabled → 404 as before.
    const personal = await ensurePersonalOrganization(user);
    if (!personal) throw new NotFoundError('Personal organization');
    return this.mintForActiveOrganization({ user, sessionPublicId, organization: personal });
  }

  /**
   * Refresh must never mint authority over an organization whose security policy requires MFA
   * for a session that has not proved a second factor — the case of an invitation accepted after
   * a first-factor login, or a policy turned on later. Such an organization is replaced by the
   * user's personal organization when that one does not require MFA, otherwise by none; once the
   * session completes MFA (step-up), the next refresh returns to the persisted organization.
   */
  private async withoutUnmetOrganizationMfa(options: {
    userId: number;
    organizationPublicId: string | undefined;
    sessionMfaVerified: boolean;
  }): Promise<string | undefined> {
    const { organizationPublicId } = options;
    if (
      !organizationPublicId ||
      options.sessionMfaVerified ||
      !(await organizationRequiresMfa(organizationPublicId))
    ) {
      return organizationPublicId;
    }
    const personalOrganizationPublicId = await resolvePersonalOrganizationPublicId({
      ownerUserInternalId: options.userId,
    });
    if (
      personalOrganizationPublicId &&
      personalOrganizationPublicId !== organizationPublicId &&
      !(await organizationRequiresMfa(personalOrganizationPublicId))
    ) {
      return personalOrganizationPublicId;
    }
    return undefined;
  }

  /**
   * Mint an access token scoped to the given organization and re-bind the session to it — the
   * shared tail of both switch endpoints — persisting the active organization's internal id on the
   * session so a later `/auth/refresh` preserves the selection (audit-#3).
   *
   * @remarks
   * An organization whose security policy requires MFA admits only a session that has proved a
   * second factor (`mfa_verified_at`); otherwise this throws `403 errors:organizationRequiresMfa`
   * with reason `mfa_required`, and the client completes an MFA step-up (or enrollment) and
   * retries. The minted token carries `amr: ['mfa']` for such a session.
   */
  private async mintForActiveOrganization({
    user,
    sessionPublicId,
    organization,
  }: {
    user: UserAuthRecord;
    sessionPublicId: string;
    organization: { id: number; public_id: string };
  }): Promise<{ access_token: string; organization_public_id: string }> {
    const session = await this.authSessionService.findActiveSessionByPublicId(sessionPublicId);
    if (!session) throw new UnauthorizedError('errors:invalidOrExpiredSession');
    const sessionMfaVerified = session.mfa_verified_at != null;
    if (!sessionMfaVerified && (await organizationRequiresMfa(organization.public_id))) {
      throw new ForbiddenError('errors:organizationRequiresMfa').withReason('mfa_required');
    }
    const jsonWebToken = await signAccessToken({
      userId: user.public_id,
      role: resolveAccessTokenRoleForUser({
        email: user.email,
        status: user.status,
        isEmailVerified: user.is_email_verified,
        isMfaEnabled: user.is_mfa_enabled,
      }),
      organizationPublicId: organization.public_id,
      authenticationMethods: sessionMfaVerified ? [MFA_AUTHENTICATION_METHOD] : undefined,
    });
    await this.authSessionService.rebindAccessToken({
      sessionPublicId,
      nextAccessToken: jsonWebToken,
      activeOrganizationId: organization.id,
    });
    return {
      access_token: jsonWebToken,
      organization_public_id: organization.public_id,
    };
  }
}
