import Stripe from 'stripe';
import { globalAgent as httpsGlobalAgent } from 'node:https';
import { env } from '@/shared/config/env.config.js';
import { PAGINATION } from '@/shared/constants/pagination.constants.js';
import { buildOutboundCallOptions, outboundCall } from '@/infrastructure/outbound/index.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import { isStripeResourceMissing } from '@/infrastructure/payment/stripe-error.util.js';

/** Pinned Stripe API version — bump deliberately and verify against Stripe's changelog. */
const STRIPE_API_VERSION = '2026-09-30.endive';
/** SDK-level network retries for Stripe calls (mutations additionally pass an idempotency key). */
const STRIPE_MAX_NETWORK_RETRIES = 2;

let stripeInstance: Stripe | null = null;

/**
 * Nock intercepts `fetch` (undici) faithfully. Through Stripe's default `NodeHttpClient`, nock 15
 * hands an intercepted connection error back raw (`ERR_NOCK_NO_MATCH`) instead of as a
 * `StripeConnectionError`, and nock 14 could hang it (stripe-node#2211, nock#2785). The contract-test
 * harness is the only caller that sets `CONTRACT_TESTS_ENABLED=true`; use the fetch-based client only
 * there so production keeps the Node HTTP stack.
 */
function shouldUseStripeFetchHttpClientForContractOutboundTests(): boolean {
  return process.env.CONTRACT_TESTS_ENABLED === 'true';
}

/**
 * Get the singleton Stripe client instance.
 * Throws if STRIPE_SECRET_KEY is not configured.
 */
export function getStripeClient(): Stripe {
  if (stripeInstance) return stripeInstance;

  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }

  const optionalOutboundHttpClientForContractTests =
    shouldUseStripeFetchHttpClientForContractOutboundTests()
      ? {
          httpClient: Stripe.createFetchHttpClient((...arguments_: Parameters<typeof fetch>) =>
            fetch(...arguments_),
          ),
        }
      : {};

  stripeInstance = new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
    maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
    timeout: env.STRIPE_HTTP_TIMEOUT_MS,
    // The SDK's private agent ignores Node's managed proxy configuration. Reuse the platform
    // HTTPS agent so NODE_USE_ENV_PROXY also applies to Stripe's production HTTP transport.
    httpAgent: httpsGlobalAgent,
    ...optionalOutboundHttpClientForContractTests,
  });

  return stripeInstance;
}

/**
 * Check if Stripe is configured and ready.
 */
export function isStripeConfigured(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

/** True when HTTP Stripe webhook ingress can verify signatures. */
export function isStripeWebhookIngressConfigured(): boolean {
  return Boolean(env.STRIPE_WEBHOOK_SECRET);
}

// ── Customer helpers ──────────────────────────────────────────

/**
 * Creates a Stripe customer via `customers.create`. Wrapped in {@link outboundCall} for
 * the shared circuit breaker, timeout, and error classification; `Stripe.errors.StripeError`
 * is rethrown unwrapped so domain code can branch on Stripe-specific codes.
 */
export async function createStripeCustomer(options: {
  email: string;
  name: string;
  metadata?: Record<string, string>;
  requestId?: string;
  idempotencyKey?: string;
}): Promise<Stripe.Customer> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId: options.requestId,
      enforceAbortTimeout: false,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        // A deterministic idempotency key prevents a retried subscription-create (which mints the
        // customer when the organization has none) from creating a SECOND Stripe customer if a prior
        // attempt created the customer in Stripe but died before the local organization row committed.
        return stripe.customers.create(
          omitUndefined({
            email: options.email,
            name: options.name,
            metadata: options.metadata,
          }),
          options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
        );
      },
    }),
  );
}

/**
 * Retrieves a Stripe customer by id. Returns `null` for both deleted customers and
 * `resource_missing` lookups so callers do not need to special-case 404s; other Stripe
 * errors propagate unwrapped.
 */
