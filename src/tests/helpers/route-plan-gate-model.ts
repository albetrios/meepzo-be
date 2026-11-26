import type { PlanFeatureKey } from '@/domains/billing/sub-domains/plan/plan.constants.js';
import type { RouteEntry } from '@/tests/helpers/route-catalog-registry.js';

/**
 * One plan gate a write route or a job passes before it does work a plan limits.
 *
 * @remarks
 * - `read_only_guard` — the app domain's `preHandler` (`createAppPlanAccessPreHandler`): `403
 *   organization_read_only` once a paid plan lapsed (D27, AQ8). The coverage test checks it is really
 *   attached, by its mark.
 * - `feature:<key>` — the plan's switch `<key>` (`PLAN_FEATURE_KEYS`, P83), through the one feature
 *   check (CA11) or the automation save: `403 plan_lacks_feature`.
 * - `account_limit` — the plan's `channel_accounts_max` (`409 plan_account_limit`, MC7, CA9), or —
 *   for a job — the account plan stops that hold an account out of the plan.
 * - `seat_limit` — the plan's seats (`409 seat_limit_reached`, REQ-4).
 * - `month_limit` — the plan's `message_month_limit`, checked by the send claim (SN8): a route that
 *   only puts messages back to `waiting` relies on it.
 */
export type PlanGate =
  | 'read_only_guard'
  | `feature:${PlanFeatureKey}`
  | 'account_limit'
  | 'seat_limit'
  | 'month_limit';

/**
 * A write route's declared plan gating: the gates it passes, or why it is deliberately open.
 *
 * @remarks
 * Exactly one of the two. `deliberatelyOpen` is a one-line reason a reviewer can check against the
 * code — "a read-only organization can still …" (D27) or "the work is checked later by …".
 */
export type PlanGateEntry =
  | { gates: readonly [PlanGate, ...PlanGate[]]; deliberatelyOpen?: never }
  | { deliberatelyOpen: string; gates?: never };

/**
 * Map of `"<METHOD> <path>"` (the route catalog's key, `routeModelKey` of the authorization model) →
 * its declared plan gating.
 */
export type RoutePlanGateModel = Readonly<Record<string, PlanGateEntry>>;

/** Map of a BullMQ job name → the gates the job's paid work passes. */
export type JobPlanGateModel = Readonly<Record<string, PlanGateEntry>>;

const IDENTITY_OPEN =
  'identity, sign-in and the session — never plan-gated (D27: a read-only organization still signs in)';
const USER_OPEN = "the user's own account and data — not an organization's plan";
const PAYING_OPEN =
  'paying is how an organization leaves Free or read-only (D27) — never plan-gated';
const TEAM_OPEN =
  'running the team — never plan-gated (D27: a read-only organization still manages its team)';
const REMOVING_OPEN = 'stopping or removing work never needs a plan (D27)';
const DRAFT_OPEN = 'saves a draft only; the plan is checked when it goes live or is sent';
const META_CALLBACK_OPEN =
  "Meta's own callback — signed by Meta, no organization plan to check; intake checks none either (plan:L4831), the send claim does (month_limit)";
const CONTACT_OPEN = "a contact's data — no paid work; erasure must always go through (D27, D54)";
const ACCOUNT_OPEN =
  'disconnects, pauses or re-logs an account already in the plan — no new plan room is used';

/** The automation go-live's feature parts (`listAutomationFeatureParts`, AU34). */
const AUTOMATION_PRO_FEATURES = [
  'feature:email_ask',
  'feature:phone_ask',
  'feature:reply_like_person',
  'feature:multiple_public_reply_lines',
  'feature:message_versions',
] as const satisfies readonly PlanGate[];

/**
 * Every registered write route (POST, PUT, PATCH, DELETE in `docs/routes.txt`) → the plan gates it
 * passes, or why it is deliberately open (owner 2026-11-26, plan-gating audit item 9).
 *
 * @remarks
 * - **Algorithm:** a reviewed table; `plan-gate-coverage.global.test.ts` fails on a catalog write
 *   route with no entry, an entry with no catalog route, an unknown gate, and a `read_only_guard`
 *   entry whose route does not run the marked guard (or the guard on a route not declared here).
 * - **Notes:** to add a route, run `pnpm routes:catalog`, then add its `"<METHOD> <path>"` line here
 *   in the domain block it belongs to — the declared gates as the service enforces them, or
 *   `deliberatelyOpen` with the one-line reason. Reads (GET) are never listed.
 */
