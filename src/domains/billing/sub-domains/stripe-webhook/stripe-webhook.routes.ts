import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { WEBHOOK_INGRESS_BODY_LIMIT_BYTES } from '@/shared/constants/limits.constants.js';
import { WEBHOOK_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { createStripeWebhookController } from './stripe-webhook.controller.js';
import type { StripeWebhookService } from './stripe-webhook.service.js';
import { stripeWebhookIngressPlugin } from './stripe-webhook-ingress.plugin.js';

/** The header Stripe signs each delivery in — the raw body is kept only when it is present. */
const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

/**
 * Registers the Stripe webhook receiver at the canonical path:
 *
 *   POST /api/v1/billing/webhook  — Stripe Dashboard endpoints and the Stripe CLI
 *                                   (`stripe listen --forward-to`) must be configured
 *                                   against this URL. The raw JSON body is required for
 *                                   `Stripe-Signature` verification.
 */
export function stripeWebhookRoutes(
  stripeWebhookService: StripeWebhookService,
): FastifyPluginAsync {
  const controller = createStripeWebhookController(stripeWebhookService);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();

    await stripeWebhookIngressPlugin(app, {});
    zodApplication.post(
      '/webhook',
      {
        ...WEBHOOK_RATE_LIMIT,
        // sec-B finding #7 / WH2: the raw body is kept (for the `Stripe-Signature` HMAC) through
        // the shared raw-body registry, which the app-level `onRoute` hook fills from this config.
        config: {
          ...WEBHOOK_RATE_LIMIT.config,
          captureRawBody: true,
          rawBodySignatureHeader: STRIPE_SIGNATURE_HEADER,
          planGate: {
            open: "Stripe's signed webhook — it moves the plan state, it is not gated by it",
          },
        },
        // sec-C/M #29: the shared 5 MB webhook body limit — a 413 here turns into "Stripe retries
        // for 3 days then parks the event", which silently desyncs entitlement / dunning state.
        bodyLimit: WEBHOOK_INGRESS_BODY_LIMIT_BYTES,
        schema: {
          summary: 'Stripe webhook receiver',
          description:
            'Public endpoint for Stripe billing events. Verifies the `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET` and enqueues durable processing. Raw JSON body is required for signature verification.',
          tags: ['Stripe Webhook'],
        },
      },
      controller.handleWebhook,
    );
  };
}
