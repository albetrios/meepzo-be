import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { expect } from 'vitest';
import { env } from '@/shared/config/env.config.js';
import { processStripeWebhookJob } from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook.processor.js';
import { buildStripeWebhookTestSignatureHeader } from '@/tests/contract/helpers/stripe-signature.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { injectRoute } from '@/tests/helpers/test-http-inject.helper.js';

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/** The last `created` handed out: each event is at least a second newer than the one before. */
let lastCreatedSeconds = 0;

/**
 * Delivers one Stripe `customer.subscription.*` event the way production does, for the flow tests
 * (feat-instagram-dm-sending R58, R59): posted signed to route 107 (`POST /billing/webhook` — the
 * ledger row and the job), then worked by the webhook job, which re-fetches the event from Stripe
 * (answered here through nock).
 *
 * @remarks
 * - **Algorithm:** the event names the subscription, its customer, its status, one item with the
 *   price and the period, and the organization in `metadata`; `created` is a second ahead of now and
 *   of the previous event delivered, so it is newer than the row's last write and last event (no
 *   same-second ordering read reaches Stripe).
 * - **Failure modes:** the route answering anything but `200` fails the calling test; the job's
 *   errors propagate.
 * - **Side effects:** the route's ledger row and queued job; the job's subscription writes and
 *   events; one nock interceptor.
 */
export async function deliverStripeSubscriptionEvent({
  app,
  organizationPublicId,
  providerSubscriptionId,
  providerCustomerId,
  type,
  status,
  priceId,
  periodStart,
  periodEnd,
  trialEnd = null,
}: {
  app: FastifyInstance;
  organizationPublicId: string;
  providerSubscriptionId: string;
  providerCustomerId: string;
  type: 'customer.subscription.updated' | 'customer.subscription.deleted';
  status: 'active' | 'trialing' | 'past_due' | 'canceled';
  priceId: string;
  periodStart: Date;
  periodEnd: Date;
  trialEnd?: Date | null;
}): Promise<void> {
  const now = new Date();
  lastCreatedSeconds = Math.max(seconds(now) + 1, lastCreatedSeconds + 1);
  const event = {
    id: `evt_flow_${randomUUID().replaceAll('-', '')}`,
    object: 'event',
    type,
    created: lastCreatedSeconds,
    data: {
      object: {
        id: providerSubscriptionId,
        object: 'subscription',
        customer: providerCustomerId,
        status,
        cancel_at_period_end: false,
        canceled_at: status === 'canceled' ? seconds(now) : null,
        trial_end: trialEnd === null ? null : seconds(trialEnd),
        metadata: { organization_id: organizationPublicId },
        items: {
          data: [
            {
              quantity: 1,
              current_period_start: seconds(periodStart),
              current_period_end: seconds(periodEnd),
              price: { id: priceId },
            },
          ],
        },
      },
    },
  };
  const rawPayload = JSON.stringify(event);
  const delivered = await injectRoute(app, {
    method: 'POST',
    url: testApiPath('/billing/webhook'),
    headers: {
      'stripe-signature': buildStripeWebhookTestSignatureHeader({
        rawPayload,
        webhookSigningSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
      }),
      'content-type': 'application/json',
    },
    payload: Buffer.from(rawPayload),
  });
  expect(delivered.statusCode, delivered.body).toBe(200);
  nock('https://api.stripe.com').get(`/v1/events/${event.id}`).reply(200, event);
  await processStripeWebhookJob({
    jobData: { stripeEventId: event.id, requestId: 'flow-test' },
    stripeWebhookService: app.billingDomain.stripeWebhookService,
  });
}
