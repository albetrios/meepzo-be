import { type ZodTypeAny, toJSONSchema } from 'zod';
import { enrichSchema } from '@tooling/openapi/enrichers/schema-enricher.js';
import { routeSchemaMap } from '@tooling/openapi/schema-map.js';
import { routeQuerySchemaMap } from '@tooling/openapi/query-schema-map.js';
import { zodToOpenApiQueryParameters } from '@tooling/openapi/query-parameters.js';
import { ROUTES_WITHOUT_JSON_BODY } from '@tooling/openapi/routes-without-json-body.js';

export function zodToOpenApiSchema(zodSchema: ZodTypeAny): Record<string, unknown> {
  const jsonSchema = toJSONSchema(zodSchema, {
    target: 'openapi-3.0',
    reused: 'inline',
    cycles: 'throw',
  }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return enrichSchema(jsonSchema);
}

export function getQueryParameters(method: string, openapiPath: string): object[] {
  const key = `${method} ${openapiPath}`;
  const zodSchema = routeQuerySchemaMap[key];
  if (!zodSchema) return [];
  return zodToOpenApiQueryParameters(zodSchema);
}

/**
 * Routes whose request body is `application/x-www-form-urlencoded`, not JSON — Meta's
 * deauthorize and data-deletion callbacks (feat-instagram-dm-sending routes 16–17, MC14), which post one form field,
 * `signed_request` — and Apple's sign-in form callback (feat-instagram-dm-sending route 124). Their
 * body schema still comes from {@link routeSchemaMap}; only the media type of the documented
 * request body changes.
 */
const FORM_ENCODED_REQUEST_BODY_ROUTE_KEYS = new Set<string>([
  'POST /api/v1/app/social/channel-connections/{provider}/deauthorize',
  'POST /api/v1/app/social/channel-connections/{provider}/data-deletion',
  'POST /api/v1/auth/oauth/apple/callback',
]);

/** The media type a route's request body is documented under: JSON, or form-encoded for the few above. */
export function getRequestBodyMediaType(routeKey: string): string {
  return FORM_ENCODED_REQUEST_BODY_ROUTE_KEYS.has(routeKey)
    ? 'application/x-www-form-urlencoded'
    : 'application/json';
}

export function getRequestBodySchema(
  method: string,
  openapiPath: string,
): Record<string, unknown> | null {
  const key = `${method} ${openapiPath}`;
  if (ROUTES_WITHOUT_JSON_BODY.has(key)) return null;
  const zodSchema = routeSchemaMap[key];
  if (!zodSchema) return null;
  return zodToOpenApiSchema(zodSchema);
}

/**
 * Public (unauthenticated) routes that must NOT advertise the `bearerAuth` security scheme.
 *
 * @remarks
 * These carry no `app.authenticate` onRequest hook (route-catalog access `PUBLIC`): the public auth
 * forms (email-login/oauth/webauthn-authenticate/mfa-login; refresh is NOT here —
 * it authenticates via the session cookie and advertises `sessionCookie`) and
 * the Stripe-signed webhooks (verified via `Stripe-Signature`, not a JWT), and Meta's Instagram
 * callbacks (verified via the form's `signed_request`). The `Health` and
 * `Plan` tags are excluded separately above. Keyed by `"<METHOD> <openapi-path>"`. Kept in
 * sync with `docs/routes.txt` PUBLIC routes by `mcp-openapi`/route-security guard tests.
 */
const PUBLIC_ROUTE_KEYS = new Set<string>([
  'GET /livez',
  'GET /readyz',
  'POST /api/v1/auth/mfa/login',
  'POST /api/v1/auth/email/send-code',
  'POST /api/v1/auth/email/login',
  // The confirm-email link (feat-instagram-dm-sending route 134): the emailed token is the key.
  'POST /api/v1/auth/email/confirm',
  'POST /api/v1/auth/webauthn/authenticate/options',
  'POST /api/v1/auth/webauthn/authenticate/verify',
  'GET /api/v1/auth/oauth/{provider}',
  'GET /api/v1/auth/oauth/{provider}/callback',
  'GET /api/v1/auth/oauth/providers',
  // Apple's form callback (feat-instagram-dm-sending route 124): Apple posts it; answers 303.
  'POST /api/v1/auth/oauth/apple/callback',
  'POST /api/v1/billing/webhook',
  'POST /api/v1/app/social/channel-connections/{provider}/deauthorize',
  'POST /api/v1/app/social/channel-connections/{provider}/data-deletion',
  // Meta's Instagram webhook: proved by the verify token (GET) and X-Hub-Signature-256 (POST).
  'GET /api/v1/app/social/channel-connections/meta/webhooks/instagram',
  'POST /api/v1/app/social/channel-connections/meta/webhooks/instagram',
  // The invitation page (feat-instagram-dm-sending route 118): the emailed token is the key; a
  // bearer is optional (read when sent, never required), so no scheme is advertised.
  'POST /api/v1/tenancy/membership-invitations/{membership_invitation_id}/preview',
]);

export function getRouteSecurity(tags: string[], routeKey: string): object[] | undefined {
  if (tags.includes('Health')) return undefined;
  if (tags.includes('Plan')) return undefined;
  // Refresh is authenticated by the session cookie + CSRF header, not a bearer JWT — the access
  // token is expired by definition when a client refreshes. Documented as its own scheme so the
  // spec neither over-states (bearerAuth) nor under-states (public) the requirement.
  if (routeKey === 'POST /api/v1/auth/refresh') return [{ sessionCookie: [] }];
  // Public routes (no JWT): don't advertise the bearerAuth requirement.
  if (PUBLIC_ROUTE_KEYS.has(routeKey)) return undefined;
  return [{ bearerAuth: [] }];
}

export function generateOperationId(method: string, openapiPath: string): string {
  const cleaned = openapiPath
    .replace(/\/api\/v1\//, '')
    .replace(/\{([^}]+)\}/g, 'By$1')
    .replace(/[/-]/g, ' ')
    .trim();

  const words = cleaned.split(/\s+/);
  const camelCase = words
    .map((word, index) =>
      index === 0 && method.toLowerCase() !== 'get'
        ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join('');

  return method.toLowerCase() + camelCase.charAt(0).toUpperCase() + camelCase.slice(1);
}

export function inferTagFromPath(openapiPath: string): string {
  const segments = openapiPath.replace('/api/v1/', '').split('/');
  const first = segments[0];
  if (!first) return 'General';
  return first.charAt(0).toUpperCase() + first.slice(1);
}