export const ROUTE_PLAN_GATE_MODEL: RoutePlanGateModel = {
  // ── app: automations (routes 27–37; AU4, AU34, P10) ───────────────────────────────────────
  'POST /api/v1/app/automations': { deliberatelyOpen: DRAFT_OPEN },
  'PATCH /api/v1/app/automations/:automation_id': {
    // A live or paused automation may not turn on a PRO part the plan lacks (AU4 (2)).
    gates: AUTOMATION_PRO_FEATURES,
  },
  'DELETE /api/v1/app/automations/:automation_id': { deliberatelyOpen: REMOVING_OPEN },
  'POST /api/v1/app/automations/:automation_id/backfills': { gates: ['feature:past_comments'] },
  'POST /api/v1/app/automations/:automation_id/duplicate': { deliberatelyOpen: DRAFT_OPEN },
  'POST /api/v1/app/automations/:automation_id/failed-messages/retry': { gates: ['month_limit'] },
  'POST /api/v1/app/automations/:automation_id/go-live': {
    gates: [
      'read_only_guard',
      ...AUTOMATION_PRO_FEATURES,
      'feature:starter_questions',
      'month_limit',
    ],
  },
  'POST /api/v1/app/automations/:automation_id/keyword-test': {
    deliberatelyOpen: 'a dry run — writes and sends nothing',
  },
  'POST /api/v1/app/automations/:automation_id/pause': { deliberatelyOpen: REMOVING_OPEN },
  // ── app: broadcasts and segments (routes 67–83; BC3) ──────────────────────────────────────
  'POST /api/v1/app/broadcasts': { gates: ['feature:broadcasts'] },
  'PATCH /api/v1/app/broadcasts/:broadcast_id': { deliberatelyOpen: DRAFT_OPEN },
  'DELETE /api/v1/app/broadcasts/:broadcast_id': { deliberatelyOpen: REMOVING_OPEN },
  'POST /api/v1/app/broadcasts/:broadcast_id/cancel': { deliberatelyOpen: REMOVING_OPEN },
  'POST /api/v1/app/broadcasts/:broadcast_id/send': {
    gates: ['read_only_guard', 'feature:broadcasts', 'month_limit'],
  },
  'POST /api/v1/app/segments': { gates: ['feature:segments'] },
  'PATCH /api/v1/app/segments/:segment_id': { gates: ['feature:segments'] },
  'DELETE /api/v1/app/segments/:segment_id': { deliberatelyOpen: REMOVING_OPEN },
  'POST /api/v1/app/segments/audience-count': { gates: ['feature:segments'] },
  // ── app: contacts (routes 21–26) ─────────────────────────────────────────────────────────
  'PATCH /api/v1/app/contacts/:contact_id': { deliberatelyOpen: CONTACT_OPEN },
  'DELETE /api/v1/app/contacts/:contact_id': { deliberatelyOpen: CONTACT_OPEN },
  'POST /api/v1/app/contacts/:contact_id/failed-messages/retry': { gates: ['month_limit'] },
  'POST /api/v1/app/contacts/bulk-actions': { deliberatelyOpen: CONTACT_OPEN },
  // ── app: channel accounts and connections (routes 1–14, 40, 42; MC7, CA9) ─────────────────
  'DELETE /api/v1/app/social/channel-accounts/:channel_account_id': {
    deliberatelyOpen: ACCOUNT_OPEN,
  },
  'POST /api/v1/app/social/channel-accounts/:channel_account_id/activate': {
    gates: ['account_limit'],
  },
  'POST /api/v1/app/social/channel-accounts/:channel_account_id/pause': {
    deliberatelyOpen: ACCOUNT_OPEN,
  },
  'POST /api/v1/app/social/channel-accounts/:channel_account_id/resume': {
    deliberatelyOpen: 'lifts the owner pause only — the account is already in the plan (CA9)',
  },
  'DELETE /api/v1/app/social/channel-connections/:channel_connection_id': {
    deliberatelyOpen: ACCOUNT_OPEN,
  },
  'POST /api/v1/app/social/channel-connections/:channel_connection_id/accounts': {
    gates: ['account_limit'],
  },
  'POST /api/v1/app/social/channel-connections/:channel_connection_id/reconnect': {
    deliberatelyOpen: ACCOUNT_OPEN,
  },
  'POST /api/v1/app/social/channel-connections/:provider/callback': {
    deliberatelyOpen:
      "re-attaches the organization's own accounts only — a new account joins through the pick (account_limit)",
  },
  'POST /api/v1/app/social/channel-connections/:provider/data-deletion': {
    deliberatelyOpen: META_CALLBACK_OPEN,
  },
  'POST /api/v1/app/social/channel-connections/:provider/deauthorize': {
    deliberatelyOpen: META_CALLBACK_OPEN,
  },
  'POST /api/v1/app/social/channel-connections/:provider/start': {
    deliberatelyOpen: 'mints a one-use login state — nothing is connected yet',
  },
  'POST /api/v1/app/social/channel-connections/meta/webhooks/instagram': {
    deliberatelyOpen: META_CALLBACK_OPEN,
  },
  'PATCH /api/v1/app/social/instagram/accounts/:channel_account_id/settings': {
    // The settings a change turns on go through the one feature check (IA13, CA11).
    gates: ['feature:extra_delay', 'feature:mark_seen'],
  },
  // ── auth ─────────────────────────────────────────────────────────────────────────────────
  'POST /api/v1/auth/email/confirm': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/email/login': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/email/send-code': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/login': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/logout': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/me/auth-methods': { deliberatelyOpen: IDENTITY_OPEN },
  'DELETE /api/v1/auth/me/auth-methods/:auth_method_id': { deliberatelyOpen: IDENTITY_OPEN },
  'DELETE /api/v1/auth/me/mfa/:mfa_method_id': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/me/mfa/enroll': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/me/mfa/enroll/confirm': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/me/mfa/verify': { deliberatelyOpen: IDENTITY_OPEN },
  'DELETE /api/v1/auth/me/sessions': { deliberatelyOpen: IDENTITY_OPEN },
  'DELETE /api/v1/auth/me/sessions/:session_id': { deliberatelyOpen: IDENTITY_OPEN },
  'DELETE /api/v1/auth/me/webauthn/credentials/:credential_id': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/me/webauthn/register/options': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/me/webauthn/register/verify': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/mfa/login': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/oauth/apple/callback': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/password/change': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/password/forgot': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/password/reset': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/refresh': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/step-up': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/switch-to-organization': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/switch-to-personal': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/webauthn/authenticate/options': { deliberatelyOpen: IDENTITY_OPEN },
  'POST /api/v1/auth/webauthn/authenticate/verify': { deliberatelyOpen: IDENTITY_OPEN },
  // ── billing (routes 102–107; BL10) ───────────────────────────────────────────────────────
  'DELETE /api/v1/billing/payment-methods/:payment_method_id': { deliberatelyOpen: PAYING_OPEN },
  'POST /api/v1/billing/payment-methods/:payment_method_id/default': {
    deliberatelyOpen: PAYING_OPEN,
  },
  'POST /api/v1/billing/payment-methods/setup': { deliberatelyOpen: PAYING_OPEN },
  'POST /api/v1/billing/subscriptions': { deliberatelyOpen: PAYING_OPEN },
  'POST /api/v1/billing/subscriptions/:subscription_id/cancel': { deliberatelyOpen: PAYING_OPEN },
  'POST /api/v1/billing/subscriptions/:subscription_id/change-plan': {
    deliberatelyOpen: PAYING_OPEN,
  },
  'POST /api/v1/billing/subscriptions/:subscription_id/resume': { deliberatelyOpen: PAYING_OPEN },
  'POST /api/v1/billing/webhook': {
    deliberatelyOpen: "Stripe's signed webhook — it moves the plan state, it is not gated by it",
  },
  // ── mcp, internal ops ────────────────────────────────────────────────────────────────────
  'POST /api/v1/mcp': {
    deliberatelyOpen: 'the global-admin tool surface (super_admin) — no organization plan',
  },
  'POST /internal/ops/circuit-breakers/:circuit_name/reset': {
    deliberatelyOpen: 'operator endpoint (ops token) — no organization plan',
  },
  // ── notify ───────────────────────────────────────────────────────────────────────────────
  'DELETE /api/v1/notify/notifications/:notification_id': { deliberatelyOpen: USER_OPEN },
  'PATCH /api/v1/notify/notifications/:notification_id/read': { deliberatelyOpen: USER_OPEN },
  'POST /api/v1/notify/notifications/mark-all-read': { deliberatelyOpen: USER_OPEN },
  'POST /api/v1/notify/webhooks': {
    deliberatelyOpen:
      'an outgoing webhook — a platform integration with its own cap, no plan switch',
  },
  'PATCH /api/v1/notify/webhooks/:webhook_id': {
    deliberatelyOpen:
      'an outgoing webhook — a platform integration with its own cap, no plan switch',
  },
  'DELETE /api/v1/notify/webhooks/:webhook_id': { deliberatelyOpen: REMOVING_OPEN },
  'POST /api/v1/notify/webhooks/:webhook_id/test': {
    deliberatelyOpen: "one test delivery to the owner's own endpoint — no paid work",
  },
  // ── tenancy (REQ-4 seats) ────────────────────────────────────────────────────────────────
  'POST /api/v1/tenancy/membership-invitations/:membership_invitation_id/accept': {
    deliberatelyOpen: 'the invitation already holds its seat (seat_limit at the invite)',
  },
  'POST /api/v1/tenancy/membership-invitations/:membership_invitation_id/decline': {
    deliberatelyOpen: REMOVING_OPEN,
  },
  'POST /api/v1/tenancy/membership-invitations/:membership_invitation_id/preview': {
    deliberatelyOpen: 'reads an invitation by its token — writes nothing a plan limits',
  },
  'PATCH /api/v1/tenancy/organization': { deliberatelyOpen: TEAM_OPEN },
  'DELETE /api/v1/tenancy/organization': { deliberatelyOpen: REMOVING_OPEN },
  'POST /api/v1/tenancy/organization/api-keys': { deliberatelyOpen: TEAM_OPEN },
  'PATCH /api/v1/tenancy/organization/api-keys/:api_key_id': { deliberatelyOpen: TEAM_OPEN },
  'DELETE /api/v1/tenancy/organization/api-keys/:api_key_id': { deliberatelyOpen: REMOVING_OPEN },
  'POST /api/v1/tenancy/organization/api-keys/:api_key_id/rotate': { deliberatelyOpen: TEAM_OPEN },
  'POST /api/v1/tenancy/organization/leave': { deliberatelyOpen: REMOVING_OPEN },
  'PUT /api/v1/tenancy/organization/logo': { deliberatelyOpen: TEAM_OPEN },
  'DELETE /api/v1/tenancy/organization/logo': { deliberatelyOpen: TEAM_OPEN },
  'POST /api/v1/tenancy/organization/memberships': { gates: ['seat_limit'] },
  'PATCH /api/v1/tenancy/organization/memberships/:membership_id': {
    // A suspended member made active again takes a seat (`assertSeatAvailableForMemberAdd`).
    gates: ['seat_limit'],
  },
  'DELETE /api/v1/tenancy/organization/memberships/:membership_id': {
    deliberatelyOpen: REMOVING_OPEN,
  },
  'DELETE /api/v1/tenancy/organization/memberships/:membership_id/invitation': {
    deliberatelyOpen: REMOVING_OPEN,
  },
  'POST /api/v1/tenancy/organization/memberships/:membership_id/invitation/resend': {
    deliberatelyOpen: 'the invitation already holds its seat — a new email only',
  },
  'POST /api/v1/tenancy/organization/memberships/:membership_id/restore': {
    gates: ['seat_limit'],
  },
  'POST /api/v1/tenancy/organization/notification-policies': { deliberatelyOpen: TEAM_OPEN },
  'PATCH /api/v1/tenancy/organization/notification-policies/:notification_policy_id': {
    deliberatelyOpen: TEAM_OPEN,
  },
  'DELETE /api/v1/tenancy/organization/notification-policies/:notification_policy_id': {
    deliberatelyOpen: REMOVING_OPEN,
  },
  'POST /api/v1/tenancy/organization/roles': { deliberatelyOpen: TEAM_OPEN },
  'PATCH /api/v1/tenancy/organization/roles/:role_id': { deliberatelyOpen: TEAM_OPEN },
  'DELETE /api/v1/tenancy/organization/roles/:role_id': { deliberatelyOpen: REMOVING_OPEN },
  'PUT /api/v1/tenancy/organization/roles/:role_id/permissions': { deliberatelyOpen: TEAM_OPEN },
  'POST /api/v1/tenancy/organization/roles/:role_id/restore': { deliberatelyOpen: TEAM_OPEN },
  'PATCH /api/v1/tenancy/organization/settings': { deliberatelyOpen: TEAM_OPEN },
  'POST /api/v1/tenancy/organization/transfer-ownership': { deliberatelyOpen: TEAM_OPEN },
  'POST /api/v1/tenancy/organizations': {
    deliberatelyOpen: 'a new organization starts on Free — its plan gates what it does next',
  },
  // ── upload, user ─────────────────────────────────────────────────────────────────────────
  'POST /api/v1/uploads': {
    deliberatelyOpen: 'a file upload with its own per-type caps — no plan switch (UP1–UP5)',
  },
  'DELETE /api/v1/uploads/:upload_id': { deliberatelyOpen: REMOVING_OPEN },
  'POST /api/v1/uploads/:upload_id/confirm': {
    deliberatelyOpen: 'a file upload with its own per-type caps — no plan switch (UP1–UP5)',
  },
  'PATCH /api/v1/users/:user_id': {
    deliberatelyOpen: 'global-admin user management (super_admin) — no organization plan',
  },
  'DELETE /api/v1/users/:user_id': {
    deliberatelyOpen: 'global-admin user management (super_admin) — no organization plan',
  },
  'POST /api/v1/users/:user_id/suspend': {
    deliberatelyOpen: 'global-admin user management (super_admin) — no organization plan',
  },
  'POST /api/v1/users/:user_id/unsuspend': {
    deliberatelyOpen: 'global-admin user management (super_admin) — no organization plan',
  },
  'PATCH /api/v1/users/me': { deliberatelyOpen: USER_OPEN },
  'DELETE /api/v1/users/me': { deliberatelyOpen: USER_OPEN },
  'PUT /api/v1/users/me/avatar': { deliberatelyOpen: USER_OPEN },
  'DELETE /api/v1/users/me/avatar': { deliberatelyOpen: USER_OPEN },
  'POST /api/v1/users/me/bug-reports': { deliberatelyOpen: USER_OPEN },
  'POST /api/v1/users/me/data-export': { deliberatelyOpen: USER_OPEN },
  'POST /api/v1/users/me/email-confirmation': { deliberatelyOpen: USER_OPEN },
  'PUT /api/v1/users/me/notification-preferences': { deliberatelyOpen: USER_OPEN },
  'POST /api/v1/users/me/onboarding/complete': { deliberatelyOpen: USER_OPEN },
  'PUT /api/v1/users/me/presence': { deliberatelyOpen: USER_OPEN },
  'PATCH /api/v1/users/me/settings': { deliberatelyOpen: USER_OPEN },
};

