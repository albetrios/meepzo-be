import type { FastifyReply, FastifyRequest } from 'fastify';
import { successResponse } from '@/shared/utils/http/response.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import { getRequestIdentifier, requireAuth } from '@/shared/utils/http/request.util.js';
import { recordScopedAuditEvent } from '@/shared/utils/infrastructure/audit-request-context.util.js';
import {
  clearOauthNonceCookie,
  getIpAddress,
  isOauthProviderNotImplementedError,
  readOauthNonceCookie,
  sendOauthProviderNotImplementedResponse,
  setOauthNonceCookie,
  setSessionCookie,
  readTrustedDeviceCookie,
} from '@/domains/auth/auth.http.util.js';
import { getUserAgent } from '@/shared/utils/http/user-agent.util.js';
import type {
  AppleFormCallbackInput,
  OauthCallbackQueryInput,
  OauthStartQueryInput,
} from '@/domains/auth/auth.dto.js';
import { OAUTH_LINK_INTENT } from '@/domains/auth/sub-domains/auth-method/oauth/oauth.types.js';
import { AuthSerializer } from '@/domains/auth/auth.serializer.js';
import {
  recordLoginAuditEvent,
  recordLoginFailureAuditEvent,
} from '@/domains/auth/shared/audit-login.util.js';
import type { AuthContainer } from '@/domains/auth/auth.container.js';

type AuthOauthHandlersDependencies = Pick<AuthContainer, 'oauthService'>;

/** HTTP status of Apple's form callback — the one named exception to the method→status policy (P85). */
const APPLE_FORM_CALLBACK_STATUS = 303;

/** Builds the OAuth Fastify handlers: `listOauthProviders`, `oauthRedirect` (provider authorize URL; link mode binds the signed-in person, AT12), `appleFormCallback` (Apple's form post → `303` to the app page, AT10), and `oauthCallback` (state consumption + session minting, or in link mode the linked way). The redirect and callback translate `NotImplementedError` to a typed 501 via {@link sendOauthProviderNotImplementedResponse}. */
export function createAuthOauthHandlers({ oauthService }: AuthOauthHandlersDependencies) {
  return {
    oauthRedirect: async (
      request: FastifyRequest<{ Params: { provider: string }; Querystring: OauthStartQueryInput }>,
      reply: FastifyReply,
    ) => {
      // Link mode (AT12): the preHandler already required a bearer and a recent step-up.
      const link =
        request.query.intent === OAUTH_LINK_INTENT
          ? (() => {
              const auth = requireAuth(request);
              return { user_public_id: auth.userId, session_public_id: auth.sessionPublicId ?? '' };
            })()
          : undefined;
      try {
        const { nonce, ...data } = await Promise.resolve().then(() =>
          oauthService.getRedirectUrl({ provider: request.params.provider, link }),
        );
        // Bind the upcoming callback to this browser: the nonce is stored (hashed) with the
        // Redis state and echoed back via this httpOnly cookie so a forged state+code from a
        // different browser cannot complete the flow (login-CSRF defence).
        setOauthNonceCookie({ reply, nonce });
        return successResponse({ data, request_id: getRequestIdentifier(request) });
      } catch (error) {
        if (isOauthProviderNotImplementedError(error)) {
          return sendOauthProviderNotImplementedResponse({
            request,
            reply,
            requestIdentifier: getRequestIdentifier(request),
          });
        }
        throw error;
      }
    },
    oauthCallback: async (
      request: FastifyRequest<{
        Params: { provider: string };
        Querystring: OauthCallbackQueryInput;
      }>,
      reply: FastifyReply,
    ) => {
      const query = request.query;
      const ipAddress = getIpAddress(request);
      const userAgent = getUserAgent(request) ?? undefined;
      const nonce = readOauthNonceCookie(request);
      // The nonce cookie is single-use: clear it regardless of outcome so a stale value
      // cannot be replayed against a future forged state.
      clearOauthNonceCookie(reply);
      let data: Awaited<ReturnType<typeof oauthService.handleCallback>>;
      try {
        data = await oauthService.handleCallback(
          omitUndefined({
            provider: request.params.provider,
            code: query.code,
            state: query.state,
            nonce,
            ipAddress,
            userAgent,
            requestId: getRequestIdentifier(request),
            trustedDeviceToken: readTrustedDeviceCookie(request),
          }),
        );
      } catch (error) {
        // sec-A8 follow-up: record the failure side. Provider id is embedded
        // in the source so incident-response can filter by the IdP that
        // rejected (e.g. "every google-OAuth failure in the last hour").
        await recordLoginFailureAuditEvent({
          request,
          source: `oauth_${request.params.provider}`,
          error,
        });
        throw error;
      }

      if ('linked_auth_method' in data) {
        // Link mode: the account is now one of this person's ways in — no new session.
        await recordScopedAuditEvent({
          request,
          input: {
            actorUserPublicId: data.user_public_id,
            action: 'auth.oauth.link',
            resource_type: 'auth_method',
            severity: 'WARNING',
            metadata: {
              auth_method_id: data.linked_auth_method.public_id,
              provider: request.params.provider,
            },
          },
        });
        return successResponse({
          data: AuthSerializer.authMethod(data.linked_auth_method),
          request_id: getRequestIdentifier(request),
        });
      }

      if ('mfa_required' in data) {
        return successResponse({
          data: AuthSerializer.mfaRequired(data),
          request_id: getRequestIdentifier(request),
        });
      }

      if (
        'session_public_id' in data &&
        typeof data.session_public_id === 'string' &&
        'session_refresh_secret' in data &&
        typeof data.session_refresh_secret === 'string'
      ) {
        setSessionCookie({
          reply,
          sessionPublicId: data.session_public_id,
          refreshSecret: data.session_refresh_secret,
        });
        // sec-A8: audit OAuth success; provider is embedded in the source so an
        // incident-response query can correlate "every super_admin issued via
        // OAuth Google in the last 24h" without a separate metadata column.
        if ('access_token' in data && typeof data.access_token === 'string') {
          await recordLoginAuditEvent({
            request,
            loginResult: {
              access_token: data.access_token,
              session_public_id: data.session_public_id,
            },
            source: `oauth_${request.params.provider}`,
          });
        }
      }

      return successResponse({
        data: AuthSerializer.accessToken(data),
        request_id: getRequestIdentifier(request),
      });
    },
    appleFormCallback: async (
      request: FastifyRequest<{ Body: AppleFormCallbackInput }>,
      reply: FastifyReply,
    ) => {
      const location = await oauthService.receiveAppleFormCallback(
        omitUndefined({
          state: request.body.state,
          code: request.body.code,
          error: request.body.error,
          user: request.body.user,
        }),
      );
      return reply.code(APPLE_FORM_CALLBACK_STATUS).header('location', location).send();
    },
    listOauthProviders: async (request: FastifyRequest, _reply: FastifyReply) => {
      const data = oauthService.listProviders();
      return successResponse({
        data: AuthSerializer.oauthProviders(data),
        request_id: getRequestIdentifier(request),
      });
    },
  };
}
