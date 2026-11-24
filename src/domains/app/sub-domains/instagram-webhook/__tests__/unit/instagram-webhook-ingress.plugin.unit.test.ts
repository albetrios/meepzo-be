import { createHmac } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, ServiceUnavailableError, ValidationError } from '@/shared/errors/index.js';

const mockEnvironment = vi.hoisted(() => ({
  META_APP_SECRET: 'unit-test-instagram-app-secret' as string | undefined,
}));
const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock('@/shared/config/env.config.js', () => ({
  getEnv: () => mockEnvironment,
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: loggerWarn, error: vi.fn(), debug: vi.fn() },
}));

/**
 * `instagramWebhookIngressPlugin` (routes-final § 4.A, WH8): the app secret must be set (`503`),
 * then `X-Hub-Signature-256` must be the HMAC-SHA256 of the raw body (`400 invalid_webhook_signature`)
 * — a request without the header refused before its body is read, the body parsed only once the
 * signature passed (D53), a refusal logged without the header, body or secret.
 */

type PreHandler = (request: FastifyRequest) => Promise<void>;
type PreParsing = (request: FastifyRequest, reply: unknown, payload: unknown) => Promise<unknown>;

async function loadHooks(): Promise<{ preHandler: PreHandler; preParsing: PreParsing }> {
  const { instagramWebhookIngressPlugin } = await import(
    '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-ingress.plugin.js'
  );
  const hooks = new Map<string, unknown>();
  const application = {
    addHook: (name: string, hook: unknown): void => {
      expect(hooks.has(name)).toBe(false);
      hooks.set(name, hook);
    },
  };
  await instagramWebhookIngressPlugin(application as never, {} as never);
  expect([...hooks.keys()].sort()).toEqual(['preHandler', 'preParsing']);
  return {
    preHandler: hooks.get('preHandler') as PreHandler,
    preParsing: hooks.get('preParsing') as PreParsing,
  };
}

async function loadPreHandler(): Promise<PreHandler> {
  return (await loadHooks()).preHandler;
}

const RAW_BODY = Buffer.from('{"object":"instagram","entry":[]}');

function signatureOf(body: Buffer, secret = 'unit-test-instagram-app-secret'): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function requestWith({
  signature,
  withoutRawBody = false,
  rawBody = RAW_BODY,
}: {
  signature?: unknown;
  /** The parser kept no raw body (the request carried no signature header, or a wiring bug). */
  withoutRawBody?: boolean;
  rawBody?: Buffer;
}): FastifyRequest {
  return {
    id: 'req-instagram-ingress',
    headers: signature === undefined ? {} : { 'x-hub-signature-256': signature },
    rawBody: withoutRawBody ? undefined : rawBody,
    // As the content-type parser leaves it on a raw-body route: unparsed (WH2).
    body: undefined,
  } as unknown as FastifyRequest;
}

async function reasonOf(promise: Promise<void> | undefined): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AppError ? error.reason : undefined;
  }
  return undefined;
}

