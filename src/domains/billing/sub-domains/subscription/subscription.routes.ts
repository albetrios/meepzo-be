import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { BILLING_PERMISSIONS } from '@/domains/billing/billing.permissions.js';
import type { SubscriptionService } from './subscription.service.js';
import { createSubscriptionController } from './subscription.controller.js';
import {
  ChangePlanDto,
  CreateSubscriptionDto,
  emptyPaymentMethodBodyDto,
  paymentMethodIdParamsDto,
  subscriptionIdParamsDto,
} from './subscription.dto.js';
import { PLAN_GATE_OPEN_REASON } from '@/domains/billing/sub-domains/entitlement/entitlement.constants.js';

/**
 * Fastify plugin factory that mounts the organization-scoped subscription
 * endpoints (CRUD + change-plan / cancel / resume). All routes require auth
 * and a {@link BILLING_PERMISSIONS} permission; create additionally enforces
 * the `X-Idempotency-Key` header (`idempotencyRequired: true`) on externally
 * mutating billing routes.
 */
export function subscriptionRoutes(service: SubscriptionService): FastifyPluginAsync {
  const controller = createSubscriptionController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.get(
      '/subscriptions',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(BILLING_PERMISSIONS.SUBSCRIPTION_READ)],
        schema: {
          summary: 'List subscriptions',
          description:
            'Returns all subscriptions for the organization. Requires SUBSCRIPTION_READ permission.',
          tags: ['Subscription'],
        },
      },
      controller.listSubscriptions,
    );
    zodApplication.get<{ Params: { subscription_id: string } }>(
      '/subscriptions/:subscription_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(BILLING_PERMISSIONS.SUBSCRIPTION_READ)],
        schema: {
          summary: 'Get subscription',
          description:
            'Returns a single subscription with its current status. Requires SUBSCRIPTION_READ permission.',
          tags: ['Subscription'],
          params: subscriptionIdParamsDto,
        },
      },
      controller.getSubscription,
    );
    zodApplication.post(
      '/subscriptions',
      {
        config: {
          idempotencyRequired: true,
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { open: PLAN_GATE_OPEN_REASON.PAYING },
        },
        schema: {
          summary: 'Create subscription',
          description:
            "Creates a new subscription for the organization — or, with `is_trial: true`, starts the 7-day no-card trial of a paid plan (Creator or Studio): the plan's features at once, `trial_end` 7 days ahead, Stripe cancels it at the end unless a card was added. One trial per organization and per Instagram account, ever (`409 trial_already_used`); `422 plan_has_no_trial` on Free. Only one active subscription is allowed. Requires SUBSCRIPTION_MANAGE permission. Send an `X-Idempotency-Key` header (min 16 characters) on this write — the key is forwarded to Stripe when billing is configured. See docs/reference/reliability/idempotency.md.",
          tags: ['Subscription'],
          body: CreateSubscriptionDto,
        },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE)],
      },
      controller.createSubscription,
    );
    zodApplication.post<{ Params: { subscription_id: string } }>(
      '/subscriptions/:subscription_id/change-plan',
      {
        config: {
          idempotencyRequired: true,
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { open: PLAN_GATE_OPEN_REASON.PAYING },
        },
        schema: {
          summary: 'Change subscription plan',
          description:
            "Changes the subscription's plan. A dearer plan applies at once with proration. A cheaper plan or Free waits for the period end (a Stripe subscription schedule; Free cancels at the period end) — the answer carries `scheduled_change`, and `keep_channel_account_ids` (0–10 of this organization's connected `cha_…` accounts, at most the new plan's limit) picks the accounts that stay active (none given: the oldest connected). The current plan again takes the scheduled move back. Requires SUBSCRIPTION_MANAGE permission. Send an `X-Idempotency-Key` header (min 16 characters) on this write — the key is forwarded to Stripe when billing is configured. See docs/reference/reliability/idempotency.md.",
          tags: ['Subscription'],
          params: subscriptionIdParamsDto,
          body: ChangePlanDto,
        },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE)],
      },
      controller.changePlan,
    );
    zodApplication.post<{ Params: { subscription_id: string } }>(
      '/subscriptions/:subscription_id/cancel',
      {
        config: {
          idempotencyRequired: true,
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { open: PLAN_GATE_OPEN_REASON.PAYING },
        },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE)],
        schema: {
          summary: 'Cancel subscription',
          description:
            'Cancels the subscription. By default, access continues until the end of the current billing period. Requires SUBSCRIPTION_MANAGE permission. Send an `X-Idempotency-Key` header (min 16 characters) on this write — the key is forwarded to Stripe when billing is configured. See docs/reference/reliability/idempotency.md.',
          tags: ['Subscription'],
          params: subscriptionIdParamsDto,
        },
      },
      controller.cancelSubscription,
    );
    zodApplication.post<{ Params: { subscription_id: string } }>(
      '/subscriptions/:subscription_id/resume',
      {
        config: {
          idempotencyRequired: true,
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { open: PLAN_GATE_OPEN_REASON.PAYING },
        },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE)],
        schema: {
          summary: 'Resume cancelled subscription',
          description:
            'Resumes a subscription that was previously cancelled but has not yet expired. Requires SUBSCRIPTION_MANAGE permission. Send an `X-Idempotency-Key` header (min 16 characters) on this write — the key is forwarded to Stripe when billing is configured. See docs/reference/reliability/idempotency.md.',
          tags: ['Subscription'],
          params: subscriptionIdParamsDto,
        },
      },
      controller.resumeSubscription,
    );
    zodApplication.get<{ Params: { subscription_id: string } }>(
      '/subscriptions/:subscription_id/payment-setup',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(BILLING_PERMISSIONS.SUBSCRIPTION_READ)],
        schema: {
          summary: 'Get payment setup for incomplete subscription',
          description:
            'Returns the Stripe PaymentIntent client_secret for an INCOMPLETE subscription so the frontend can confirm the first payment. Requires SUBSCRIPTION_READ permission.',
          tags: ['Subscription'],
          params: subscriptionIdParamsDto,
        },
      },
      controller.getPaymentSetup,
    );
    zodApplication.get(
      '/invoices',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(BILLING_PERMISSIONS.SUBSCRIPTION_READ)],
        schema: {
          summary: 'List billing invoices',
          description:
            "Returns Stripe invoices for the active organization's billing customer. Requires SUBSCRIPTION_READ.",
          tags: ['Subscription'],
        },
      },
      controller.listInvoices,
    );
    zodApplication.get(
      '/payment-methods',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(BILLING_PERMISSIONS.SUBSCRIPTION_READ)],
        schema: {
          summary: 'List payment methods',
          description:
            "Returns card payment methods saved for the organization's Stripe customer. Requires SUBSCRIPTION_READ.",
          tags: ['Subscription'],
        },
      },
      controller.listPaymentMethods,
    );
    zodApplication.delete<{ Params: { payment_method_id: string } }>(
      '/payment-methods/:payment_method_id',
      {
        config: {
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { open: PLAN_GATE_OPEN_REASON.PAYING },
        },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE)],
        schema: {
          summary: 'Remove payment method',
          description:
            "Removes a card from the organization's Stripe customer. `{payment_method_id}` is Stripe's `pm_…` card id; a card that is not this organization's answers 404. The only card cannot be removed while a paid plan is on (active, past due, unpaid or trialing) — `409 default_card_in_use`; add another card first. Team organizations only. Requires SUBSCRIPTION_MANAGE permission.",
          tags: ['Subscription'],
          params: paymentMethodIdParamsDto,
        },
      },
      controller.deletePaymentMethod,
    );
    zodApplication.post<{ Params: { payment_method_id: string } }>(
      '/payment-methods/:payment_method_id/default',
      {
        config: {
          idempotencyRequired: true,
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { open: PLAN_GATE_OPEN_REASON.PAYING },
        },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE)],
        schema: {
          summary: 'Set default payment method',
          description:
            "Makes the card the default — the Stripe customer's invoice default and the live subscription's — and answers the organization's cards with `is_default`. `{payment_method_id}` is Stripe's `pm_…` card id; a card that is not this organization's answers 404. Repeating it for the default card gives the same answer. No body. Team organizations only. Requires SUBSCRIPTION_MANAGE permission. Send an `X-Idempotency-Key` header (min 16 characters) on this write — the key is forwarded to Stripe. See docs/reference/reliability/idempotency.md.",
          tags: ['Subscription'],
          params: paymentMethodIdParamsDto,
          body: emptyPaymentMethodBodyDto,
        },
      },
      controller.setDefaultPaymentMethod,
    );
    zodApplication.post(
      '/payment-methods/setup',
      {
        config: {
          idempotencyRequired: true,
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { open: PLAN_GATE_OPEN_REASON.PAYING },
        },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE)],
        schema: {
          summary: 'Create payment method setup',
          description:
            'Returns a SetupIntent client_secret so the frontend can collect a new card in-app. Requires SUBSCRIPTION_MANAGE and X-Idempotency-Key.',
          tags: ['Subscription'],
        },
      },
      controller.createPaymentMethodSetup,
    );
  };
}