export async function getStripeCustomer({
  customerId,
  requestId,
}: {
  customerId: string;
  requestId?: string | undefined;
}): Promise<Stripe.Customer | null> {
  const stripe = getStripeClient();
  try {
    return await outboundCall(
      buildOutboundCallOptions({
        name: 'stripe',
        requestId,
        enforceAbortTimeout: false,
        rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
        operation: async () => {
          const customer = await stripe.customers.retrieve(customerId);
          if (customer.deleted) return null;
          return customer as Stripe.Customer;
        },
      }),
    );
  } catch (error) {
    if (
      error instanceof Stripe.errors.StripeInvalidRequestError &&
      error.code === 'resource_missing'
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Fetches a fully-formed Stripe event by id — used by the webhook reclaim worker to
 * re-process events whose payloads are missing from the local ledger.
 */
export async function retrieveStripeEvent({
  stripeEventId,
  requestId,
}: {
  stripeEventId: string;
  requestId?: string | undefined;
}): Promise<Stripe.Event> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId,
      // sec-Q5 + sec-re-15: the BullMQ webhook worker calls this per attempt.
      // Under Stripe latency or a regional outage, every retry of every queued
      // event piled a new outbound call onto an already-stressed Stripe API.
      // Stripe's RequestOptions are the only place we can actually bind the
      // retrieve to a single attempt and a per-request timeout — the SDK does
      // not thread our AbortSignal into the underlying HTTP call, so the prior
      // `enforceAbortTimeout: true` combined with the client-level
      // `maxNetworkRetries: 2` meant ONE worker attempt could still take up to
      // 3 × STRIPE_HTTP_TIMEOUT_MS, in direct contradiction of the comment.
      // Overriding both at the call site caps the bad-day contribution at the
      // configured outbound-call window for real.
      enforceAbortTimeout: true,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        return stripe.events.retrieve(stripeEventId, undefined, {
          timeout: env.STRIPE_HTTP_TIMEOUT_MS,
          maxNetworkRetries: 0,
        });
      },
    }),
  );
}

/**
 * Lists the most recent Stripe events created at or after `createdGteSeconds` (a single bounded
 * page, newest first). Used by the catch-up worker to recover events that never reached the local
 * ledger — e.g. webhooks dropped while the API was down longer than the signature tolerance window.
 *
 * @remarks
 * - **Algorithm:** one `events.list({ created: { gte }, limit })` page (`limit` ≤ 100). The sweep is
 *   idempotent: any event still missing after a page boundary is recovered on the next run.
 * - **Failure modes:** Stripe errors are rethrown through {@link outboundCall} so the BullMQ job
 *   retries/backs off; the per-attempt timeout + `maxNetworkRetries: 0` bound the bad-day cost.
 * - **Side effects:** one outbound Stripe API call per invocation.
 */
export async function listRecentStripeEvents(options: {
  createdGteSeconds: number;
  limit: number;
  requestId?: string;
}): Promise<Stripe.Event[]> {
  const { createdGteSeconds, limit, requestId } = options;
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId,
      enforceAbortTimeout: true,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        const page = await stripe.events.list(
          { created: { gte: createdGteSeconds }, limit },
          { timeout: env.STRIPE_HTTP_TIMEOUT_MS, maxNetworkRetries: 0 },
        );
        return page.data;
      },
    }),
  );
}

// ── Subscription helpers ──────────────────────────────────────

/** Retrieve current authoritative subscription state when second-resolution events cannot be ordered. */
export async function retrieveStripeSubscriptionSnapshot(
  subscriptionId: string,
): Promise<Stripe.Subscription> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      enforceAbortTimeout: true,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () =>
        getStripeClient().subscriptions.retrieve(subscriptionId, undefined, {
          timeout: env.STRIPE_HTTP_TIMEOUT_MS,
          maxNetworkRetries: 0,
        }),
    }),
  );
}

/**
 * Creates a Stripe subscription in `default_incomplete` payment behaviour so the
 * platform can confirm the first PaymentIntent client-side before activation. Passes a
 * Stripe-native idempotency key when provided to make retries safe across HTTP attempts.
 */
export async function createStripeSubscription(options: {
  customerId: string;
  priceId: string;
  /** Seats billed from the first invoice; Stripe's default (1) when omitted. */
  quantity?: number;
  trialEnd?: number;
  /**
   * The no-card trial of a paid plan (feat-instagram-dm-sending BL7): Stripe's `trial_period_days`,
   * no payment method asked, the subscription cancelled at the trial's end when none was added, and a
   * card added meanwhile saved as the subscription's default.
   */
  trialPeriodDays?: number;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
  requestId?: string;
}): Promise<Stripe.Subscription> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId: options.requestId,
      enforceAbortTimeout: false,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        return stripe.subscriptions.create(
          omitUndefined({
            customer: options.customerId,
            items: [omitUndefined({ price: options.priceId, quantity: options.quantity })],
            trial_end: options.trialEnd,
            ...(options.trialPeriodDays === undefined
              ? {}
              : {
                  trial_period_days: options.trialPeriodDays,
                  trial_settings: { end_behavior: { missing_payment_method: 'cancel' as const } },
                  payment_settings: { save_default_payment_method: 'on_subscription' as const },
                }),
            metadata: options.metadata,
            payment_behavior: 'default_incomplete' as const,
          }),
          options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
        );
      },
    }),
  );
}

