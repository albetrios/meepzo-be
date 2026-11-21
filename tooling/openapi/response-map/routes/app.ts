/** OpenAPI success responses — the app domain (Instagram account, routes-final § 1.A). */
import type { ResponseDefinition } from '@tooling/openapi/response-map/building-blocks.js';
import { wrapSuccess } from '@tooling/openapi/response-map/building-blocks.js';
import * as schemas from '@tooling/openapi/response-map/resource-schemas.js';

export const appRouteResponses: Record<string, ResponseDefinition> = {
  // ── Instagram account ──
  'POST /api/v1/app/social/instagram/connect': {
    statusCode: 200,
    schema: wrapSuccess(
      schemas.instagramConnectResultSchema,
      schemas.instagramConnectResultExample,
    ),
    example: null,
  },
  'GET /api/v1/app/social/instagram/account': {
    statusCode: 200,
    schema: wrapSuccess(schemas.instagramAccountSchema, schemas.instagramAccountExample),
    example: null,
  },
  'DELETE /api/v1/app/social/instagram/account': {
    statusCode: 204,
    schema: null,
    example: null,
  },
};
