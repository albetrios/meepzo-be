import type { FastifyReply, FastifyRequest } from 'fastify';
import { successResponse } from '@/shared/utils/http/response.util.js';
import { getRequestIdentifier } from '@/shared/utils/http/request.util.js';
import { recordScopedAuditEvent } from '@/shared/utils/infrastructure/audit-request-context.util.js';
import { AuthSerializer } from '@/domains/auth/auth.serializer.js';
import type { AuthContainer } from '@/domains/auth/auth.container.js';

type AuthEmailConfirmationHandlersDependencies = Pick<AuthContainer, 'emailConfirmationService'>;

/** Builds the public confirm-email handler (`confirmEmail`, route 134 — feat-instagram-dm-sending UN7): consumes the link's token, marks the email confirmed and records `user.email.confirm`. */
export function createAuthEmailConfirmationHandlers({
  emailConfirmationService,
}: AuthEmailConfirmationHandlersDependencies) {
  return {
    confirmEmail: async (request: FastifyRequest, _reply: FastifyReply) => {
      const result = await emailConfirmationService.confirm({ body: request.body });
      await recordScopedAuditEvent({
        request,
        input: {
          actorUserPublicId: result.user_public_id,
          action: 'user.email.confirm',
          resource_type: 'user',
          metadata: { source: 'email_confirm_link' },
        },
      });
      return successResponse({
        data: AuthSerializer.emailConfirmed(),
        request_id: getRequestIdentifier(request),
      });
    },
  };
}