/**
 * Cancels a Stripe subscription. By default schedules cancellation at the end of the
 * current billing period (`cancel_at_period_end: true`); pass `false` to cancel
 * immediately and stop further proration.
 */
export async function cancelStripeSubscription({
  subscriptionId,
  cancelAtPeriodEnd = true,
  options,
}: {
  subscriptionId: string;
  cancelAtPeriodEnd?: boolean | undefined;
  options?: { requestId?: string; idempotencyKey?: string } | undefined;
}): Promise<Stripe.Subscription> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId: options?.requestId,
      enforceAbortTimeout: false,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        if (cancelAtPeriodEnd) {
          return stripe.subscriptions.update(
            subscriptionId,
            {
              cancel_at_period_end: true,
            },
            options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
          );
        }
        return stripe.subscriptions.cancel(
          subscriptionId,
          {},
          options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
        );
      },
    }),
  );
}

/**
 * Reverses a pending period-end cancellation by clearing `cancel_at_period_end`. No-op
 * on Stripe's side if the subscription was never scheduled to cancel.
 */
export async function resumeStripeSubscription({
  subscriptionId,
  options,
}: {
  subscriptionId: string;
  options?: { requestId?: string; idempotencyKey?: string } | undefined;
}): Promise<Stripe.Subscription> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId: options?.requestId,
      enforceAbortTimeout: false,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        return stripe.subscriptions.update(
          subscriptionId,
          {
            cancel_at_period_end: false,
          },
          options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
        );
      },
    }),
  );
}

/**
 * Updates a Stripe subscription's price and/or metadata. When `priceId` is set the
 * current subscription item is retrieved first so the swap targets the existing line
 * item (avoids creating a second item alongside the original).
 */
export async function updateStripeSubscription({
  subscriptionId,
  options,
}: {
  subscriptionId: string;
  options: {
    priceId?: string;
    metadata?: Record<string, string>;
    requestId?: string;
    idempotencyKey?: string;
  };
}): Promise<Stripe.Subscription> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId: options.requestId,
      enforceAbortTimeout: false,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        const params: Stripe.SubscriptionUpdateParams = {};

        if (options.priceId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const itemId = subscription.items.data[0]?.id;
          if (itemId) {
            params.items = [{ id: itemId, price: options.priceId }];
          }
        }

        if (options.metadata) {
          params.metadata = options.metadata;
        }

        return stripe.subscriptions.update(
          subscriptionId,
          params,
          options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
        );
      },
    }),
  );
}

/**
 * The Stripe request options of one call in a multi-call operation: the client's
 * `X-Idempotency-Key` plus the call's own suffix, so each Stripe call keeps its own idempotency key;
 * none when the client sent no key.
 */
function suffixedIdempotencyKey({
  idempotencyKey,
  suffix,
}: {
  idempotencyKey: string | undefined;
  suffix: string;
}): { idempotencyKey: string } | undefined {
  return idempotencyKey ? { idempotencyKey: `${idempotencyKey}:${suffix}` } : undefined;
}

/** The id of a subscription's schedule, or `null` (the field is an id or, expanded, the object). */
function readSubscriptionScheduleId(subscription: Stripe.Subscription): string | null {
  const { schedule } = subscription;
  if (!schedule) return null;
  return typeof schedule === 'string' ? schedule : schedule.id;
}

/** A schedule phase item's price id (an id or, expanded, the object). */
function readPhaseItemPriceId(item: Stripe.SubscriptionSchedule.Phase.Item): string {
  return typeof item.price === 'string' ? item.price : item.price.id;
}

/**
 * Schedules a subscription's price change for the end of its current period — the move down of
 * feat-instagram-dm-sending BL5 (P77): a Stripe subscription schedule whose first phase is the current
 * price until the period end and whose second phase is the new price; the schedule releases the
 * subscription after it, so Stripe invoices the renewal at the new price itself.
 *
 * @remarks
 * - **Algorithm:** retrieves the subscription; reuses its schedule (a second move down replaces the
 *   target) or creates one `from_subscription`; then rewrites the phases: the current phase kept as it
 *   is (its price, quantity, dates and trial end — a plan change during a trial keeps its end), then
 *   the new price with no proration.
 * - **Failure modes:** a Stripe error is rethrown for the caller's mapping; a schedule Stripe returns
 *   with no current phase is an `Error`.
 * - **Side effects:** creates or updates one Stripe subscription schedule. Each write carries its own
 *   suffix of `idempotencyKey`, so a retried request repeats neither.
 */