const SEND_CLAIM_GATES = ['month_limit', 'account_limit'] as const satisfies readonly PlanGate[];

/**
 * Every queue job that sends a message or starts paid work → the plan gates it passes (owner
 * 2026-11-26, plan-gating audit item 9).
 *
 * @remarks
 * - **Algorithm:** a reviewed table keyed by the BullMQ job name; the coverage test fails on a name
 *   no source file under `src/domains/` declares any more (a stale entry) and on an unknown gate.
 * - **Notes:** `month_limit` here is the send claim's month check (SN8); `account_limit` the plan
 *   stops on the channel account (`plan_limit`, `plan_ended`, `plan_downgrade` — P99) that hold the
 *   account's lanes. A job that only enforces a plan (`plan-change`, `month-wake`,
 *   `repair-plan-stops`) or does no paid work (clean-ups, reads, notices) is not listed. A new job
 *   that sends or starts paid work is added here with its gates.
 */
export const JOB_PLAN_GATE_MODEL: JobPlanGateModel = {
  // The send lanes: every send goes through the claim (SN3, SN8) on an account the plan holds.
  'instagram-send-lane-turn': { gates: SEND_CLAIM_GATES },
  'instagram-send-fast-message': { gates: SEND_CLAIM_GATES },
  // A failed message put back to `waiting` (routes 37, 26) goes through the claim again.
  'retry-failed': { gates: SEND_CLAIM_GATES },
  // Intake starts runs; intake checks no plan (plan:L4831) — their messages meet the claim.
  'intake-messages': { gates: SEND_CLAIM_GATES },
  'intake-live': { gates: SEND_CLAIM_GATES },
  'intake-comments': { gates: SEND_CLAIM_GATES },
  'intake-tag-events': { gates: SEND_CLAIM_GATES },
  'missed-comment-check': { gates: SEND_CLAIM_GATES },
  // A broadcast's audience and its scheduled start put messages on the broadcast lane.
  'broadcast-audience': { gates: SEND_CLAIM_GATES },
  'repair-broadcast-start': { gates: SEND_CLAIM_GATES },
  // The past-comments read re-checks the plan's switch when it starts (AU32).
  'automation-backfill-read': { gates: ['feature:past_comments'] },
  // A segment's background count is skipped without the plan's switch.
  'segment-count': { gates: ['feature:segments'] },
};

/** Every gate shape the coverage test accepts (the `feature:` keys are checked separately). */
export const PLAN_GATE_KINDS = [
  'read_only_guard',
  'account_limit',
  'seat_limit',
  'month_limit',
] as const satisfies readonly PlanGate[];

/** Whether a catalog route is a write the model must cover (every method but GET). */
export function isWriteRoute(route: Pick<RouteEntry, 'method'>): boolean {
  return route.method !== 'GET';
}
