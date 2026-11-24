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
  // ── Channel connection (feat-instagram-dm-sending § 1) ──
  'POST /api/v1/app/social/channel-connections/{provider}/start': {
    statusCode: 200,
    schema: wrapSuccess(schemas.channelConnectStartSchema, schemas.channelConnectStartExample),
    example: null,
  },
  'POST /api/v1/app/social/channel-connections/{provider}/callback': {
    statusCode: 200,
    schema: wrapSuccess(schemas.channelConnectResultSchema, schemas.channelConnectResultExample),
    example: null,
  },
  'POST /api/v1/app/social/channel-connections/{channel_connection_id}/reconnect': {
    statusCode: 200,
    schema: wrapSuccess(schemas.channelConnectStartSchema, schemas.channelConnectStartExample),
    example: null,
  },
  'POST /api/v1/app/social/channel-connections/{channel_connection_id}/accounts': {
    statusCode: 200,
    schema: wrapSuccess(
      schemas.channelAccountPickResultSchema,
      schemas.channelAccountPickResultExample,
    ),
    example: null,
  },
  'GET /api/v1/app/social/channel-connections': {
    statusCode: 200,
    schema: wrapSuccess({ type: 'array', items: schemas.channelConnectionSchema }, [
      schemas.channelConnectionExample,
    ]),
    example: null,
  },
  'GET /api/v1/app/social/channel-connections/{channel_connection_id}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.channelConnectionSchema, schemas.channelConnectionExample),
    example: null,
  },
  'DELETE /api/v1/app/social/channel-connections/{channel_connection_id}': {
    statusCode: 204,
    schema: null,
    example: null,
  },
  'GET /api/v1/app/social/channel-connections/{channel_connection_id}/ad-accounts': {
    statusCode: 200,
    schema: wrapSuccess(
      { type: 'array', items: schemas.metaAdAccountSchema },
      [schemas.metaAdAccountExample],
      schemas.adAccessMetaProperty,
    ),
    example: null,
  },
  // Meta's cursor — no estimated_total (MC13).
  'GET /api/v1/app/social/channel-connections/{channel_connection_id}/ads': {
    statusCode: 200,
    schema: wrapUncountedPaginated(
      schemas.metaAdSchema,
      [schemas.metaAdExample],
      schemas.adAccessMetaProperty,
    ),
    example: null,
  },
  // ── Channel account (feat-instagram-dm-sending § 1B) ──
  'GET /api/v1/app/social/channel-accounts': {
    statusCode: 200,
    schema: wrapSuccess({ type: 'array', items: schemas.channelAccountSummarySchema }, [
      schemas.channelAccountSummaryExample,
    ]),
    example: null,
  },
  'GET /api/v1/app/social/channel-accounts/{channel_account_id}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.channelAccountSchema, schemas.channelAccountExample),
    example: null,
  },
  'DELETE /api/v1/app/social/channel-accounts/{channel_account_id}': {
    statusCode: 204,
    schema: null,
    example: null,
  },
  'POST /api/v1/app/social/channel-accounts/{channel_account_id}/pause': {
    statusCode: 200,
    schema: wrapSuccess(schemas.channelAccountSchema, schemas.channelAccountExample),
    example: null,
  },
  'POST /api/v1/app/social/channel-accounts/{channel_account_id}/resume': {
    statusCode: 200,
    schema: wrapSuccess(schemas.channelAccountSchema, schemas.channelAccountExample),
    example: null,
  },
  'POST /api/v1/app/social/channel-accounts/{channel_account_id}/activate': {
    statusCode: 200,
    schema: wrapSuccess(schemas.channelAccountSchema, schemas.channelAccountExample),
    example: null,
  },
  // ── Instagram account settings ──
  'PATCH /api/v1/app/social/instagram/accounts/{channel_account_id}/settings': {
    statusCode: 200,
    schema: wrapSuccess(
      schemas.instagramAccountSettingsSchema,
      schemas.instagramAccountSettingsExample,
    ),
    example: null,
  },
  // ── Instagram sending (feat-instagram-dm-sending § 6.A — routes 63–64) ──
  'GET /api/v1/app/social/instagram/accounts/{channel_account_id}/sending-status': {
    statusCode: 200,
    schema: wrapSuccess(
      schemas.instagramSendingStatusSchema,
      schemas.instagramSendingStatusExample,
    ),
    example: null,
  },
  'GET /api/v1/app/usage': {
    statusCode: 200,
    schema: wrapSuccess(schemas.appUsageSchema, schemas.appUsageExample),
    example: null,
  },
  // ── Instagram media (the pickers, Instagram's cursor — no estimated_total, IA16) ──
  'GET /api/v1/app/social/instagram/accounts/{channel_account_id}/media': {
    statusCode: 200,
    schema: wrapUncountedPaginated(schemas.instagramMediaItemSchema, [
      schemas.instagramMediaItemExample,
    ]),
    example: null,
  },
  'GET /api/v1/app/social/instagram/accounts/{channel_account_id}/stories': {
    statusCode: 200,
    schema: wrapUncountedPaginated(schemas.instagramStorySchema, [schemas.instagramStoryExample]),
    example: null,
  },
  // ── Meta callbacks (PUBLIC, signed_request; route 17 outside the envelope, MC16) ──
  'POST /api/v1/app/social/channel-connections/{provider}/deauthorize': {
    statusCode: 200,
    schema: wrapSuccess(schemas.metaDeauthorizeAcknowledgementSchema, null),
    example: null,
  },
  'POST /api/v1/app/social/channel-connections/{provider}/data-deletion': {
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
  'GET /api/v1/app/contacts/{contact_id}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.contactDetailSchema, schemas.contactDetailExample),
    example: null,
  },
  'PATCH /api/v1/app/contacts/{contact_id}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.contactDetailSchema, schemas.contactDetailExample),
    example: null,
  },
  'POST /api/v1/app/contacts/bulk-actions': {
    statusCode: 200,
    schema: wrapSuccess(
      schemas.contactBulkActionResultSchema,
      schemas.contactBulkActionResultExample,
    ),
    example: null,
  },
  'GET /api/v1/app/contact-tags': {
    statusCode: 200,
    schema: wrapSuccess({ type: 'array', items: schemas.contactTagCountSchema }, [
      schemas.contactTagCountExample,
    ]),
    example: null,
  },
  'DELETE /api/v1/app/contacts/{contact_id}': {
    statusCode: 204,
    schema: null,
    example: null,
  },

  // ── Automations (feat-instagram-dm-sending § 4.A, ROUTE R13) ──
  'GET /api/v1/app/automations': {
    statusCode: 200,
    schema: wrapPaginated(
      schemas.automationListRowSchema,
      [schemas.automationListRowExample],
      schemas.automationTotalsMetaProperty,
    ),
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
    schema: wrapSuccess(
      schemas.automationSchema,
      schemas.automationExample,
      schemas.automationWarningsMetaProperty,
    ),
    example: null,
  },
  'POST /api/v1/app/automations/{automation_id}/go-live': {
    statusCode: 200,
    schema: wrapSuccess(
      schemas.automationSchema,
      schemas.automationExample,
      schemas.automationWarningsMetaProperty,
    ),
    example: null,
  },
  'POST /api/v1/app/automations/{automation_id}/pause': {
    statusCode: 200,
    schema: wrapSuccess(schemas.automationSchema, {
      ...schemas.automationExample,
      status: 'paused',
    }),
    example: null,
  },
  'POST /api/v1/app/automations/{automation_id}/duplicate': {
    statusCode: 200,
    schema: wrapSuccess(schemas.automationSchema, {
      ...schemas.automationExample,
      name: 'Comment GUIDE for the free guide (copy)',
      status: 'draft',
    }),
    example: null,
  },
  'POST /api/v1/app/automations/{automation_id}/keyword-test': {
    statusCode: 200,
    schema: wrapSuccess(schemas.automationKeywordTestSchema, schemas.automationKeywordTestExample),
    example: null,
  },
  'DELETE /api/v1/app/automations/{automation_id}': {
    statusCode: 204,
    schema: null,
    example: null,
  },

  // ── Segments (feat-instagram-dm-sending routes-final § 7.B, routes 77–82) ──
  'GET /api/v1/app/segments': {
    statusCode: 200,
    schema: wrapPaginated(schemas.segmentSchema, [schemas.segmentExample]),
    example: null,
  },
  'POST /api/v1/app/segments': {
    statusCode: 200,
    schema: wrapSuccess(schemas.segmentSchema, schemas.segmentExample),
    example: null,
  },
  'POST /api/v1/app/segments/audience-count': {
    statusCode: 200,
    schema: wrapSuccess(schemas.segmentAudienceCountSchema, schemas.segmentAudienceCountExample),
    example: null,
  },
  'GET /api/v1/app/segments/{segment_id}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.segmentSchema, schemas.segmentExample),
    example: null,
  },
  'PATCH /api/v1/app/segments/{segment_id}': {
    statusCode: 200,
    schema: wrapSuccess(schemas.segmentSchema, schemas.segmentExample),
    example: null,
  },
  'DELETE /api/v1/app/segments/{segment_id}': {
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
