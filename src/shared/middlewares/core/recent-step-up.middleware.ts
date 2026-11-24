import type { FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError } from '@/shared/errors/index.js';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { requireAuth } from '@/shared/utils/http/request.util.js';
import { hasRecentStepUp, hasRecentStrongStepUp } from '@/shared/utils/auth/recent-step-up.util.js';

/**
 * PreHandler that requires the caller to have completed step-up authentication (e.g. MFA verify)
 * within the last ten minutes — on THIS session — before mutating credentials or MFA enrollment.
 *
 * @remarks
 * The check is bound to `(userPublicId, sessionPublicId)` so a stolen-session attacker
 * cannot inherit a step-up that the legitimate user performed on a different session
 * (sec-A2). Fails closed when `sessionPublicId` is absent on `request.auth`.
 */
export async function requireRecentStepUpPreHandler(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const auth = requireAuth(request);
  const steppedUp = await hasRecentStepUp({
    redis: redisConnection,
    userPublicId: auth.userId,
    sessionPublicId: auth.sessionPublicId,
  });
  if (!steppedUp) {
    throw new ForbiddenError('errors:recentStepUpRequired');
  }
}

/**
 * PreHandler factory: {@link requireRecentStepUpPreHandler}, but only when the request body
 * carries `field` — for a route where one field alone is the sensitive part (an organization's
 * `status`, B2-3) and the rest of the body is routine.
 *
 * @remarks
 * - **Algorithm:** a body without `field` (or with it `undefined`) passes; otherwise a user must
 *   hold a recent step-up on this session. An API key can never step up, so it is refused.
 * - **Failure modes:** `ForbiddenError('errors:recentStepUpRequired')`.
 * - **Notes:** runs as a preHandler, so the body is already parsed and validated.
 */
export function requireRecentStepUpWhenBodyHas(
  field: string,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!bodyCarries({ request, field })) return;
    if (request.auth?.kind !== 'user') {
      throw new ForbiddenError('errors:recentStepUpRequired');
    }
    await requireRecentStepUpPreHandler(request, reply);
  };
}

/**
 * PreHandler factory: a signed-in caller with a recent step-up on this session, but only when the
 * query string's `field` equals `value` — for a PUBLIC route with one signed-in mode (the OAuth
 * start's `intent=link`, feat-instagram-dm-sending AT12).
 *
 * @remarks
 * - **Algorithm:** any other query passes; with the mode, `requireAuth` (the bearer is read
 *   optionally before it by `authenticateWhenBearerPresent`), then the per-(user, session) step-up
 *   sentinel.
 * - **Failure modes:** no signed-in person → `401`; no recent step-up → `403`
 *   `errors:recentStepUpRequired` with reason `recent_step_up_required`.
 * - **Notes:** runs as a preHandler, so the query is already validated.
 */
export function requireRecentStepUpWhenQueryIs({
  field,
  value,
}: {
  field: string;
  value: string;
}): (request: FastifyRequest) => Promise<void> {
  return async (request: FastifyRequest): Promise<void> => {
    const query = request.query as Record<string, unknown> | undefined;
    if (query?.[field] !== value) return;
    const auth = requireAuth(request);
    const steppedUp = await hasRecentStepUp({
      redis: redisConnection,
      userPublicId: auth.userId,
      sessionPublicId: auth.sessionPublicId,
    });
    if (!steppedUp) {
      throw new ForbiddenError('errors:recentStepUpRequired').withReason('recent_step_up_required');
    }
  };
}

/**
 * PreHandler factory: {@link requireStrongRecentStepUpPreHandler}, but only when the request body
 * carries `field` — for an admin edit whose `status` alone suspends an account (A-2) while the
 * rest of the body is routine.
 *
 * @remarks
 * - **Algorithm:** a body without `field` (or with it `undefined`) passes; otherwise a user must
 *   hold a recent strong step-up on this session (MFA, or the email code without settled 2FA). An API key can never step up.
 * - **Failure modes:** `ForbiddenError('errors:strongStepUpRequired')`.
 */
export function requireStrongRecentStepUpWhenBodyHas(
  field: string,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!bodyCarries({ request, field })) return;
    if (request.auth?.kind !== 'user') {
      throw new ForbiddenError('errors:strongStepUpRequired');
    }
    await requireStrongRecentStepUpPreHandler(request, reply);
  };
}

/** Whether the parsed request body sets `field` (to anything but `undefined`). */
function bodyCarries({ request, field }: { request: FastifyRequest; field: string }): boolean {
  const body = request.body;
  if (!(body && typeof body === 'object')) return false;
  return (body as Record<string, unknown>)[field] !== undefined;
}

/**
 * PreHandler for DESTRUCTIVE credential/session mutations (revoke sessions, delete an MFA method,
 * passkey, or auth-method) — requires a recent step-up completed via a STRONG factor
 * (MFA, or the email code without settled 2FA), on THIS session, within the last ten minutes.
 *
 * @remarks
 * Stricter than {@link requireRecentStepUpPreHandler}: it admits an `mfa` window, or an
 * `email_code` window — which `POST /auth/step-up` opens only for a person WITHOUT settled 2FA
 * (AT15; their mailbox can already sign them in, so it gives no new power) — but not a
 * `provisional_mfa` window. A person with settled 2FA must step up with the 2FA code. Fails closed
 * when `sessionPublicId` is absent on `request.auth`.
 */
export async function requireStrongRecentStepUpPreHandler(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const auth = requireAuth(request);
  const steppedUp = await hasRecentStrongStepUp({
    redis: redisConnection,
    userPublicId: auth.userId,
    sessionPublicId: auth.sessionPublicId,
  });
  if (!steppedUp) {
    throw new ForbiddenError('errors:strongStepUpRequired');
  }
}
