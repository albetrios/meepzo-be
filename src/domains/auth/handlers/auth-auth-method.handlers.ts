import type { FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError } from '@/shared/errors/index.js';
import { successResponse } from '@/shared/utils/http/response.util.js';
import { getRequestIdentifier, requireAuth } from '@/shared/utils/http/request.util.js';
import { recordScopedAuditEvent } from '@/shared/utils/infrastructure/audit-request-context.util.js';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { recordRecentStepUp, type StepUpFactor } from '@/shared/utils/auth/recent-step-up.util.js';
import {
  validateAuthMethodPublicIdParam,
  validateStepUpVerify,
} from '@/domains/auth/auth.validator.js';
import { AuthSerializer } from '@/domains/auth/auth.serializer.js';
import type { AuthContainer } from '@/domains/auth/auth.container.js';

type AuthAuthMethodHandlersDependencies = Pick<
  AuthContainer,
  'authMethodService' | 'emailLoginService'
>;

/** Builds the auth-method management Fastify handlers (`listAuthMethods`, `createAuthMethod`, `deleteAuthMethod`, plus the email-code step-up) and emits the `auth.auth_method.*` audit events. */
export function createAuthAuthMethodHandlers({
  authMethodService,
  emailLoginService,
}: AuthAuthMethodHandlersDependencies) {
  return {
    listAuthMethods: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const data = await authMethodService.list(auth.userId);
      return successResponse({
        data: AuthSerializer.authMethodList(data),
        request_id: getRequestIdentifier(request),
      });
    },
    createAuthMethod: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const data = await authMethodService.create({
        userPublicId: auth.userId,
        body: request.body,
      });
      await recordScopedAuditEvent({
        request,
        input: {
          actorUserPublicId: auth.userId,
          action: 'auth.auth_method.create',
          resource_type: 'auth_method',
          metadata: { auth_method_id: (data as { public_id?: string }).public_id },
        },
      });
      return successResponse({
        data: AuthSerializer.authMethod(data),
        request_id: getRequestIdentifier(request),
      });
    },
    deleteAuthMethod: async (
      request: FastifyRequest<{ Params: { auth_method_id: string } }>,
      reply: FastifyReply,
    ) => {
      const auth = requireAuth(request);
      const publicId = validateAuthMethodPublicIdParam(request.params.auth_method_id);
      await authMethodService.delete({ userPublicId: auth.userId, methodPublicId: publicId });
      await recordScopedAuditEvent({
        request,
        input: {
          actorUserPublicId: auth.userId,
          action: 'auth.auth_method.delete',
          resource_type: 'auth_method',
          metadata: { auth_method_id: publicId },
        },
      });
      return reply.code(204).send();
    },
    stepUp: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const parsed = validateStepUpVerify(request.body);
      // Step-up sentinel is per-(user, session) (sec-A2); fail closed if session id is missing —
      // before any attempt is counted.
      const sessionPublicId = auth.sessionPublicId;
      if (!sessionPublicId) {
        throw new ForbiddenError('errors:recentStepUpRequired');
      }
      // Email-code step-up (passwords are off, P84; AT15): refused with `403 mfa_step_up_required`
      // for a person with settled 2FA (that one steps up through MFA verify). The window is
      // `email_code`-tagged and STRONG — only a person without settled 2FA can open it, and their
      // mailbox can already sign them in, so it gives no new power.
      await emailLoginService.verifyCodeForStepUp({
        userPublicId: auth.userId,
        sessionPublicId,
        code: parsed.code,
      });
      const factor: StepUpFactor = 'email_code';
      await recordRecentStepUp({
        redis: redisConnection,
        userPublicId: auth.userId,
        sessionPublicId,
        factor,
      });
      await recordScopedAuditEvent({
        request,
        input: {
          actorUserPublicId: auth.userId,
          action: 'auth.step_up',
          resource_type: 'user',
          metadata: { factor },
        },
      });
      return successResponse({
        data: { stepped_up: true, factor },
        request_id: getRequestIdentifier(request),
      });
    },
  };
}
