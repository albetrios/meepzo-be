/**
 * Maps OpenAPI route patterns (method + path) to Zod querystring DTOs.
 *
 * Used by generate-openapi.ts to document query parameters (especially cursor pagination).
 * When adding a route with query validation — a list, a record delete's `reason` — add its mapping
 * here (`query-schema-map.unit.test.ts` fails a route that declares `schema.querystring` without it).
 */
import type { ZodTypeAny } from 'zod';
import { ListAuditLogsQueryDto } from '@/domains/audit/audit.dto.js';
import { OauthCallbackQueryDto } from '@/domains/auth/auth.dto.js';
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
import { listOrganizationsQueryDto } from '@/domains/tenancy/sub-domains/organization/organization.dto.js';
import { ListUsersDto } from '@/domains/user/user.dto.js';
import { listMyMembershipInvitationsQueryDto } from '@/domains/tenancy/sub-domains/membership/membership-invitation/membership-invitation.dto.js';
import { listLimitQuerySchema } from '@/shared/utils/http/pagination.util.js';

export const routeQuerySchemaMap: Record<string, ZodTypeAny> = {
  'GET /api/v1/audit/logs': ListAuditLogsQueryDto,
  'GET /api/v1/users': ListUsersDto,
  'GET /api/v1/billing/invoices': listInvoicesQueryDto,
  'GET /api/v1/users/me/organizations': listOrganizationsQueryDto,
  'GET /api/v1/users/me/membership-invitations': listMyMembershipInvitationsQueryDto,
  'GET /api/v1/tenancy/organization/audit-logs': ListAuditLogsQueryDto,
  'GET /api/v1/tenancy/organization/api-keys': listOrganizationApiKeysQueryDto,
  'GET /api/v1/tenancy/organization/memberships': listMembershipsQueryDto,
  'GET /api/v1/tenancy/organization/roles': listMemberRolesQueryDto,
  'GET /api/v1/notify/notifications': listNotificationsQueryDto,
  'GET /api/v1/notify/webhooks/{webhook_id}/delivery-attempts': listLimitQuerySchema,
  'GET /api/v1/auth/oauth/{provider}/callback': OauthCallbackQueryDto,
  // Record deletes (launch D83 (6), QA B2): the `reason` (and `note`, required for `other`) every
  // one requires — the document read no query on a DELETE before.
  'DELETE /api/v1/tenancy/organization/memberships/{membership_id}': deleteMembershipQueryDto,
  'DELETE /api/v1/tenancy/organization/roles/{role_id}': deleteMemberRoleQueryDto,
  'GET /api/v1/notify/webhooks': listWebhooksQueryDto,
};

/** Routes that must document `after` and `limit` query parameters in OpenAPI. */
export const routeQuerySchemaMapKeys = Object.keys(routeQuerySchemaMap);
