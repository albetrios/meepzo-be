import type { FastifyInstance } from 'fastify';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { MembershipSeatUsagePort } from './sub-domains/subscription/subscription.service.js';
import { PlanRepository } from './sub-domains/plan/plan.repository.js';
import { SubscriptionRepository } from './sub-domains/subscription/subscription.repository.js';
import { PlanService } from './sub-domains/plan/plan.service.js';
import { StripePaymentProvider } from './sub-domains/subscription/stripe-payment-provider.js';
import { SubscriptionService } from './sub-domains/subscription/subscription.service.js';
import { SubscriptionTrialService } from './sub-domains/subscription/subscription-trial.service.js';
import { TrialAccountRepository } from './sub-domains/subscription/trial-account.repository.js';
import { StripeWebhookService } from './sub-domains/stripe-webhook/stripe-webhook.service.js';
import { StripeWebhookEventRepository } from './sub-domains/stripe-webhook/stripe-webhook-event.repository.js';
import { EntitlementOverrideRepository } from './sub-domains/entitlement/entitlement-override.repository.js';
import { EntitlementService } from './sub-domains/entitlement/entitlement.service.js';

/**
 * Services exposed by the billing domain composition root for routes and the
 * Fastify decoration `app.billingDomain`.
 */
export type BillingContainer = {
  planService: PlanService;
  subscriptionService: SubscriptionService;
  /**
   * The one-trial rules (feat-instagram-dm-sending BL7) — also the trial port the app's pick takes
   * (`ChannelConnectionTrialPort`, routes-final § 8.10).
   */
  subscriptionTrialService: SubscriptionTrialService;
  stripeWebhookService: StripeWebhookService;
  /** Per-organization plan overrides and the entitlements read (plan-gating close, P270, P271). */
  entitlementService: EntitlementService;
};

/**
 * Wires plan / subscription / stripe-webhook repositories and services together,
 * injecting the tenancy {@link OrganizationService} required for cross-domain
 * organization lookups during checkout and webhook processing.
 *
 * @remarks
 * REQ-4: `membershipSeatUsage` (tenancy's membership service) is passed in so the subscription
 * service can compute `seats_used`. It is optional because the dedicated stripe-webhook worker
 * container builds its own `SubscriptionService` without it (the webhook path never returns the
 * public seat-counted shape). The HTTP / worker composition roots always supply it. The accounts
 * port (routes-final § 8.10) is the app's, built after billing, so the composition roots pass it to
 * `subscriptionService.wireChannelAccounts` once the app container exists; the trial service goes the
 * other way, into the app container as its pick's trial port.
 */
export function createBillingContainer({
  organizationService,
  membershipSeatUsage,
}: {
  organizationService: OrganizationService;
  membershipSeatUsage?: MembershipSeatUsagePort | undefined;
}): BillingContainer {
  const planRepository = new PlanRepository();
  const subscriptionRepository = new SubscriptionRepository();

  const planService = new PlanService(planRepository);
  const paymentProvider = new StripePaymentProvider(organizationService);
  const subscriptionTrialService = new SubscriptionTrialService(
    new TrialAccountRepository(),
    subscriptionRepository,
  );
  const subscriptionService = new SubscriptionService(
    organizationService,
    planService,
    subscriptionRepository,
    paymentProvider,
    membershipSeatUsage,
    subscriptionTrialService,
  );
  const stripeWebhookEventRepository = new StripeWebhookEventRepository();
  const stripeWebhookService = new StripeWebhookService(
    subscriptionService,
    stripeWebhookEventRepository,
    planRepository,
  );

  const entitlementService = new EntitlementService({
    organizationService,
    overrideRepository: new EntitlementOverrideRepository(),
    planAccessService: subscriptionService,
    membershipSeatUsage,
  });

  return {
    planService,
    subscriptionService,
    subscriptionTrialService,
    stripeWebhookService,
    entitlementService,
  };
}

/**
 * Decorates the Fastify instance with `billingDomain` so route plugins can
 * resolve billing services without rebuilding the container per request.
 */
export function registerBillingContainer(application: FastifyInstance): void {
  application.decorate(
    'billingDomain',
    createBillingContainer({
      organizationService: application.tenancyDomain.organizationService,
      membershipSeatUsage: application.tenancyDomain.membershipService,
    }),
  );
}
