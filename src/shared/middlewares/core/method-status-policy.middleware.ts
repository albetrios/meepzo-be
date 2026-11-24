import type { FastifyInstance } from 'fastify';

/**
 * The named exceptions to the method→success-status policy: `"METHOD /full/route/pattern"` →
 * the one success status that route answers instead. Exactly one entry (P85, routes-final § 10
 * ATQ2): Apple's form callback, a top-level browser navigation Apple posts, answers `303` with
 * `Location` (POST-then-GET) to the app page. Read by this middleware, by the success-status gates
 * (`validate:route-success-statuses`, `validate:route-success-coverage` through
 * `route-success-status.helper.ts`) and pinned by `method-status-policy.middleware.unit.test.ts`.
 */
export const METHOD_STATUS_POLICY_EXCEPTIONS: ReadonlyMap<string, number> = new Map([
  ['POST /api/v1/auth/oauth/apple/callback', 303],
]);

/**
 * Uniform method→success-status policy, enforced centrally:
 *
 * | Method  | Success status |
 * | ------- | -------------- |
 * | GET     | 200            |
 * | POST    | 200            |
 * | PUT     | 200            |
 * | PATCH   | 200            |
 * | DELETE  | 204            |
 *
 * There are deliberately **no exemptions except one**: success is 200 for every method except
 * DELETE (204), and the single named exception is Apple's form callback, which answers 303
 * ({@link METHOD_STATUS_POLICY_EXCEPTIONS}, P85).
 * This is the Stripe-shaped uniform model: `200 OK` is true for a create, true for an idempotent
 * replay of that create, and true for a future upsert — where `201 Created` lies on the replay
 * and forces a created-vs-existed judgment call on every upsert route. It also matches every
 * external inbound protocol this API might ever host (webhook acks, OAuth token endpoints,
 * JSON-RPC transports all expect 200), so the old per-route exemption list is gone rather than
 * maintained — Apple's form post is a browser navigation, not an API call, and a 303 is the HTTP
 * answer for POST-then-GET.
 *
 * @remarks
 * - **Algorithm:** an `onSend` hook normalizes any 201/202/204 a POST handler produced to 200
 *   (other methods/statuses pass through untouched), so every current and future POST conforms
 *   without per-handler boilerplate. A route in {@link METHOD_STATUS_POLICY_EXCEPTIONS} keeps
 *   its status.
 * - **Failure modes:** none — error statuses (>= 300) are never rewritten.
 * - **Side effects:** response status only; bodies are untouched (a 204-bodied POST becomes a
 *   200 with empty body, exactly as the previous 201 policy treated it).
 * - **Notes:** declared statuses live in route-success-statuses.json and are runtime-verified
 *   by the observed-status gate; this hook is the enforcement point that keeps controllers
 *   honest.
 */
export function registerMethodStatusPolicy(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method !== 'POST') {
      return payload;
    }
    if (METHOD_STATUS_POLICY_EXCEPTIONS.has(`POST ${request.routeOptions.url}`)) {
      return payload;
    }
    if (reply.statusCode === 201 || reply.statusCode === 202 || reply.statusCode === 204) {
      reply.code(200);
    }
    return payload;
  });
}
