# Frontend route map — feat-meta-connect-flow-2026-11-26-bqmw

For the frontend: what changed in the API for this iteration's design drop, each design operation's
route, every route the API has, and the design features the backend dropped.

Section 3 is generated — `pnpm iteration:frontend-map feat-meta-connect-flow-2026-11-26-bqmw` rewrites it from `docs/routes.txt`, the
OpenAPI document and `plans/routes-final.md`. Write sections 1, 2 and 4 by hand.

## 1. What changes on every call

This iteration adds **4 routes (#151–#154) and changes 5** (#2, #3, #6, #7 and every `409 permission_not_granted`)
([route-changes.md](route-changes.md)). Paths go after `/api/v1/app/social`; `#n` is the number in
[routes-final.md](routes-final.md); the shapes are the OpenAPI document; every `reason` is in
[`docs/reference/api/response-codes.md`](../../../docs/reference/api/response-codes.md). Final at Close from
[AS-BUILT.md](../AS-BUILT.md) rows R1–R6.

| Topic | Rule |
| --- | --- |
| Meta's cancel | The return page posts Meta's own query (`state`, `error`, `error_reason`, `error_description`) to #2 when `code` is absent; the answer is `200 { outcome: "cancelled" }` — show "Connecting was cancelled", nothing saved. Never send `code` and `error` together (`400`) |
| The callback's `outcome` | `connected` · `reconnected` · `no_accounts_shared` (a reconnect that shared none: show "Share an account in your business portfolio") · `cancelled`; `marked_not_shared_account_ids` lists accounts now broken because the login no longer shares them |
| Errors that name the fix | `422 provider_permissions_missing` + `missing_permissions[]` · `409 channel_connection_business_mismatch` + `expected_client_business_id` · `409 plan_account_limit` + `plan_room` · `409 permission_not_granted` + `permission` (beside `feature`) · `422 provider_no_accounts_shared` (a **first** connect sharing none) |
| Message access | Routes #6, #7 carry `instagram.message_access { status: on \| off \| unknown, checked_at }`; #154 re-checks it (at most one Meta call a minute; `is_from_meta: false` when the stored answer was returned) |
| Capabilities | #153 is the one read for "what can this account do": the screen and the refusal use the same check, so they never disagree |
| Unpicked logins | A connection nobody picked from is revoked 7 days after its last login — show "Log in again" if the owner comes back later |

## 2. Each design operation → its route

| Design operation | Route(s) | Notes |
| --- | --- | --- |
| "Connect Instagram" button state (enabled, why not) | `GET /channel-connections/meta/connect-options` (#152) | `is_configured`, `is_page_login_offered` (offer "Connect with Facebook Page"), `can_manage`, `plan_room` |
| Start / reconnect the login | `POST /channel-connections/meta/start` (#1), `POST /channel-connections/{channel_connection_id}/reconnect` (#40) | unchanged |
| Meta return page | `POST /channel-connections/meta/callback` (#2) | send `{code, state}` or Meta's cancel `{state, error, …}`; branch on `outcome` |
| Account picker (first time or later) | `GET /channel-connections/{channel_connection_id}/shared-assets` (#151), then `POST …/{channel_connection_id}/accounts` (#3) | each asset `free` · `connected_here` · `connected_elsewhere` · `not_shared_any_more`; `meta.plan_room` sizes the picker; `meta.is_complete: false` → "showing the first 100" |
| Account settings: what works and what to fix | `GET /channel-accounts/{channel_account_id}/capabilities` (#153) | `features[]` with `reason`, `permission`, `plan_switch`, `fix`; `blockers[]` with `since` and `fix` (`reconnect`, `reconnect_with_page`, `turn_on_message_access`, `share_account_in_meta`, `upgrade`, `resume`, `none`) |
| "I turned on Allow access to messages — check again" | `POST /instagram/accounts/{channel_account_id}/message-access-checks` (#154) | no body; `instagram-account:manage`; `on` lifts the stop |

## 3. Every available route

<!-- GENERATED:START -->

211 routes, from `docs/routes.txt`.
Paths drop `/api/v1`; the health and operations routes in the last module sit outside it.
**Gate**: a permission code, `signed in`, `public`, `platform admin` or a token. **Idem** `req`:
`X-Idempotency-Key` required. **Team** `team`: team organizations only (`422` on a personal one).
**#**: the route review number (blank where the review does not name the route). Success is `200`,
or `204` for a `DELETE`. **What it does** is the OpenAPI summary.

| Module | Routes |
| --- | --- |
| [App (the product)](#app-the-product) | 64 |
| [Session and account](#session-and-account) | 52 |
| [Organization and team](#organization-and-team) | 44 |
| [Files](#files) | 4 |
| [Notifications and webhooks](#notifications-and-webhooks) | 14 |
| [Subscription billing (the platform)](#subscription-billing-the-platform) | 19 |
| [Platform administration and operations](#platform-administration-and-operations) | 14 |

### App (the product)

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/app/automations` | `automation:read` |  | team |  | List automations |
| POST | `/app/automations` | `automation:create` | req | team |  | Save an automation draft |
| GET | `/app/automations/:automation_id` | `automation:read` |  | team |  | Get an automation |
| PATCH | `/app/automations/:automation_id` | `automation:update` |  | team |  | Save automation content |
| DELETE | `/app/automations/:automation_id` | `automation:delete` |  | team |  | Delete an automation |
| POST | `/app/automations/:automation_id/backfills` | `automation:update` | req | team |  | Answer past comments |
| GET | `/app/automations/:automation_id/backfills/:automation_backfill_id` | `automation:read` |  | team |  | Get a past-comments read |
| POST | `/app/automations/:automation_id/duplicate` | `automation:create` | req | team |  | Duplicate an automation |
| POST | `/app/automations/:automation_id/failed-messages/retry` | `automation:update` | req | team |  | Retry an automation's failed messages |
| GET | `/app/automations/:automation_id/failed-messages/summary` | `automation:read` |  | team |  | Count an automation's failed messages |
| POST | `/app/automations/:automation_id/go-live` | `automation:update` |  | team |  | Go live |
| POST | `/app/automations/:automation_id/keyword-test` | `automation:read` |  | team |  | Try an automation keyword |
| POST | `/app/automations/:automation_id/pause` | `automation:update` |  | team |  | Pause an automation |
| GET | `/app/broadcasts` | `automation:read` |  | team |  | List broadcasts |
| POST | `/app/broadcasts` | `automation:create` | req | team |  | Create a broadcast draft |
| GET | `/app/broadcasts/:broadcast_id` | `automation:read` |  | team |  | Get a broadcast |
| PATCH | `/app/broadcasts/:broadcast_id` | `automation:update` |  | team |  | Update a broadcast draft |
| DELETE | `/app/broadcasts/:broadcast_id` | `automation:delete` |  | team |  | Delete a broadcast |
| POST | `/app/broadcasts/:broadcast_id/cancel` | `automation:update` | req | team |  | Cancel a broadcast |
| POST | `/app/broadcasts/:broadcast_id/send` | `automation:update` | req | team |  | Send a broadcast |
| GET | `/app/contact-tags` | `contact:read` |  | team |  | List contact tags |
| GET | `/app/contacts` | `contact:read` |  | team |  | List contacts |
| GET | `/app/contacts/:contact_id` | `contact:read` |  | team |  | Get a contact |
| PATCH | `/app/contacts/:contact_id` | `contact:update` |  | team |  | Update a contact |
| DELETE | `/app/contacts/:contact_id` | `contact:delete` |  | team |  | Delete a contact |
| GET | `/app/contacts/:contact_id/activity` | `contact:read` |  | team |  | List a contact's activity |
| POST | `/app/contacts/:contact_id/failed-messages/retry` | `contact:update` | req | team |  | Retry a contact's failed messages |
| GET | `/app/contacts/:contact_id/failed-messages/summary` | `contact:read` |  | team |  | Count a contact's failed messages |
| POST | `/app/contacts/bulk-actions` | `contact:update` | req | team |  | Run a bulk action on contacts |
| GET | `/app/segments` | `automation:read` |  | team |  | List segments |
| POST | `/app/segments` | `automation:create` | req | team |  | Create a segment |
| GET | `/app/segments/:segment_id` | `automation:read` |  | team |  | Get a segment |
| PATCH | `/app/segments/:segment_id` | `automation:update` |  | team |  | Update a segment |
| DELETE | `/app/segments/:segment_id` | `automation:delete` |  | team |  | Delete a segment |
| POST | `/app/segments/audience-count` | `automation:read` | req | team |  | Count a segment audience |
| GET | `/app/social/channel-accounts` | `channel-account:read` |  | team |  | List channel accounts |
| GET | `/app/social/channel-accounts/:channel_account_id` | `channel-account:read` |  | team |  | Get a channel account |
| DELETE | `/app/social/channel-accounts/:channel_account_id` | `channel-account:manage` |  | team |  | Disconnect a channel account |
| POST | `/app/social/channel-accounts/:channel_account_id/activate` | `channel-account:manage` | req | team |  | Choose an active channel account |
| GET | `/app/social/channel-accounts/:channel_account_id/capabilities` | `channel-account:read` |  | team |  | List what a channel account can do |
| POST | `/app/social/channel-accounts/:channel_account_id/pause` | `channel-account:manage` |  | team |  | Pause a channel account |
| POST | `/app/social/channel-accounts/:channel_account_id/resume` | `channel-account:manage` |  | team |  | Resume a channel account |
| GET | `/app/social/channel-connections` | `channel-account:read` |  | team |  | List channel connections |
| GET | `/app/social/channel-connections/:channel_connection_id` | `channel-account:read` |  | team |  | Get a channel connection |
| DELETE | `/app/social/channel-connections/:channel_connection_id` | `channel-account:manage` |  | team |  | Disconnect a business |
| POST | `/app/social/channel-connections/:channel_connection_id/accounts` | `channel-account:manage` | req | team |  | Connect picked channel accounts |
| GET | `/app/social/channel-connections/:channel_connection_id/ad-accounts` | `channel-account:read` |  | team |  | List a channel connection's ad accounts |
| GET | `/app/social/channel-connections/:channel_connection_id/ads` | `channel-account:read` |  | team |  | List one ad account's ads |
| POST | `/app/social/channel-connections/:channel_connection_id/reconnect` | `channel-account:manage` |  | team |  | Start a reconnect of a channel connection |
| GET | `/app/social/channel-connections/:channel_connection_id/shared-assets` | `channel-account:read` |  | team |  | List a channel connection's shared assets |
| POST | `/app/social/channel-connections/:provider/callback` | `channel-account:manage` | req | team |  | Finish a channel connection |
| GET | `/app/social/channel-connections/:provider/connect-options` | `channel-account:read` |  | team |  | Read the connect options |
| POST | `/app/social/channel-connections/:provider/data-deletion` | public |  |  |  | Meta: delete the person's data (data deletion) |
| POST | `/app/social/channel-connections/:provider/deauthorize` | public |  |  |  | Meta: the app was removed (deauthorize) |
| POST | `/app/social/channel-connections/:provider/start` | `channel-account:manage` |  | team |  | Start a channel connection |
| GET | `/app/social/channel-connections/meta/webhooks/instagram` | public |  |  |  | Verify the Instagram webhook subscription |
| POST | `/app/social/channel-connections/meta/webhooks/instagram` | public |  |  |  | Receive an Instagram webhook delivery |
| GET | `/app/social/instagram/accounts/:channel_account_id/media` | `instagram-account:read` |  | team |  | List Instagram posts and reels |
| POST | `/app/social/instagram/accounts/:channel_account_id/message-access-checks` | `instagram-account:manage` |  | team |  | Check message access now |
| GET | `/app/social/instagram/accounts/:channel_account_id/sending-status` | `instagram-account:read` |  | team |  | Get an Instagram account sending status |
| PATCH | `/app/social/instagram/accounts/:channel_account_id/settings` | `instagram-account:manage` |  | team |  | Change an Instagram account settings |
| GET | `/app/social/instagram/accounts/:channel_account_id/stories` | `instagram-account:read` |  | team |  | List live Instagram stories |
| GET | `/app/social/instagram/webhook-events` | `instagram-webhook-event:read` |  | team |  | List received Instagram webhook events |
| GET | `/app/usage` | `organization:read` |  | team |  | Get the organization usage |

### Session and account

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/auth/email/confirm` | public |  |  |  | Confirm the email with the emailed link |
| POST | `/auth/email/login` | public |  |  |  | Log in with an email verification code |
| POST | `/auth/email/send-code` | public |  |  |  | Send email sign-in code |
| POST | `/auth/login` | public |  |  |  | Login with email and password |
| POST | `/auth/logout` | token (access-token) |  |  |  | Logout current session |
| GET | `/auth/me/auth-methods` | signed in |  |  |  | List my auth methods |
| POST | `/auth/me/auth-methods` | signed in |  |  |  | Add auth method |
| DELETE | `/auth/me/auth-methods/:auth_method_id` | signed in |  |  |  | Remove auth method |
| GET | `/auth/me/context` | signed in |  |  |  | Get my session context |
| GET | `/auth/me/mfa` | signed in |  |  |  | List enrolled MFA methods |
| DELETE | `/auth/me/mfa/:mfa_method_id` | signed in |  |  |  | Remove MFA method |
| POST | `/auth/me/mfa/enroll` | signed in |  |  |  | Begin MFA enrollment (phase 1 of 2) |
| POST | `/auth/me/mfa/enroll/confirm` | signed in |  |  |  | Confirm MFA enrollment (phase 2 of 2) |
| POST | `/auth/me/mfa/verify` | signed in |  |  |  | Verify MFA code |
| GET | `/auth/me/sessions` | signed in |  |  |  | List my active sessions |
| DELETE | `/auth/me/sessions` | signed in |  |  |  | Revoke all sessions |
| DELETE | `/auth/me/sessions/:session_id` | signed in |  |  |  | Revoke a specific session |
| GET | `/auth/me/webauthn/credentials` | signed in |  |  |  | List registered passkeys |
| DELETE | `/auth/me/webauthn/credentials/:credential_id` | signed in |  |  |  | Revoke a passkey |
| POST | `/auth/me/webauthn/register/options` | signed in |  |  |  | Begin passkey registration |
| POST | `/auth/me/webauthn/register/verify` | signed in |  |  |  | Complete passkey registration |
| POST | `/auth/mfa/login` | public |  |  |  | Complete MFA during login |
| GET | `/auth/oauth/:provider` | public |  |  |  | Initiate OAuth flow |
| GET | `/auth/oauth/:provider/callback` | public |  |  |  | OAuth callback |
| POST | `/auth/oauth/apple/callback` | public |  |  |  | Apple's sign-in form callback |
| GET | `/auth/oauth/providers` | public |  |  |  | List available OAuth providers |
| POST | `/auth/password/change` | signed in |  |  |  | Change current password |
| POST | `/auth/password/forgot` | public |  |  |  | Request password reset |
| POST | `/auth/password/reset` | public |  |  |  | Reset password with token |
| POST | `/auth/refresh` | token (session-cookie) |  |  |  | Refresh access token |
| POST | `/auth/step-up` | signed in |  |  |  | Step-up (re-authenticate) |
| POST | `/auth/switch-to-organization` | signed in |  |  |  | Switch active organization |
| POST | `/auth/switch-to-personal` | signed in |  |  |  | Switch to personal organization |
| POST | `/auth/webauthn/authenticate/options` | public |  |  |  | Begin passkey authentication |
| POST | `/auth/webauthn/authenticate/verify` | public |  |  |  | Complete passkey authentication |
| GET | `/users/me` | signed in |  |  |  | Get current user profile |
| PATCH | `/users/me` | signed in |  |  |  | Update current user profile |
| DELETE | `/users/me` | signed in |  |  |  | Delete my account |
| PUT | `/users/me/avatar` | signed in |  |  |  | Upload avatar |
| DELETE | `/users/me/avatar` | signed in |  |  |  | Remove avatar |
| POST | `/users/me/bug-reports` | signed in |  |  |  | Report a bug |
| POST | `/users/me/data-export` | signed in |  |  |  | Request GDPR data export |
| GET | `/users/me/data-export/:data_export_id` | signed in |  |  |  | Get GDPR data export status |
| POST | `/users/me/email-confirmation` | signed in |  |  |  | Email me a confirm link |
| GET | `/users/me/membership-invitations` | signed in |  |  |  | List my invitations |
| GET | `/users/me/notification-preferences` | signed in |  |  |  | Get my notification preferences |
| PUT | `/users/me/notification-preferences` | signed in |  |  |  | Save notification preferences |
| POST | `/users/me/onboarding/complete` | signed in |  |  |  | Mark onboarding complete |
| GET | `/users/me/organizations` | signed in |  |  |  | List my organizations |
| PUT | `/users/me/presence` | signed in |  |  |  | Set my presence |
| GET | `/users/me/settings` | signed in |  |  |  | Get my settings |
| PATCH | `/users/me/settings` | signed in |  |  |  | Update my settings |

### Organization and team

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/tenancy/membership-invitations/:membership_invitation_id/accept` | signed in | req |  |  | Accept invitation |
| POST | `/tenancy/membership-invitations/:membership_invitation_id/decline` | signed in | req |  |  | Decline invitation |
| POST | `/tenancy/membership-invitations/:membership_invitation_id/preview` | public |  |  |  | Preview invitation |
| GET | `/tenancy/organization` | signed in |  |  |  | Get active organization |
| PATCH | `/tenancy/organization` | `organization:update` |  |  |  | Update organization |
| DELETE | `/tenancy/organization` | `organization:delete` |  | team |  | Delete organization |
| GET | `/tenancy/organization/api-keys` | `api-key:read` |  |  |  | List API keys |
| POST | `/tenancy/organization/api-keys` | `api-key:manage` | req |  |  | Create API key |
| GET | `/tenancy/organization/api-keys/:api_key_id` | `api-key:read` |  |  |  | Get API key |
| PATCH | `/tenancy/organization/api-keys/:api_key_id` | `api-key:manage` |  |  |  | Update API key |
| DELETE | `/tenancy/organization/api-keys/:api_key_id` | `api-key:manage` |  |  |  | Delete API key |
| POST | `/tenancy/organization/api-keys/:api_key_id/rotate` | `api-key:manage` |  |  |  | Rotate API key |
| GET | `/tenancy/organization/audit-logs` | `audit-log:read` |  |  |  | List organization audit logs |
| POST | `/tenancy/organization/leave` | signed in |  |  |  | Leave organization |
| PUT | `/tenancy/organization/logo` | `organization:update` |  |  |  | Upload organization logo |
| DELETE | `/tenancy/organization/logo` | `organization:update` |  |  |  | Remove organization logo |
| GET | `/tenancy/organization/memberships` | `membership:read` |  |  |  | List memberships |
| POST | `/tenancy/organization/memberships` | `membership:create` | req | team |  | Invite members by email |
| GET | `/tenancy/organization/memberships/:membership_id` | `membership:read` |  |  |  | Get membership |
| PATCH | `/tenancy/organization/memberships/:membership_id` | `membership:update` |  |  |  | Update membership |
| DELETE | `/tenancy/organization/memberships/:membership_id` | `membership:delete` |  |  |  | Remove membership |
| DELETE | `/tenancy/organization/memberships/:membership_id/invitation` | `membership:delete` |  |  |  | Revoke invitation |
| POST | `/tenancy/organization/memberships/:membership_id/invitation/resend` | `membership:update` | req |  |  | Resend invitation |
| GET | `/tenancy/organization/memberships/:membership_id/permissions` | `membership:read` |  |  |  | Get membership permissions |
| POST | `/tenancy/organization/memberships/:membership_id/restore` | `membership:delete` | req | team |  | Restore membership |
| GET | `/tenancy/organization/notification-policies` | `notification-policy:read` |  |  |  | List notification policies |
| POST | `/tenancy/organization/notification-policies` | `notification-policy:manage` | req |  |  | Create notification policy |
| GET | `/tenancy/organization/notification-policies/:notification_policy_id` | `notification-policy:read` |  |  |  | Get notification policy |
| PATCH | `/tenancy/organization/notification-policies/:notification_policy_id` | `notification-policy:manage` |  |  |  | Update notification policy |
| DELETE | `/tenancy/organization/notification-policies/:notification_policy_id` | `notification-policy:manage` |  |  |  | Delete notification policy |
| GET | `/tenancy/organization/roles` | `role:read` |  |  |  | List roles |
| POST | `/tenancy/organization/roles` | `role:create` | req | team |  | Create role |
| GET | `/tenancy/organization/roles/:role_id` | `role:read` |  |  |  | Get role |
| PATCH | `/tenancy/organization/roles/:role_id` | `role:update` |  |  |  | Update role |
| DELETE | `/tenancy/organization/roles/:role_id` | `role:delete` |  |  |  | Delete role |
| GET | `/tenancy/organization/roles/:role_id/permissions` | `role:read` |  |  |  | List role permissions |
| PUT | `/tenancy/organization/roles/:role_id/permissions` | `role:update` |  |  |  | Replace role permissions |
| POST | `/tenancy/organization/roles/:role_id/restore` | `role:delete` | req |  |  | Restore role |
| GET | `/tenancy/organization/settings` | `organization:read` |  |  |  | Get organization settings |
| PATCH | `/tenancy/organization/settings` | `organization:update` |  |  |  | Update organization settings |
| POST | `/tenancy/organization/transfer-ownership` | signed in | req | team |  | Transfer organization ownership |
| POST | `/tenancy/organizations` | signed in | req |  |  | Create organization |
| GET | `/tenancy/organizations/by-slug/:slug` | signed in |  |  |  | Get organization by slug |
| GET | `/tenancy/permissions` | signed in |  |  |  | List all permissions |

### Files

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/uploads` | signed in | req |  |  | Request pre-signed upload URL |
| GET | `/uploads/:upload_id` | signed in |  |  |  | Get upload metadata |
| DELETE | `/uploads/:upload_id` | signed in |  |  |  | Delete upload |
| POST | `/uploads/:upload_id/confirm` | signed in |  |  |  | Confirm uploaded object |

### Notifications and webhooks

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/notify/notifications` | signed in |  |  |  | List my notifications |
| GET | `/notify/notifications/:notification_id` | signed in |  |  |  | Get notification |
| DELETE | `/notify/notifications/:notification_id` | signed in |  |  |  | Delete notification |
| PATCH | `/notify/notifications/:notification_id/read` | signed in |  |  |  | Mark notification as read |
| POST | `/notify/notifications/mark-all-read` | signed in |  |  |  | Mark all notifications as read |
| GET | `/notify/notifications/unread-count` | signed in |  |  |  | Get unread notification count |
| GET | `/notify/webhook-events` | `webhook:read` |  |  |  | List dispatchable webhook event types |
| GET | `/notify/webhooks` | `webhook:read` |  |  |  | List webhooks |
| POST | `/notify/webhooks` | `webhook:manage` | req |  |  | Create webhook |
| GET | `/notify/webhooks/:webhook_id` | `webhook:read` |  |  |  | Get webhook |
| PATCH | `/notify/webhooks/:webhook_id` | `webhook:manage` |  |  |  | Update webhook |
| DELETE | `/notify/webhooks/:webhook_id` | `webhook:manage` |  |  |  | Delete webhook |
| GET | `/notify/webhooks/:webhook_id/delivery-attempts` | `webhook:read` |  |  |  | List webhook delivery attempts |
| POST | `/notify/webhooks/:webhook_id/test` | `webhook:manage` |  |  |  | Send test webhook |

### Subscription billing (the platform)

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/billing/entitlement-overrides` | platform admin |  |  |  | List an organization entitlement overrides (admin) |
| POST | `/billing/entitlement-overrides` | platform admin |  |  |  | Set an organization entitlement override (admin) |
| DELETE | `/billing/entitlement-overrides/:entitlement_override_id` | platform admin |  |  |  | Remove an organization entitlement override (admin) |
| GET | `/billing/entitlements` | `subscription:read` |  |  |  | Get the organization entitlements |
| GET | `/billing/invoices` | `subscription:read` |  |  |  | List billing invoices |
| GET | `/billing/payment-methods` | `subscription:read` |  |  |  | List payment methods |
| DELETE | `/billing/payment-methods/:payment_method_id` | `subscription:manage` |  | team |  | Remove payment method |
| POST | `/billing/payment-methods/:payment_method_id/default` | `subscription:manage` | req | team |  | Set default payment method |
| POST | `/billing/payment-methods/setup` | `subscription:manage` | req | team |  | Create payment method setup |
| GET | `/billing/plans` | public |  |  |  | List available plans |
| GET | `/billing/plans/:plan_id` | public |  |  |  | Get plan details |
| GET | `/billing/subscriptions` | `subscription:read` |  |  |  | List subscriptions |
| POST | `/billing/subscriptions` | `subscription:manage` | req | team |  | Create subscription |
| GET | `/billing/subscriptions/:subscription_id` | `subscription:read` |  |  |  | Get subscription |
| POST | `/billing/subscriptions/:subscription_id/cancel` | `subscription:manage` | req | team |  | Cancel subscription |
| POST | `/billing/subscriptions/:subscription_id/change-plan` | `subscription:manage` | req | team |  | Change subscription plan |
| GET | `/billing/subscriptions/:subscription_id/payment-setup` | `subscription:read` |  |  |  | Get payment setup for incomplete subscription |
| POST | `/billing/subscriptions/:subscription_id/resume` | `subscription:manage` | req | team |  | Resume cancelled subscription |
| POST | `/billing/webhook` | public |  |  |  | Stripe webhook receiver |

### Platform administration and operations

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/audit/logs` | platform admin |  |  |  | List audit logs (admin) |
| GET | `/mcp` | platform admin |  |  |  | MCP streamable HTTP (GET) |
| POST | `/mcp` | platform admin |  |  |  | MCP streamable HTTP (POST) |
| GET | `/users` | platform admin |  |  |  | List all users (admin) |
| GET | `/users/:user_id` | platform admin |  |  |  | Get user by ID (admin) |
| PATCH | `/users/:user_id` | platform admin |  |  |  | Update user (admin) |
| DELETE | `/users/:user_id` | platform admin |  |  |  | Delete user (admin) |
| POST | `/users/:user_id/suspend` | platform admin |  |  |  | Suspend user (admin) |
| POST | `/users/:user_id/unsuspend` | platform admin |  |  |  | Unsuspend user (admin) |
| GET | `/internal/ops/circuit-breakers` | token (metrics) |  |  |  | List the outbound circuit breakers (operations only) |
| POST | `/internal/ops/circuit-breakers/:circuit_name/reset` | token (ops-admin) |  |  |  | Reset one circuit breaker (operations only) |
| GET | `/livez` | public |  |  |  | Liveness probe |
| GET | `/readyz` | public |  |  |  | Readiness probe |
| GET | `/metrics` | token (metrics) |  |  |  | Prometheus metrics (operations only) |

<!-- GENERATED:END -->

## 4. In the design, dropped — remove from the frontend

none — every design point of the brief is built; the linked Facebook Page id (IG3) waits on owner test O6 and is not
in the contract yet.