export async function scheduleStripeSubscriptionPriceChange(options: {
  subscriptionId: string;
  priceId: string;
  idempotencyKey?: string;
  requestId?: string;
}): Promise<Stripe.SubscriptionSchedule> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId: options.requestId,
      enforceAbortTimeout: false,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        const keyed = (suffix: string) =>
          suffixedIdempotencyKey({ idempotencyKey: options.idempotencyKey, suffix });
        const subscription = await stripe.subscriptions.retrieve(options.subscriptionId);
        const existingScheduleId = readSubscriptionScheduleId(subscription);
        const schedule = existingScheduleId
          ? await stripe.subscriptionSchedules.retrieve(existingScheduleId)
          : await stripe.subscriptionSchedules.create(
              { from_subscription: options.subscriptionId },
              keyed('schedule-create'),
            );
        const currentPhase = schedule.phases[0];
        if (!currentPhase) {
          throw new Error(`stripe.subscription_schedule.${schedule.id}: no current phase`);
        }
        const quantity = subscription.items.data[0]?.quantity ?? 1;
        return stripe.subscriptionSchedules.update(
          schedule.id,
          {
            end_behavior: 'release',
            phases: [
              omitUndefined({
                items: currentPhase.items.map((item) => ({
                  price: readPhaseItemPriceId(item),
                  quantity: item.quantity ?? quantity,
                })),
                start_date: currentPhase.start_date,
                end_date: currentPhase.end_date,
                trial_end: currentPhase.trial_end ?? undefined,
              }),
              {
                items: [{ price: options.priceId, quantity }],
                proration_behavior: 'none' as const,
              },
            ],
          },
          keyed('schedule-update'),
        );
      },
    }),
  );
}

/**
 * Releases a subscription's schedule, if it has one — a scheduled move down taken back or replaced by
 * a move up (feat-instagram-dm-sending BL5, BL15). The subscription keeps its current price and period.
 * Answers whether a schedule was released.
 */
export async function releaseStripeSubscriptionSchedule(options: {
  subscriptionId: string;
  idempotencyKey?: string;
  requestId?: string;
}): Promise<boolean> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId: options.requestId,
      enforceAbortTimeout: false,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        const subscription = await stripe.subscriptions.retrieve(options.subscriptionId);
        const scheduleId = readSubscriptionScheduleId(subscription);
        if (!scheduleId) return false;
        await stripe.subscriptionSchedules.release(
          scheduleId,
          {},
          suffixedIdempotencyKey({
            idempotencyKey: options.idempotencyKey,
            suffix: 'schedule-release',
          }),
        );
        return true;
      },
    }),
  );
}

/**
 * Updates the seat quantity on a Stripe subscription's primary line item (REQ-4). Retrieves the
 * subscription first so the quantity is applied to the existing item (no second line item), then
 * patches `items: [{ id, quantity }]`. Forwards a Stripe-native idempotency key when provided so
 * a retried sync is safe.
 *
 * @remarks
 * - **Algorithm:** `subscriptions.retrieve` → take `items.data[0].id` → `subscriptions.update`
 *   with `[{ id, quantity }]` + `proration_behavior: 'create_prorations'` so a mid-cycle seat
 *   change prorates. No-op (returns the retrieved subscription) when the subscription has no item.
 * - **Failure modes:** Stripe errors propagate unwrapped through {@link outboundCall} (the caller —
 *   a BullMQ worker — relies on retry/backoff).
 * - **Side effects:** two outbound Stripe API calls (retrieve + update).
 */
export async function updateStripeSubscriptionQuantity({
  subscriptionId,
  quantity,
  options,
}: {
  subscriptionId: string;
  quantity: number;
  options?: { requestId?: string; idempotencyKey?: string } | undefined;
}): Promise<Stripe.Subscription> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId: options?.requestId,
      enforceAbortTimeout: false,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const itemId = subscription.items.data[0]?.id;
        if (!itemId) {
          return subscription;
        }
        return stripe.subscriptions.update(
          subscriptionId,
          {
            items: [{ id: itemId, quantity }],
            proration_behavior: 'create_prorations',
          },
          options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
        );
      },
    }),
  );
}