describe('instagramWebhookIngressPlugin', () => {
  beforeEach(() => {
    mockEnvironment.META_APP_SECRET = 'unit-test-instagram-app-secret';
    loggerWarn.mockReset();
  });

  it('passes a delivery whose X-Hub-Signature-256 is the raw body HMAC', async () => {
    const preHandler = await loadPreHandler();
    await expect(
      preHandler(requestWith({ signature: signatureOf(RAW_BODY) })),
    ).resolves.toBeUndefined();
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('accepts the hex digits in upper case', async () => {
    const preHandler = await loadPreHandler();
    const signature = `sha256=${signatureOf(RAW_BODY).slice('sha256='.length).toUpperCase()}`;
    await expect(preHandler(requestWith({ signature }))).resolves.toBeUndefined();
  });

  it('answers 503 instagram_webhook_not_configured without the app secret — before the header', async () => {
    mockEnvironment.META_APP_SECRET = undefined;
    const preHandler = await loadPreHandler();
    const attempt = preHandler(requestWith({ signature: signatureOf(RAW_BODY) }));

    await expect(attempt).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(await reasonOf(preHandler(requestWith({})))).toBe('instagram_webhook_not_configured');
  });

  it.each([
    ['missing', undefined],
    ['not a string', ['sha256=a', 'sha256=b']],
    ['without the sha256= prefix', signatureOf(RAW_BODY).slice('sha256='.length)],
    ['too short', 'sha256=abc'],
    ['not hex', `sha256=${'z'.repeat(64)}`],
    ['signed with another secret', signatureOf(RAW_BODY, 'another-secret')],
    ['for another body', signatureOf(Buffer.from('{"object":"instagram","entry":[{}]}'))],
  ])('answers 400 invalid_webhook_signature when the header is %s', async (_label, signature) => {
    const preHandler = await loadPreHandler();
    const attempt = preHandler(requestWith({ signature }));

    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    expect(await reasonOf(preHandler(requestWith({ signature })))).toBe(
      'invalid_webhook_signature',
    );
  });

  it('answers 400 invalid_webhook_signature when there is no raw body to check', async () => {
    const preHandler = await loadPreHandler();
    const request = requestWith({ signature: signatureOf(RAW_BODY), withoutRawBody: true });

    expect(await reasonOf(preHandler(request))).toBe('invalid_webhook_signature');
  });

  describe('parses the body only once the signature passed (D53)', () => {
    it('hands the handler the JSON of the verified raw bytes', async () => {
      const preHandler = await loadPreHandler();
      const request = requestWith({ signature: signatureOf(RAW_BODY) });

      await preHandler(request);

      expect(request.body).toEqual({ object: 'instagram', entry: [] });
    });

    it.each([
      ['not JSON', 'this is not json'],
      ['empty', ''],
    ])(
      'leaves a signed body that is %s undefined — the receiver answers it',
      async (_label, text) => {
        const preHandler = await loadPreHandler();
        const rawBody = Buffer.from(text);
        const request = requestWith({ signature: signatureOf(rawBody), rawBody });

        await expect(preHandler(request)).resolves.toBeUndefined();

        expect(request.body).toBeUndefined();
      },
    );

    it('parses nothing of a body whose signature is wrong', async () => {
      const preHandler = await loadPreHandler();
      const request = requestWith({ signature: signatureOf(RAW_BODY, 'another-secret') });
      const parse = vi.spyOn(JSON, 'parse');
      try {
        expect(await reasonOf(preHandler(request))).toBe('invalid_webhook_signature');
        expect(parse).not.toHaveBeenCalled();
        expect(request.body).toBeUndefined();
      } finally {
        parse.mockRestore();
      }
    });
  });

  describe('refuses a request without the header before its body is read (D53)', () => {
    const PAYLOAD = { stream: 'the unread request body' };

    it('lets a request with the header on, its body stream untouched', async () => {
      const { preParsing } = await loadHooks();
      const request = requestWith({ signature: signatureOf(RAW_BODY), withoutRawBody: true });

      await expect(preParsing(request, {}, PAYLOAD)).resolves.toBe(PAYLOAD);
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['not a string', ['sha256=a', 'sha256=b']],
    ])('answers 400 invalid_webhook_signature when the header is %s', async (_label, signature) => {
      const { preParsing } = await loadHooks();
      const attempt = preParsing(requestWith({ signature, withoutRawBody: true }), {}, PAYLOAD);

      await expect(attempt).rejects.toBeInstanceOf(ValidationError);
      await expect(attempt).rejects.toMatchObject({ reason: 'invalid_webhook_signature' });
      expect(loggerWarn).toHaveBeenCalledWith(
        { requestId: 'req-instagram-ingress', hasSignatureHeader: false, hasRawBody: false },
        'instagram.webhook.signature_rejected',
      );
    });

    it('answers 503 instagram_webhook_not_configured first when the app secret is unset', async () => {
      mockEnvironment.META_APP_SECRET = undefined;
      const { preParsing } = await loadHooks();
      const attempt = preParsing(requestWith({ withoutRawBody: true }), {}, PAYLOAD);

      await expect(attempt).rejects.toBeInstanceOf(ServiceUnavailableError);
      await expect(attempt).rejects.toMatchObject({ reason: 'instagram_webhook_not_configured' });
    });
  });

  it('logs a refusal with the request id and what failed — never the header, body or secret', async () => {
    const preHandler = await loadPreHandler();
    const signature = signatureOf(RAW_BODY, 'another-secret');
    await reasonOf(preHandler(requestWith({ signature })));

    expect(loggerWarn).toHaveBeenCalledTimes(1);
    const [fields, message] = loggerWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe('instagram.webhook.signature_rejected');
    expect(fields).toEqual({
      requestId: 'req-instagram-ingress',
      hasSignatureHeader: true,
      hasRawBody: true,
    });
    const logged = JSON.stringify(loggerWarn.mock.calls);
    expect(logged).not.toContain(signature);
    expect(logged).not.toContain('instagram","entry');
    expect(logged).not.toContain('unit-test-instagram-app-secret');
  });
});
