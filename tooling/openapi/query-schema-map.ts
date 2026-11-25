/**
 * Maps OpenAPI route patterns (method + path) to Zod querystring DTOs.
 *
 * Used by generate-openapi.ts to document query parameters (especially cursor pagination).
 * When adding a route with query validation — a list, a record delete's `reason` — add its mapping
 * here (`query-schema-map.unit.test.ts` fails a route that declares `schema.querystring` without it).
 */
import type { ZodTypeAny } from 'zod';
import { ListAuditLogsQueryDto } from '@/domains/audit/audit.dto.js';
import { ListInstagramWebhookEventsQueryDto } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.dto.js';
import { InstagramWebhookSubscriptionQueryDto } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.dto.js';
import {
  contactActivityQueryDto,
  listContactTagsQueryDto,
  listContactsQueryDto,
} from '@/domains/app/sub-domains/contact/contact.dto.js';
import {
  listChannelConnectionAdAccountsQueryDto,
  listChannelConnectionAdsQueryDto,
  listChannelConnectionsQueryDto,
} from '@/domains/app/sub-domains/channel-connection/channel-connection.dto.js';
import { listChannelAccountsQueryDto } from '@/domains/app/sub-domains/channel-account/channel-account.dto.js';
import {
  deleteAutomationQueryDto,
  listAutomationsQueryDto,
} from '@/domains/app/sub-domains/automation/automation.dto.js';
import { listBroadcastsQueryDto } from '@/domains/app/sub-domains/broadcast/broadcast.dto.js';
import { listSegmentsQueryDto } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';
import { OauthCallbackQueryDto, OauthStartQueryDto } from '@/domains/auth/auth.dto.js';
import { listInvoicesQueryDto } from '@/domains/billing/sub-domains/subscription/subscription.dto.js';
import { listNotificationsQueryDto } from '@/domains/notify/sub-domains/notification/notification.dto.js';
import { listWebhooksQueryDto } from '@/domains/notify/sub-domains/webhook/webhook.dto.js';
import {
  deleteMembershipQueryDto,
  listMembershipsQueryDto,
} from '@/domains/tenancy/sub-domains/membership/membership.dto.js';
import {
  deleteMemberRoleQueryDto,
  listMemberRolesQueryDto,
} from '@/domains/tenancy/sub-domains/member-roles/member-role.dto.js';
import { listOrganizationApiKeysQueryDto } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.dto.js';
import { listOrganizationChooserQueryDto } from '@/domains/tenancy/sub-domains/organization/organization.dto.js';
import { ListUsersDto } from '@/domains/user/user.dto.js';
import { listMyMembershipInvitationsQueryDto } from '@/domains/tenancy/sub-domains/membership/membership-invitation/membership-invitation.dto.js';
import { ListInstagramMediaQueryDto } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.dto.js';
import { listLimitQuerySchema } from '@/shared/utils/http/pagination.util.js';

export const routeQuerySchemaMap: Record<string, ZodTypeAny> = {
  'GET /api/v1/audit/logs': ListAuditLogsQueryDto,
  'GET /api/v1/users': ListUsersDto,
  'GET /api/v1/billing/invoices': listInvoicesQueryDto,
  'GET /api/v1/users/me/organizations': listOrganizationChooserQueryDto,
  'GET /api/v1/users/me/membership-invitations': listMyMembershipInvitationsQueryDto,
  'GET /api/v1/tenancy/organization/audit-logs': ListAuditLogsQueryDto,
  'GET /api/v1/tenancy/organization/api-keys': listOrganizationApiKeysQueryDto,
  'GET /api/v1/tenancy/organization/memberships': listMembershipsQueryDto,
  'GET /api/v1/tenancy/organization/roles': listMemberRolesQueryDto,
  'GET /api/v1/notify/notifications': listNotificationsQueryDto,
  'GET /api/v1/notify/webhooks/{webhook_id}/delivery-attempts': listLimitQuerySchema,
  'GET /api/v1/auth/oauth/{provider}/callback': OauthCallbackQueryDto,
  'GET /api/v1/auth/oauth/{provider}': OauthStartQueryDto,
  // Record deletes (launch D83 (6), QA B2): the `reason` (and `note`, required for `other`) every
  // one requires — the document read no query on a DELETE before.
  'DELETE /api/v1/tenancy/organization/memberships/{membership_id}': deleteMembershipQueryDto,
  'DELETE /api/v1/tenancy/organization/roles/{role_id}': deleteMemberRoleQueryDto,
  'GET /api/v1/notify/webhooks': listWebhooksQueryDto,
  // The post and story pickers (launch R5): Instagram's own paging — limit 1–50, after.
  'GET /api/v1/app/social/instagram/accounts/{channel_account_id}/media':
    ListInstagramMediaQueryDto,
  'GET /api/v1/app/social/instagram/accounts/{channel_account_id}/stories':
    ListInstagramMediaQueryDto,
  'GET /api/v1/app/social/instagram/webhook-events': ListInstagramWebhookEventsQueryDto,
  'GET /api/v1/app/social/channel-connections/meta/webhooks/instagram':
    InstagramWebhookSubscriptionQueryDto,
  // App: channel connections (feat-instagram-dm-sending routes-final § 1.8, route 4).
  'GET /api/v1/app/social/channel-connections': listChannelConnectionsQueryDto,
  'GET /api/v1/app/social/channel-accounts': listChannelAccountsQueryDto,
  // The ad picker (routes 41 and 15, § 1.8): none; one ad account, Meta's limit 1–50 and after.
  'GET /api/v1/app/social/channel-connections/{channel_connection_id}/ad-accounts':
    listChannelConnectionAdAccountsQueryDto,
  'GET /api/v1/app/social/channel-connections/{channel_connection_id}/ads':
    listChannelConnectionAdsQueryDto,
  // App: the Instagram account's route 2 takes no query (strict).
  // App: contacts (DM-sending routes-final § 3.A.8, routes 18, 22 and 24).
  'GET /api/v1/app/contacts': listContactsQueryDto,
  'GET /api/v1/app/contact-tags': listContactTagsQueryDto,
  'GET /api/v1/app/contacts/{contact_id}/activity': contactActivityQueryDto,
  // App: automations (routes-final § 3.A.8, routes 11 and 15).
  'GET /api/v1/app/automations': listAutomationsQueryDto,
  'DELETE /api/v1/app/automations/{automation_id}': deleteAutomationQueryDto,
  // App: segments (feat-instagram-dm-sending routes-final § 7.B.8, route 77).
  'GET /api/v1/app/segments': listSegmentsQueryDto,
  // App: broadcasts (feat-instagram-dm-sending routes-final § 7.A.8, route 70).
  'GET /api/v1/app/broadcasts': listBroadcastsQueryDto,
};

/** Routes that must document `after` and `limit` query parameters in OpenAPI. */
export const routeQuerySchemaMapKeys = Object.keys(routeQuerySchemaMap);
