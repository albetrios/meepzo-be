import type { FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableError, ValidationError } from '@/shared/errors/index.js';

const constructStripeWebhookEventMock = vi.fn();
const isStripeWebhookIngressConfiguredMock = vi.fn();

vi.mock('@/infrastructure/payment/stripe.client.js', () => ({
  constructStripeWebhookEvent: (...arguments_: unknown[]) =>
    constructStripeWebhookEventMock(...arguments_),
  isStripeWebhookIngressConfigured: () => isStripeWebhookIngressConfiguredMock(),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type IngressHook = (
  request: FastifyRequest,
  reply?: unknown,
  payload?: unknown,
) => Promise<unknown>;

async function loadHooks(hookName: 'preHandler' | 'preParsing'): Promise<IngressHook[]> {
  const { stripeWebhookIngressPlugin } = await import(
    '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook-ingress.plugin.js'
  );

  const hooks: IngressHook[] = [];
  const application = {
    addHook: (name: string, hook: IngressHook): void => {
      if (name === hookName) {
        hooks.push(hook);
      }
    },
  };

  await stripeWebhookIngressPlugin(application as never, {} as never);
  return hooks;
}

function loadPreHandlerHooks(): Promise<IngressHook[]> {
  return loadHooks('preHandler');
}

describe('stripeWebhookIngressPlugin', () => {
  beforeEach(() => {
    constructStripeWebhookEventMock.mockReset();
    isStripeWebhookIngressConfiguredMock.mockReset();
    isStripeWebhookIngressConfiguredMock.mockReturnValue(true);
  });

  it('preHandler rejects when Stripe webhook ingress is not configured', async () => {
    isStripeWebhookIngressConfiguredMock.mockReturnValue(false);
    const preHandlerHooks = await loadPreHandlerHooks();

    const request = {
      headers: { 'stripe-signature': 'sig_test' },
      rawBody: Buffer.from('{}'),
    } as unknown as FastifyRequest;

    await expect(preHandlerHooks[0]?.(request)).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(constructStripeWebhookEventMock).not.toHaveBeenCalled();
  });

  it('preHandler rejects missing stripe-signature', async () => {
    const preHandlerHooks = await loadPreHandlerHooks();

    const request = {
      headers: {},
      rawBody: Buffer.from('{}'),
    } as unknown as FastifyRequest;

    await expect(preHandlerHooks[0]?.(request)).rejects.toBeInstanceOf(ValidationError);
    expect(constructStripeWebhookEventMock).not.toHaveBeenCalled();
  });

  it('preHandler rejects non-string stripe-signature header', async () => {
    const preHandlerHooks = await loadPreHandlerHooks();

    const request = {
      headers: { 'stripe-signature': ['sig_a', 'sig_b'] as never },
      rawBody: Buffer.from('{}'),
    } as unknown as FastifyRequest;

    await expect(preHandlerHooks[0]?.(request)).rejects.toBeInstanceOf(ValidationError);
    expect(constructStripeWebhookEventMock).not.toHaveBeenCalled();
  });

  it('preHandler rejects missing raw body', async () => {
    const preHandlerHooks = await loadPreHandlerHooks();

    const request = {
      headers: { 'stripe-signature': 'sig_test' },
      rawBody: undefined,
    } as unknown as FastifyRequest;

    await expect(preHandlerHooks[0]?.(request)).rejects.toBeInstanceOf(ValidationError);
    expect(constructStripeWebhookEventMock).not.toHaveBeenCalled();
  });

  it('preHandler rejects invalid signature', async () => {
    constructStripeWebhookEventMock.mockImplementation(() => {
      throw new Error('invalid signature');
    });
    const preHandlerHooks = await loadPreHandlerHooks();

    const request = {
      headers: { 'stripe-signature': 'sig_bad' },
      rawBody: Buffer.from('{"id":"evt_1"}'),
    } as unknown as FastifyRequest;

    await expect(preHandlerHooks[0]?.(request)).rejects.toBeInstanceOf(ValidationError);
    expect(request.stripeWebhookEvent).toBeUndefined();
  });

  it('preHandler logs non-Error verification failures', async () => {
    constructStripeWebhookEventMock.mockImplementation(() => {
      throw 'invalid signature string';
    });
    const preHandlerHooks = await loadPreHandlerHooks();

    const request = {
      headers: { 'stripe-signature': 'sig_bad' },
      rawBody: Buffer.from('{"id":"evt_1"}'),
    } as unknown as FastifyRequest;

    await expect(preHandlerHooks[0]?.(request)).rejects.toBeInstanceOf(ValidationError);
  });

  it('preHandler attaches verified event on success', async () => {
    const verifiedEvent = { id: 'evt_1', type: 'customer.created' };
    constructStripeWebhookEventMock.mockReturnValue(verifiedEvent);
    const preHandlerHooks = await loadPreHandlerHooks();

    const request = {
      headers: { 'stripe-signature': 'sig_test' },
      rawBody: Buffer.from('{"id":"evt_1"}'),
    } as unknown as FastifyRequest;

    await preHandlerHooks[0]?.(request);

    expect(constructStripeWebhookEventMock).toHaveBeenCalledWith({
      body: Buffer.from('{"id":"evt_1"}'),
      signature: 'sig_test',
    });
    expect(request.stripeWebhookEvent).toEqual(verifiedEvent);
    // The body is the event parsed from the verified bytes — the parser left it unparsed (D53).
    expect(request.body).toEqual(verifiedEvent);
  });

  describe('a request without the signature header is refused before its body is read (D53)', () => {
    const PAYLOAD = { stream: 'the unread request body' };

    it('preParsing lets a request with the header on, its body stream untouched', async () => {
      const [preParsing] = await loadHooks('preParsing');
      const request = {
        headers: { 'stripe-signature': 'sig_test' },
      } as unknown as FastifyRequest;

      await expect(preParsing?.(request, {}, PAYLOAD)).resolves.toBe(PAYLOAD);
      expect(constructStripeWebhookEventMock).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', {}],
      ['empty', { 'stripe-signature': '' }],
      ['not a string', { 'stripe-signature': ['sig_a', 'sig_b'] }],
    ])(
      'preParsing answers the missing-signature 400 when the header is %s',
      async (_case, headers) => {
        const [preParsing] = await loadHooks('preParsing');
        const attempt = preParsing?.({ headers } as unknown as FastifyRequest, {}, PAYLOAD);

        await expect(attempt).rejects.toBeInstanceOf(ValidationError);
        await expect(attempt).rejects.toMatchObject({ message: 'errors:missingStripeSignature' });
        expect(constructStripeWebhookEventMock).not.toHaveBeenCalled();
      },
    );

    it('preParsing answers 503 first when Stripe webhook ingress is not configured', async () => {
      isStripeWebhookIngressConfiguredMock.mockReturnValue(false);
      const [preParsing] = await loadHooks('preParsing');
      const request = { headers: {} } as unknown as FastifyRequest;

      await expect(preParsing?.(request, {}, PAYLOAD)).rejects.toBeInstanceOf(
        ServiceUnavailableError,
      );
    });
  });
});
