import type { FastifyReply, FastifyRequest } from 'fastify';
import { toSupportedLanguage } from '@/shared/constants/i18n.constants.js';
import { successResponse } from '@/shared/utils/http/response.util.js';
import { getRequestIdentifier, requireAuth } from '@/shared/utils/http/request.util.js';
import { translateMessageKeyPayload } from '@/shared/utils/i18n/i18n-response.util.js';
import { recordScopedAuditEvent } from '@/shared/utils/infrastructure/audit-request-context.util.js';
import { getUserAgent } from '@/shared/utils/http/user-agent.util.js';
import { getIpAddress, setSessionCookie } from '@/domains/auth/auth.http.util.js';
import { AuthSerializer } from '@/domains/auth/auth.serializer.js';
import {
  recordLoginAuditEvent,
  recordLoginFailureAuditEvent,
} from '@/domains/auth/shared/audit-login.util.js';
import type { FirstFactorAuthResult } from '@/domains/auth/shared/complete-first-factor-auth.js';
import { ACCOUNT_SECURITY_NOTICE } from '@/domains/auth/sub-domains/auth-method/events/auth.events.js';
import type { AuthContainer } from '@/domains/auth/auth.container.js';

type AuthPasswordHandlersDependencies = Pick<
  AuthContainer,
  'passwordAuthService' | 'authMethodService'
>;

/** Answers a first-factor result: the MFA challenge, or the access token with the session cookie set. */
async function sendFirstFactorResult({
  request,
  reply,
  data,
}: {
  request: FastifyRequest;
  reply: FastifyReply;
  data: FirstFactorAuthResult;
}) {
  if ('mfa_required' in data) {
    return successResponse({
      data: AuthSerializer.mfaRequired(data),
      request_id: getRequestIdentifier(request),
    });
  }
  setSessionCookie({
    reply,
    sessionPublicId: data.session_public_id,
    refreshSecret: data.session_refresh_secret,
  });
  await recordLoginAuditEvent({ request, loginResult: data, source: 'password' });
  return successResponse({
    data: AuthSerializer.accessToken(data),
    request_id: getRequestIdentifier(request),
  });
}

/**
 * PASSWORD-ROUTES-DISABLED — builds the four password route handlers (`login`, `forgotPassword`,
 * `resetPassword`, `changePassword`), restored from R30. The routes that call them are registered
 * only when `PASSWORD_ROUTES_ENABLED` is true (owner instruction 2026-11-25, P251).
 */
export function createAuthPasswordHandlers({
  passwordAuthService,
  authMethodService,
}: AuthPasswordHandlersDependencies) {
  return {
    login: async (request: FastifyRequest, reply: FastifyReply) => {
      let data: FirstFactorAuthResult;
      try {
        data = await passwordAuthService.login({
          body: request.body,
          ipAddress: getIpAddress(request),
          userAgent: getUserAgent(request) ?? undefined,
        });
      } catch (error) {
        // The failure side of "every login (success or failure) records a row"; never throws.
        await recordLoginFailureAuditEvent({ request, source: 'password', error });
        throw error;
      }
      return sendFirstFactorResult({ request, reply, data });
    },
    forgotPassword: async (request: FastifyRequest, _reply: FastifyReply) => {
      const data = await passwordAuthService.forgotPassword({
        body: request.body,
        context: { locale: toSupportedLanguage(request.language) },
      });
      return successResponse({
        data: translateMessageKeyPayload({ request, payload: data }),
        request_id: getRequestIdentifier(request),
      });
    },
    resetPassword: async (request: FastifyRequest, reply: FastifyReply) => {
      const { userPublicId, loginResult } = await passwordAuthService.resetPassword({
        body: request.body,
        ipAddress: getIpAddress(request),
        userAgent: getUserAgent(request) ?? undefined,
      });
      // A completed reset is a credential change — its own WARNING row, attributed to the user.
      await recordScopedAuditEvent({
        request,
        input: {
          actorUserPublicId: userPublicId,
          action: 'auth.password.reset',
          resource_type: 'user',
          severity: 'WARNING',
        },
      });
      await authMethodService.sendAccountSecurityNotice({
        userPublicId,
        notice: ACCOUNT_SECURITY_NOTICE.PASSWORD_CHANGED,
        locale: toSupportedLanguage(request.language),
      });
      return sendFirstFactorResult({ request, reply, data: loginResult });
    },
    changePassword: async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = requireAuth(request);
      const currentAccessToken = request.headers.authorization?.match(/^Bearer\s+(\S.*)$/i)?.[1];
      await passwordAuthService.changePassword({
        userPublicId: auth.userId,
        body: request.body,
        currentAccessToken,
      });
      await recordScopedAuditEvent({
        request,
        input: {
          actorUserPublicId: auth.userId,
          action: 'auth.password.change',
          resource_type: 'user',
        },
      });
      await authMethodService.sendAccountSecurityNotice({
        userPublicId: auth.userId,
        notice: ACCOUNT_SECURITY_NOTICE.PASSWORD_CHANGED,
        locale: toSupportedLanguage(request.language),
      });
      return reply.code(204).send();
    },
  };
}
