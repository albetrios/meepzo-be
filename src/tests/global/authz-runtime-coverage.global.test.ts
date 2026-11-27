import { describe, it, expect } from 'vitest';
import { loadRouteAuthorizationModel } from '@/tests/helpers/route-authorization-model.js';

/**
 * Structural parity between the authorization model and the reviewed attack-test map.
 *
 * Every modeled route must have a descriptive mapping below, with no orphan entries.
 * These labels document the intended security scenarios. This gate does not resolve
 * labels to test declarations, execute attacker requests, or prove that mapped tests
 * still exist. Observed authorization coverage must come from the security test run.
 */
const RUNTIME_COVERAGE: Readonly<Record<string, string>> = {
  // ── model: user — cross-user BOLA (object-ownership.security.test.ts) ──────
  'DELETE /api/v1/auth/me/auth-methods/:auth_method_id':
    'object-ownership: auth methods (step-up gated)',
  'DELETE /api/v1/auth/me/sessions/:session_id': 'object-ownership: sessions (step-up gated)',
  'DELETE /api/v1/auth/me/mfa/:mfa_method_id': 'object-ownership: MFA methods (step-up gated)',
  'DELETE /api/v1/auth/me/webauthn/credentials/:credential_id':
    'object-ownership: WebAuthn passkeys (step-up gated)',
  'DELETE /api/v1/notify/notifications/:notification_id': 'object-ownership: notifications',
  'GET /api/v1/notify/notifications/:notification_id': 'object-ownership: notifications',
  'PATCH /api/v1/notify/notifications/:notification_id/read': 'object-ownership: notifications',
  'GET /api/v1/uploads/:upload_id': 'object-ownership: uploads',
  'DELETE /api/v1/uploads/:upload_id': 'object-ownership: uploads',
  'POST /api/v1/uploads/:upload_id/confirm': 'object-ownership: uploads',
  'GET /api/v1/users/me/data-export/:data_export_id': 'object-ownership: data exports',

  // ── model: organization — cross-organization reads (cross-organization-resource.security.test.ts) ─────
  'GET /api/v1/billing/subscriptions/:subscription_id':
    'object-ownership: subscriptions (cross-organization)',
  'GET /api/v1/billing/subscriptions/:subscription_id/payment-setup':
    'object-ownership: subscription payment-setup (cross-organization)',
  'GET /api/v1/notify/webhooks/:webhook_id': 'cross-organization-resource: webhook',
  'GET /api/v1/notify/webhooks/:webhook_id/delivery-attempts':
    'cross-organization-resource: webhook delivery-attempts',
  'GET /api/v1/tenancy/organization/api-keys/:api_key_id': 'cross-organization-resource: API key',
  'GET /api/v1/tenancy/organization/memberships/:membership_id':
    'cross-organization-resource: membership',
  'GET /api/v1/tenancy/organization/memberships/:membership_id/permissions':
    'cross-organization-resource: membership permissions',
  'GET /api/v1/tenancy/organization/notification-policies/:notification_policy_id':
    'cross-organization-resource: notification policy',
  'GET /api/v1/tenancy/organization/roles/:role_id': 'cross-organization-resource: role',
  'GET /api/v1/tenancy/organization/roles/:role_id/permissions':
    'cross-organization-resource: role permissions',
  'GET /api/v1/tenancy/organizations/by-slug/:slug':
    'cross-organization-resource: organization by-slug',

  // ── model: organization — cross-organization writes (cross-organization-mutation.security.test.ts) ────
  // The card routes (feat-instagram-dm-sending § 8.C): another organization's Stripe card answers 404
  // and nothing is detached or set — subscription-payment-method.integration.test.ts.
  'DELETE /api/v1/billing/payment-methods/:payment_method_id':
    'subscription-payment-method: another organization card (cross-organization, no mutation)',
  'POST /api/v1/billing/payment-methods/:payment_method_id/default':
    'subscription-payment-method: another organization card (cross-organization, no mutation)',
  'POST /api/v1/billing/subscriptions/:subscription_id/cancel':
    'cross-organization-mutation: subscription cancel',
  'POST /api/v1/billing/subscriptions/:subscription_id/change-plan':
    'cross-organization-mutation: subscription change-plan',
  'POST /api/v1/billing/subscriptions/:subscription_id/resume':
    'cross-organization-mutation: subscription resume',
  'PATCH /api/v1/notify/webhooks/:webhook_id': 'cross-organization-mutation: webhook PATCH',
  'POST /api/v1/notify/webhooks/:webhook_id/test': 'cross-organization-mutation: webhook test',
  'PATCH /api/v1/tenancy/organization/api-keys/:api_key_id':
    'cross-organization-mutation: API key PATCH',
  'DELETE /api/v1/tenancy/organization/api-keys/:api_key_id':
    'cross-organization-mutation: API key DELETE',
  'POST /api/v1/tenancy/organization/api-keys/:api_key_id/rotate':
    'cross-organization-mutation: API key rotate',
  'DELETE /api/v1/notify/webhooks/:webhook_id': 'cross-organization-mutation: webhook DELETE',
  // Launch R8: contact.integration.test.ts erases another organization's contact → 404
  // contact_not_found, and reads the row back unchanged.
  'DELETE /api/v1/app/contacts/:contact_id': 'cross-organization-mutation: contact DELETE',
  // feat-instagram-dm-sending R10: contact.integration.test.ts opens and changes another
  // organization's contact → 404 contact_not_found, and reads the row back unchanged.
  'GET /api/v1/app/contacts/:contact_id': 'cross-organization-resource: contact',
  'PATCH /api/v1/app/contacts/:contact_id': 'cross-organization-mutation: contact PATCH',
  // Launch R9: automation.integration.test.ts reads, edits and deletes another organization's
  // automation → 404 automation_not_found, and reads the row back unchanged.
  'GET /api/v1/app/automations/:automation_id': 'cross-organization-resource: automation',
  'PATCH /api/v1/app/automations/:automation_id': 'cross-organization-mutation: automation PATCH',
  'DELETE /api/v1/app/automations/:automation_id': 'cross-organization-mutation: automation DELETE',
  // feat-instagram-dm-sending R21: broadcast-segment.integration.test.ts reads, edits and deletes
  // another organization's segment → 404 segment_not_found, and reads the row back unchanged.
  'GET /api/v1/app/segments/:segment_id': 'cross-organization-resource: segment',
  'PATCH /api/v1/app/segments/:segment_id': 'cross-organization-mutation: segment PATCH',
  'DELETE /api/v1/app/segments/:segment_id': 'cross-organization-mutation: segment DELETE',
  // feat-instagram-dm-sending R22: broadcast.integration.test.ts reads, edits, sends, cancels and
  // deletes another organization's broadcast → 404 broadcast_not_found, and reads the row back
  // unchanged.
  'GET /api/v1/app/broadcasts/:broadcast_id': 'cross-organization-resource: broadcast',
  'PATCH /api/v1/app/broadcasts/:broadcast_id': 'cross-organization-mutation: broadcast PATCH',
  'DELETE /api/v1/app/broadcasts/:broadcast_id': 'cross-organization-mutation: broadcast DELETE',
  'POST /api/v1/app/broadcasts/:broadcast_id/send': 'cross-organization-mutation: broadcast send',
  'POST /api/v1/app/broadcasts/:broadcast_id/cancel':
    'cross-organization-mutation: broadcast cancel',
  // feat-instagram-dm-sending R13: automation.integration.test.ts runs the four actions on another
  // organization's automation → 404 automation_not_found, and reads the row back unchanged.
  'POST /api/v1/app/automations/:automation_id/go-live':
    'cross-organization-mutation: automation go-live',
  'POST /api/v1/app/automations/:automation_id/pause':
    'cross-organization-mutation: automation pause',
  'POST /api/v1/app/automations/:automation_id/duplicate':
    'cross-organization-mutation: automation duplicate',
  'POST /api/v1/app/automations/:automation_id/keyword-test':
    'cross-organization-resource: automation keyword test',
  // feat-instagram-dm-sending R15: automation-backfill.integration.test.ts starts a read on another
  // organization's automation → 404 automation_not_found with no row written, and reads another
  // organization's read → 404.
  'POST /api/v1/app/automations/:automation_id/backfills':
    'cross-organization-mutation: automation backfill start',
  'GET /api/v1/app/automations/:automation_id/backfills/:automation_backfill_id':
    'cross-organization-resource: automation backfill',
  // feat-instagram-dm-sending R19: instagram-outgoing-message.integration.test.ts reads another
  // organization's contact activity and failed messages and an automation's → 404; the retries
  // → 404 with every message unchanged.
  'GET /api/v1/app/contacts/:contact_id/activity': 'cross-organization-resource: contact activity',
  'GET /api/v1/app/contacts/:contact_id/failed-messages/summary':
    'cross-organization-resource: contact failed messages',
  'POST /api/v1/app/contacts/:contact_id/failed-messages/retry':
    'cross-organization-mutation: contact failed-message retry',
  'GET /api/v1/app/automations/:automation_id/failed-messages/summary':
    'cross-organization-resource: automation failed messages',
  'POST /api/v1/app/automations/:automation_id/failed-messages/retry':
    'cross-organization-mutation: automation failed-message retry',
  // feat-instagram-dm-sending R3: channel-connection.integration.test.ts reads, reconnects, picks
  // and disconnects another organization's connection → 404 channel_connection_not_found with the
  // row and token unchanged; a login state another organization started is refused (400) and
  // nothing is saved; start mints a state bound to the caller's own organization only.
  'GET /api/v1/app/social/channel-connections/:channel_connection_id':
    'cross-organization-resource: channel connection',
  // feat-instagram-dm-sending R4: channel-connection-ad-picker.integration.test.ts reads another
  // organization's connection's ad accounts and ads → 404 channel_connection_not_found, no Meta call.
  'GET /api/v1/app/social/channel-connections/:channel_connection_id/ad-accounts':
    'cross-organization-resource: channel connection ad accounts',
  'GET /api/v1/app/social/channel-connections/:channel_connection_id/ads':
    'cross-organization-resource: channel connection ads',
  // feat-meta-connect-flow R3: channel-connection.integration.test.ts lists another organization's
  // connection's shared assets → 404 channel_connection_not_found, no Meta call; connect-options
  // carries no object id — it answers from the caller's own permission and the app's Meta config.
  'GET /api/v1/app/social/channel-connections/:channel_connection_id/shared-assets':
    'cross-organization-resource: channel connection shared assets',
  'GET /api/v1/app/social/channel-connections/:provider/connect-options':
    'cross-organization-resource: no object id, the caller organization permission only',
  'DELETE /api/v1/app/social/channel-connections/:channel_connection_id':
    'cross-organization-mutation: channel connection DELETE',
  'POST /api/v1/app/social/channel-connections/:channel_connection_id/accounts':
    'cross-organization-mutation: channel connection pick',
  'POST /api/v1/app/social/channel-connections/:channel_connection_id/reconnect':
    'cross-organization-mutation: channel connection reconnect',
  'POST /api/v1/app/social/channel-connections/:provider/callback':
    'cross-organization-mutation: channel connect state of another organization',
  'POST /api/v1/app/social/channel-connections/:provider/start':
    'cross-organization-resource: the state is bound to the caller organization',
  // The channel account (feat-instagram-dm-sending R5, routes 7–11): another organization's account
  // is 404 channel_account_not_found and unchanged (channel-account.integration.test.ts).
  'GET /api/v1/app/social/channel-accounts/:channel_account_id':
    'cross-organization-resource: channel account',
  // feat-meta-connect-flow R4: channel-account-capabilities.integration.test.ts reads another
  // organization's account's capabilities → 404 channel_account_not_found.
  'GET /api/v1/app/social/channel-accounts/:channel_account_id/capabilities':
    'cross-organization-resource: channel account capabilities',
  'GET /api/v1/app/social/instagram/accounts/:channel_account_id/sending-status':
    "cross-organization-resource: Instagram sending status (route 63 — another organization's account answers 404 instagram_not_connected, instagram-sending.integration.test.ts)",
  'GET /api/v1/app/usage':
    'organization-scoped read: the DM meter of the token organization only (route 64 — keyed on the verified org claim, instagram-sending.integration.test.ts)',
  'DELETE /api/v1/app/social/channel-accounts/:channel_account_id':
    'cross-organization-mutation: channel account DELETE',
  'PATCH /api/v1/app/social/instagram/accounts/:channel_account_id/settings':
    'cross-organization-mutation: Instagram account settings (route 12 — another organization answers 404 channel_account_not_found, nothing written)',
  // feat-meta-connect-flow R5: instagram-account-message-access.integration.test.ts checks another
  // organization's account → 404 channel_account_not_found, no Meta call, nothing stored.
  'POST /api/v1/app/social/instagram/accounts/:channel_account_id/message-access-checks':
    'cross-organization-mutation: Instagram message-access check (route 154)',
  'POST /api/v1/app/social/channel-accounts/:channel_account_id/pause':
    'cross-organization-mutation: channel account pause',
  'POST /api/v1/app/social/channel-accounts/:channel_account_id/resume':
    'cross-organization-mutation: channel account resume',
  'POST /api/v1/app/social/channel-accounts/:channel_account_id/activate':
    'cross-organization-mutation: channel account activate',
  // The pickers (feat-instagram-dm-sending R8, routes 13–14): another organization's or a revoked
  // account is 404 channel_account_not_found and Meta is never called
  // (instagram-media.integration.test.ts).
  'GET /api/v1/app/social/instagram/accounts/:channel_account_id/media':
    'cross-organization-resource: Instagram posts of a channel account',
  'GET /api/v1/app/social/instagram/accounts/:channel_account_id/stories':
    'cross-organization-resource: Instagram stories of a channel account',
  'PATCH /api/v1/tenancy/organization/notification-policies/:notification_policy_id':
    'cross-organization-mutation: notification policy PATCH',
  'DELETE /api/v1/tenancy/organization/notification-policies/:notification_policy_id':
    'cross-organization-mutation: notification policy DELETE',
  'PATCH /api/v1/tenancy/organization/roles/:role_id': 'cross-organization-mutation: role PATCH',
  'DELETE /api/v1/tenancy/organization/roles/:role_id': 'cross-organization-mutation: role DELETE',
  'POST /api/v1/tenancy/organization/roles/:role_id/restore':
    'cross-organization-mutation: role restore',
  'DELETE /api/v1/tenancy/organization/memberships/:membership_id/invitation':
    'cross-organization-mutation: invitation DELETE',
  'POST /api/v1/tenancy/organization/memberships/:membership_id/invitation/resend':
    'cross-organization-mutation: invitation resend',

  // ── model: tier:owner (tier-and-grant.security.test.ts) ────────────────────
  'POST /api/v1/tenancy/organization/transfer-ownership':
    'tier-and-grant: non-owner transfer-ownership → 403',
  'POST /api/v1/tenancy/organization/leave': 'tier-and-grant: owner cannot leave → 403',
  'PATCH /api/v1/tenancy/organization/memberships/:membership_id':
    "tier-and-grant: cannot modify owner's membership → 403",
  'DELETE /api/v1/tenancy/organization/memberships/:membership_id':
    "tier-and-grant: cannot remove owner's membership → 403",
  'POST /api/v1/tenancy/organization/memberships/:membership_id/restore':
    'cross-organization-resource: membership restore',

  // ── model: grant (tier-and-grant.security.test.ts) ─────────────────────────
  'PUT /api/v1/tenancy/organization/roles/:role_id/permissions':
    'tier-and-grant: cannot grant un-held permission → 403',

  // ── model: email (invitation-email.security.test.ts) ───────────────────────
  'POST /api/v1/tenancy/membership-invitations/:membership_invitation_id/accept':
    'invitation-email: email-mismatch accept → 403',
  'POST /api/v1/tenancy/membership-invitations/:membership_invitation_id/decline':
    'invitation-email: email-mismatch decline → 403',

  // ── model: global-role (admin-only.security.test.ts) ───────────────────────
  'GET /api/v1/users/:user_id': 'admin-only: regular user denied',
  'PATCH /api/v1/users/:user_id': 'admin-only: regular user denied',
  'DELETE /api/v1/users/:user_id': 'admin-only: regular user denied',
  'POST /api/v1/users/:user_id/suspend': 'admin-only: regular user denied',
  'POST /api/v1/users/:user_id/unsuspend': 'admin-only: regular user denied',
  'DELETE /api/v1/billing/entitlement-overrides/:entitlement_override_id':
    'admin-only: regular user denied',
};

describe('Global: authorization-model attack-test mapping parity', () => {
  const model = loadRouteAuthorizationModel();

  it('every modeled route has a reviewed attack-test mapping', () => {
    const missing = Object.keys(model).filter((key) => !(key in RUNTIME_COVERAGE));
    expect(
      missing,
      `Modeled routes missing an attack-test mapping (review the security scenario and document it here):\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('every runtime-coverage entry maps to a real modelled route (no stale entries)', () => {
    const orphans = Object.keys(RUNTIME_COVERAGE).filter((key) => !(key in model));
    expect(orphans, `Stale runtime-coverage entries:\n${orphans.join('\n')}`).toEqual([]);
  });
});