// ── Invoices & payment methods (Stripe proxy) ─────────────────

/**
 * Lists Stripe invoices for a billing customer (newest first), one cursor page.
 *
 * @remarks
 * - **Algorithm:** a single `invoices.list` page using Stripe's own cursor pagination — `limit`
 *   (1–100) plus `starting_after` (a Stripe invoice id `in_*`). Returns the page rows and Stripe's
 *   `has_more` flag so the caller can mint a `next` cursor without a count.
 * - **Notes:** the caller derives the next cursor from the last row's `id`; Stripe orders newest
 *   first, so paging walks backwards in time.
 */
export async function listStripeInvoices({
  customerId,
  options,
}: {
  customerId: string;
  options?: { limit?: number; startingAfter?: string; requestId?: string } | undefined;
}): Promise<{ data: Stripe.Invoice[]; has_more: boolean }> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId: options?.requestId,
      enforceAbortTimeout: false,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        const page = await stripe.invoices.list(
          {
            customer: customerId,
            limit: options?.limit ?? PAGINATION.DEFAULT_LIMIT,
            ...(options?.startingAfter ? { starting_after: options.startingAfter } : {}),
          },
          { timeout: env.STRIPE_HTTP_TIMEOUT_MS, maxNetworkRetries: 0 },
        );
        return { data: page.data, has_more: page.has_more };
      },
    }),
  );
}

/**
 * Lists card payment methods saved on a Stripe customer.
 */
export async function listStripePaymentMethods({
  customerId,
  options,
}: {
  customerId: string;
  options?: { requestId?: string } | undefined;
}): Promise<Stripe.PaymentMethod[]> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId: options?.requestId,
      enforceAbortTimeout: false,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        const page = await stripe.paymentMethods.list(
          {
            customer: customerId,
            type: 'card',
          },
          { timeout: env.STRIPE_HTTP_TIMEOUT_MS, maxNetworkRetries: 0 },
        );
        return page.data;
      },
    }),
  );
}

/**
 * Retrieves the customer's default payment method id when set on invoice settings.
 */
export async function retrieveStripeCustomerDefaultPaymentMethodId({
  customerId,
  requestId,
}: {
  customerId: string;
  requestId?: string | undefined;
}): Promise<string | null> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId,
      enforceAbortTimeout: false,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        const customer = await stripe.customers.retrieve(customerId);
        if (customer.deleted) return null;
        const defaultPm = customer.invoice_settings?.default_payment_method;
        if (!defaultPm) return null;
        return typeof defaultPm === 'string' ? defaultPm : defaultPm.id;
      },
    }),
  );
}

/**
 * Retrieves one payment method by its Stripe id (`pm_…`) — the card routes' ownership check
 * (feat-instagram-dm-sending BL20, BL21). Answers `null` when Stripe has no such payment method.
 *
 * @remarks
 * - **Failure modes:** Stripe's `resource_missing` answers `null` (the caller's `404`); every other
 *   Stripe error propagates unwrapped through {@link outboundCall}.
 */
export async function retrieveStripePaymentMethod({
  paymentMethodId,
  requestId,
}: {
  paymentMethodId: string;
  requestId?: string | undefined;
}): Promise<Stripe.PaymentMethod | null> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId,
      enforceAbortTimeout: false,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        try {
          return await stripe.paymentMethods.retrieve(paymentMethodId);
        } catch (error) {
          if (isStripeResourceMissing(error)) return null;
          throw error;
        }
      },
    }),
  );
}

/**
 * Detaches a payment method from its customer — removing a card (feat-instagram-dm-sending BL20,
 * route 105). Stripe clears the customer's default when the card was it.
 */
export async function detachStripePaymentMethod({
  paymentMethodId,
  options,
}: {
  paymentMethodId: string;
  options?: { requestId?: string; idempotencyKey?: string } | undefined;
}): Promise<Stripe.PaymentMethod> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId: options?.requestId,
      enforceAbortTimeout: false,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        return stripe.paymentMethods.detach(
          paymentMethodId,
          {},
          options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
        );
      },
    }),
  );
}

/**
 * Makes a card the default — the customer's `invoice_settings.default_payment_method` and, when the
 * organization has a live Stripe subscription, its `default_payment_method` (feat-instagram-dm-sending
 * BL21, route 106).
 *
 * @remarks
 * - **Side effects:** one or two Stripe updates; each carries its own suffix of `idempotencyKey`, so
 *   a retried request repeats neither. Setting the card that is already the default is harmless.
 */
