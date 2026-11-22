/**
 * OpenAPI success responses — the app domain (Instagram account, routes-final § 1.A–1.D; contacts,
 * § 2; automations, § 3.A; Instagram webhook events, § 4.B).
 */
import type { ResponseDefinition } from '@tooling/openapi/response-map/building-blocks.js';
import {
  wrapPaginated,
  wrapSuccess,
  wrapUncountedPaginated,
} from '@tooling/openapi/response-map/building-blocks.js';
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
  // ── Instagram account settings ──
  'PATCH /api/v1/app/social/instagram/account/settings': {
    statusCode: 200,
    schema: wrapSuccess(
      schemas.instagramAccountSettingsSchema,
      schemas.instagramAccountSettingsExample,
    ),
    example: null,
  },
  // ── Instagram media (the pickers, Instagram's cursor — no estimated_total, IA16) ──
  'GET /api/v1/app/social/instagram/media': {
    statusCode: 200,
    schema: wrapUncountedPaginated(schemas.instagramMediaItemSchema, [
      schemas.instagramMediaItemExample,
    ]),
    example: null,
  },
  'GET /api/v1/app/social/instagram/stories': {
    statusCode: 200,
    schema: wrapUncountedPaginated(schemas.instagramStorySchema, [schemas.instagramStoryExample]),
    example: null,
  },
  // ── Meta callbacks (PUBLIC, signed_request; route 8 outside the envelope, IA20) ──
  'POST /api/v1/app/social/instagram/deauthorize': {
    statusCode: 200,
    schema: wrapSuccess(schemas.metaDeauthorizeAcknowledgementSchema, null),
    example: null,
  },
  'POST /api/v1/app/social/instagram/data-deletion': {
    statusCode: 200,
    schema: schemas.metaDataDeletionAnswerSchema,
    example: null,
  },

  // ── Contacts ──
  'GET /api/v1/app/contacts': {
    statusCode: 200,
    schema: wrapPaginated(schemas.contactSchema, [schemas.contactExample]),
    example: null,
  },
  'DELETE /api/v1/app/contacts/{contact_id}': {
    statusCode: 204,
    schema: null,
    example: null,
  },

  // ── Automations ──
  'GET /api/v1/app/automations': {
    statusCode: 200,
    schema: wrapPaginated(schemas.automationSchema, [schemas.automationExample]),
    example: null,
  },
  'POST /api/v1/app/automations': {
    statusCode: 200,
    schema: wrapSuccess(schemas.automationSchema, schemas.automationExample),
    example: null,
  },
  'GET /api/v1/app/automations/{automation_id}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.automationSchema, schemas.automationExample),
    example: null,
  },
  'PATCH /api/v1/app/automations/{automation_id}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.automationSchema, schemas.automationExample),
    example: null,
  },
  'DELETE /api/v1/app/automations/{automation_id}': {
    statusCode: 204,
    schema: null,
    example: null,
  },

  // ── Instagram webhook events ──
  'GET /api/v1/app/social/instagram/webhook-events': {
    statusCode: 200,
    schema: wrapPaginated(schemas.instagramWebhookEventSchema, [
      schemas.instagramWebhookEventExample,
    ]),
    example: null,
  },
};
