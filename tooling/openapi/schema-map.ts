/**
 * Maps OpenAPI route patterns (method + path) to their Zod request body DTOs.
 *
 * Used by generate-openapi.ts to embed JSON Schemas from Zod DTOs,
 * which openapi-to-postmanv2's built-in schemaFaker turns into realistic examples.
 *
 * When adding a new route with a body, add its mapping here.
 */
import {
  contactBulkActionBodyDto,
  emptyContactActionBodyDto,
  updateContactBodyDto,
} from '@/domains/app/sub-domains/contact/contact.dto.js';
import {
  createBroadcastBodyDto,
  emptyBroadcastActionBodyDto,
  sendBroadcastBodyDto,
  updateBroadcastBodyDto,
} from '@/domains/app/sub-domains/broadcast/broadcast.dto.js';
import {
  createSegmentBodyDto,
  segmentAudienceCountBodyDto,
  updateSegmentBodyDto,
} from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';
import type { ZodTypeAny } from 'zod';

// ─── Auth ──────────────────────────────────────────────────────────────
import {
  AppleFormCallbackDto,
  EmailSendCodeDto,
  EmailConfirmDto,
  EmailLoginDto,
  RequestEmailConfirmationDto,
  MfaVerifyDto,
  CreateAuthMethodDto,
  MfaEnrollDto,
  MfaEnrollConfirmDto,
  MfaLoginVerifyDto,
  StepUpVerifyDto,
} from '@/domains/auth/auth.dto.js';

// ─── User ──────────────────────────────────────────────────────────────
import {
  UpdateMeDto,
  UpdateMyPresenceDto,
  AdminUpdateUserDto,
  UploadAvatarDto,
} from '@/domains/user/user.dto.js';
import {
  activateChannelAccountDto,
  emptyChannelAccountBodyDto,
} from '@/domains/app/sub-domains/channel-account/channel-account.dto.js';
import { UpdateUserSettingsDto } from '@/domains/user/sub-domains/user-settings/user-settings.dto.js';
import { PutNotificationPreferencesDto } from '@/domains/user/sub-domains/user-notification-preferences/user-notification-preferences.dto.js';
import { exportUserDataBodyDto } from '@/domains/user/sub-domains/user-data-export/user-data-export.dto.js';
import { CreateUserBugReportDto } from '@/domains/user/sub-domains/user-bug-report/user-bug-report.dto.js';
import {
  webauthnAuthenticateOptionsDto,
  webauthnAuthenticateVerifyDto,
  webauthnRegisterVerifyDto,
} from '@/domains/auth/sub-domains/auth-webauthn/webauthn.dto.js';

// ─── Tenancy: Organization ─────────────────────────────────────────────
import {
  createOrganizationDto,
  updateOrganizationDto,
  uploadLogoDto,
} from '@/domains/tenancy/sub-domains/organization/organization.dto.js';

import { updateOrganizationSettingsDto } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.dto.js';

import {
  createOrganizationNotificationPolicyDto,
  updateOrganizationNotificationPolicyDto,
} from '@/domains/tenancy/sub-domains/organization/organization-notification-policy/organization-notification-policy.dto.js';

import {
  createOrganizationApiKeyDto,
  updateOrganizationApiKeyDto,
} from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.dto.js';

// ─── Tenancy: Membership ───────────────────────────────────────────────
import {
  createMembershipDto,
  updateMembershipDto,
  transferOwnershipDto,
} from '@/domains/tenancy/sub-domains/membership/membership.dto.js';

import {
  acceptMembershipInvitationDto,
  previewMembershipInvitationDto,
  resendMembershipInvitationDto,
} from '@/domains/tenancy/sub-domains/membership/membership-invitation/membership-invitation.dto.js';

// ─── Tenancy: Roles & Permissions ──────────────────────────────────────
import {
  createMemberRoleDto,
  updateMemberRoleDto,
} from '@/domains/tenancy/sub-domains/member-roles/member-role.dto.js';

import { putMemberRolePermissionsDto } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.dto.js';

// ─── Billing ───────────────────────────────────────────────────────────
import {
  CreateSubscriptionDto,
  ChangePlanDto,
  emptyPaymentMethodBodyDto,
} from '@/domains/billing/sub-domains/subscription/subscription.dto.js';

// ─── Upload ────────────────────────────────────────────────────────────
import { createUploadDto } from '@/domains/upload/upload.dto.js';

// ─── Notify ────────────────────────────────────────────────────────────
import {
  CreateWebhookDto,
  UpdateWebhookDto,
} from '@/domains/notify/sub-domains/webhook/webhook.dto.js';