export async function setStripeCustomerDefaultPaymentMethod(options: {
  customerId: string;
  subscriptionId: string | null;
  paymentMethodId: string;
  idempotencyKey?: string | undefined;
  requestId?: string | undefined;
}): Promise<void> {
  await outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId: options.requestId,
      enforceAbortTimeout: false,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        const keyed = (suffix: string) =>
          suffixedIdempotencyKey({ idempotencyKey: options.idempotencyKey, suffix });
        await stripe.customers.update(
          options.customerId,
          { invoice_settings: { default_payment_method: options.paymentMethodId } },
          keyed('customer-default'),
        );
        if (options.subscriptionId) {
          await stripe.subscriptions.update(
            options.subscriptionId,
            { default_payment_method: options.paymentMethodId },
            keyed('subscription-default'),
          );
        }
      },
    }),
  );
}

/**
 * Creates a SetupIntent so the frontend can collect a card and attach it to the customer.
 */
export async function createStripeSetupIntent({
  customerId,
  options,
}: {
  customerId: string;
  options?: { requestId?: string; idempotencyKey?: string } | undefined;
}): Promise<string | null> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId: options?.requestId,
      enforceAbortTimeout: false,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        const intent = await stripe.setupIntents.create(
          {
            customer: customerId,
            // Stripe API 2026-09-30.endive removed `payment_method_types` from SetupIntent
            // create; `allowed_payment_method_types` restricts the intent to cards instead.
            allowed_payment_method_types: ['card'],
            usage: 'off_session',
          },
          options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
        );
        return intent.client_secret ?? null;
      },
    }),
  );
}

// ── Webhook verification ──────────────────────────────────────

/**
 * Retrieves the PaymentIntent `client_secret` for an incomplete Stripe subscription so
 * the frontend can confirm the first payment via Stripe.js (`default_incomplete` flow).
 */
export async function retrieveStripeSubscriptionPaymentClientSecret({
  subscriptionId,
  requestId,
}: {
  subscriptionId: string;
  requestId?: string | undefined;
}): Promise<string | null> {
  return outboundCall(
    buildOutboundCallOptions({
      name: 'stripe',
      requestId,
      enforceAbortTimeout: false,
      rethrowIf: (error) => error instanceof Stripe.errors.StripeError,
      operation: async () => {
        const stripe = getStripeClient();
        const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ['latest_invoice.confirmation_secret'],
        });
        const latestInvoice = subscription.latest_invoice;
        if (!latestInvoice || typeof latestInvoice === 'string') return null;
        // Stripe API 2026-05-27.dahlia removed `Invoice.payment_intent`; the
        // `default_incomplete` PaymentIntent's client_secret is now exposed via
        // the expandable `confirmation_secret` field.
        return latestInvoice.confirmation_secret?.client_secret ?? null;
      },
    }),
  );
}

/**
 * Verifies the `Stripe-Signature` header against the raw body and returns the parsed
 * `Stripe.Event`. Throws when the secret is missing or no configured secret matches.
 *
 * @remarks
 * **Tolerance:** 150 seconds (half of Stripe's 300 s default) to halve the replay window;
 * legitimate deliveries from Stripe arrive within seconds of signing.
 *
 * **Key rotation (sec-new-B3):** `STRIPE_WEBHOOK_SECRET` may be a comma-separated list of
 * `whsec_`-prefixed secrets (e.g. `whsec_old,whsec_new`). Each segment is trimmed; empty
 * segments from trailing commas are ignored. Secrets are tried in order and the first that
 * verifies is returned. This enables zero-downtime key rotation: add the new secret to the
 * list in the Stripe Dashboard, then remove the old one once it is no longer in use. If no
 * secret matches, the last `StripeSignatureVerificationError` is re-thrown so callers can
 * distinguish "bad signature" from "missing config".
 */
export function constructStripeWebhookEvent({
  body,
  signature,
}: {
  body: string | Buffer;
  signature: string;
}): Stripe.Event {
  const stripe = getStripeClient();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }
  // sec-new-B3: split on comma so operators can list old + new secret during a
  // rolling key rotation without dropping in-flight deliveries.
  const secrets = webhookSecret
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let lastError: unknown;
  for (const secret of secrets) {
    try {
      return stripe.webhooks.constructEvent(
        body,
        signature,
        secret,
        env.STRIPE_WEBHOOK_TOLERANCE_SECONDS,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