// ─── App: channel connection ───────────────────────────────────────────
import {
  channelAccountPickDto,
  channelConnectCallbackDto,
} from '@/domains/app/sub-domains/channel-connection/channel-connection.dto.js';
// ─── App: Instagram account ────────────────────────────────────────────
import { UpdateInstagramAccountSettingsDto } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.dto.js';
import { MetaSignedRequestDto } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta-callback.dto.js';

// ─── App: automations ──────────────────────────────────────────────────
import {
  createAutomationDto,
  emptyAutomationActionDto,
  keywordTestAutomationDto,
  pauseAutomationDto,
  updateAutomationDto,
} from '@/domains/app/sub-domains/automation/automation.dto.js';
import { startAutomationBackfillDto } from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.dto.js';

/**
 * Route key format: "METHOD /openapi/path" (with {param} placeholders).
 * Value: Zod schema for the request body.
 */
export const routeSchemaMap: Record<string, ZodTypeAny> = {
  // ── Auth ──
  'POST /api/v1/auth/email/send-code': EmailSendCodeDto,
  'POST /api/v1/auth/email/login': EmailLoginDto,
  'POST /api/v1/auth/email/confirm': EmailConfirmDto,
  // Apple's form post (route 124) — application/x-www-form-urlencoded, not JSON.
  'POST /api/v1/auth/oauth/apple/callback': AppleFormCallbackDto,
  'POST /api/v1/auth/me/mfa/verify': MfaVerifyDto,
  'POST /api/v1/auth/me/mfa/enroll': MfaEnrollDto,
  'POST /api/v1/auth/me/mfa/enroll/confirm': MfaEnrollConfirmDto,
  'POST /api/v1/auth/step-up': StepUpVerifyDto,
  'POST /api/v1/auth/mfa/login': MfaLoginVerifyDto,
  'POST /api/v1/auth/webauthn/authenticate/options': webauthnAuthenticateOptionsDto,
  'POST /api/v1/auth/webauthn/authenticate/verify': webauthnAuthenticateVerifyDto,
  'POST /api/v1/auth/me/webauthn/register/verify': webauthnRegisterVerifyDto,

  // ── Auth: Me (auth-specific) ──
  'POST /api/v1/auth/me/auth-methods': CreateAuthMethodDto,

  // ── User: Me (profile) ──
  'PATCH /api/v1/users/me': UpdateMeDto,
  'PUT /api/v1/users/me/presence': UpdateMyPresenceDto,
  'PATCH /api/v1/users/me/settings': UpdateUserSettingsDto,
  'PUT /api/v1/users/me/notification-preferences': PutNotificationPreferencesDto,
  'POST /api/v1/users/me/bug-reports': CreateUserBugReportDto,
  'POST /api/v1/users/me/email-confirmation': RequestEmailConfirmationDto,

  // ── Admin: Users ──
  'PATCH /api/v1/users/{user_id}': AdminUpdateUserDto,

  // ── Organizations ──
  'POST /api/v1/tenancy/organizations': createOrganizationDto,
  'PATCH /api/v1/tenancy/organization': updateOrganizationDto,
  'PUT /api/v1/tenancy/organization/logo': uploadLogoDto,
  'PATCH /api/v1/tenancy/organization/settings': updateOrganizationSettingsDto,

  // ── Organization: API Keys ──
  'POST /api/v1/tenancy/organization/api-keys': createOrganizationApiKeyDto,
  'PATCH /api/v1/tenancy/organization/api-keys/{api_key_id}': updateOrganizationApiKeyDto,

  // ── Organization: Notification Policies ──
  'POST /api/v1/tenancy/organization/notification-policies':
    createOrganizationNotificationPolicyDto,
  'PATCH /api/v1/tenancy/organization/notification-policies/{notification_policy_id}':
    updateOrganizationNotificationPolicyDto,

  // ── Memberships ──
  'POST /api/v1/tenancy/organization/memberships': createMembershipDto,
  'PATCH /api/v1/tenancy/organization/memberships/{membership_id}': updateMembershipDto,
  'POST /api/v1/tenancy/organization/transfer-ownership': transferOwnershipDto,

  // ── Invitations ── (add-member issues invitations via POST /organization/memberships, REQ-1)
  'POST /api/v1/tenancy/membership-invitations/{membership_invitation_id}/accept':
    acceptMembershipInvitationDto,
  'POST /api/v1/tenancy/membership-invitations/{membership_invitation_id}/preview':
    previewMembershipInvitationDto,
  'POST /api/v1/tenancy/organization/memberships/{membership_id}/invitation/resend':
    resendMembershipInvitationDto,

  // ── Roles ──
  'POST /api/v1/tenancy/organization/roles': createMemberRoleDto,
  'PATCH /api/v1/tenancy/organization/roles/{role_id}': updateMemberRoleDto,
  'PUT /api/v1/tenancy/organization/roles/{role_id}/permissions': putMemberRolePermissionsDto,

  // ── Billing: Subscriptions ──
  'POST /api/v1/billing/subscriptions': CreateSubscriptionDto,
  'POST /api/v1/billing/subscriptions/{subscription_id}/change-plan': ChangePlanDto,
  'POST /api/v1/billing/payment-methods/{payment_method_id}/default': emptyPaymentMethodBodyDto,

  // ── Webhooks ──
  'POST /api/v1/notify/webhooks': CreateWebhookDto,
  'PATCH /api/v1/notify/webhooks/{webhook_id}': UpdateWebhookDto,

  // ── Upload ──
  'POST /api/v1/uploads': createUploadDto,

  // ── User: Avatar & export ──
  'PUT /api/v1/users/me/avatar': UploadAvatarDto,
  'POST /api/v1/users/me/data-export': exportUserDataBodyDto,

  // ── App: channel connection ──
  'POST /api/v1/app/social/channel-connections/{provider}/callback': channelConnectCallbackDto,
  'POST /api/v1/app/social/channel-connections/{channel_connection_id}/accounts':
    channelAccountPickDto,
  // ── App: channel account ──
  'POST /api/v1/app/social/channel-accounts/{channel_account_id}/pause': emptyChannelAccountBodyDto,
  'POST /api/v1/app/social/channel-accounts/{channel_account_id}/resume':
    emptyChannelAccountBodyDto,
  'POST /api/v1/app/social/channel-accounts/{channel_account_id}/activate':
    activateChannelAccountDto,
  // ── App: Instagram account ──
  'PATCH /api/v1/app/social/instagram/accounts/{channel_account_id}/settings':
    UpdateInstagramAccountSettingsDto,
  // Meta's callbacks (routes 7–8): form-encoded, not JSON — see FORM_ENCODED_REQUEST_BODY_ROUTE_KEYS.
  'POST /api/v1/app/social/channel-connections/{provider}/deauthorize': MetaSignedRequestDto,
  'POST /api/v1/app/social/channel-connections/{provider}/data-deletion': MetaSignedRequestDto,

  // ── App: automations ──
  'POST /api/v1/app/automations': createAutomationDto,
  'PATCH /api/v1/app/automations/{automation_id}': updateAutomationDto,
  // The automation actions (DM-sending routes-final § 4.A.8, routes 32–35): go-live and duplicate
  // take an empty body, pause its mode, the keyword test its text.
  'POST /api/v1/app/automations/{automation_id}/go-live': emptyAutomationActionDto,
  'POST /api/v1/app/automations/{automation_id}/pause': pauseAutomationDto,
  'POST /api/v1/app/automations/{automation_id}/duplicate': emptyAutomationActionDto,
  'POST /api/v1/app/automations/{automation_id}/keyword-test': keywordTestAutomationDto,
  // The past-comments read's start (DM-sending routes-final § 4.C.8, route 38): its days.
  'POST /api/v1/app/automations/{automation_id}/backfills': startAutomationBackfillDto,
  // App: contacts (DM-sending routes-final § 3.A.8, routes 20 and 21).
  'PATCH /api/v1/app/contacts/{contact_id}': updateContactBodyDto,
  'POST /api/v1/app/contacts/bulk-actions': contactBulkActionBodyDto,
  // App: segments (DM-sending routes-final § 7.B.8, routes 78, 80 and 82).
  'POST /api/v1/app/segments': createSegmentBodyDto,
  'PATCH /api/v1/app/segments/{segment_id}': updateSegmentBodyDto,
  'POST /api/v1/app/segments/audience-count': segmentAudienceCountBodyDto,
  // App: broadcasts (DM-sending routes-final § 7.A.8, routes 71, 73, 75 and 76).
  'POST /api/v1/app/broadcasts': createBroadcastBodyDto,
  'PATCH /api/v1/app/broadcasts/{broadcast_id}': updateBroadcastBodyDto,
  'POST /api/v1/app/broadcasts/{broadcast_id}/send': sendBroadcastBodyDto,
  'POST /api/v1/app/broadcasts/{broadcast_id}/cancel': emptyBroadcastActionBodyDto,
  // The failed-message retries (routes 26 and 37, ROUTE R19): strictly empty bodies.
  'POST /api/v1/app/contacts/{contact_id}/failed-messages/retry': emptyContactActionBodyDto,
  'POST /api/v1/app/automations/{automation_id}/failed-messages/retry': emptyAutomationActionDto,
};
