import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaSignedRequestPayload } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-signature.js';
import { META_CALLBACK_BODY_LIMIT_BYTES } from '@/shared/constants/limits.constants.js';
import { ServiceUnavailableError } from '@/shared/errors/index.js';

const appSettings = vi.hoisted(() => ({
  appSecret: 'meta-callback-unit-test-app-secret' as string | null,
}));

vi.mock(
  '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js',
  () => ({
    readMetaAppSecret: () => {
      if (appSettings.appSecret === null) {
        throw new ServiceUnavailableError('errors:instagramNotConfigured').withReason(
          'instagram_not_configured',
        );
      }
      return appSettings.appSecret;
    },
  }),
);

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  instagramAccountMetaCallbackIngressPlugin,
  parseMetaCallbackFormBody,
} from '@/domains/app/sub-domains/instagram-account/instagram-account-meta-callback/instagram-account-meta-callback-ingress.plugin.js';
import { MetaSignedRequestDto } from '@/domains/app/sub-domains/instagram-account/instagram-account-meta-callback/instagram-account-meta-callback.dto.js';
import {
  FORM_CONTENT_TYPE,
  buildMetaSignedRequest,
  metaCallbackFormBody,
  metaSignedRequestPayload,
} from '@/domains/app/sub-domains/instagram-account/instagram-account-meta-callback/__tests__/factories/instagram-account-meta-callback.factory.js';

const APP_SECRET = 'meta-callback-unit-test-app-secret';
const USER_ID = '17841400000000001';

describe('parseMetaCallbackFormBody — the routes’ form parser', () => {
  it('reads the signed_request field, decoding `+` and percent escapes as a browser form does', () => {
    expect(parseMetaCallbackFormBody('signed_request=a.b')).toEqual({ signed_request: 'a.b' });
    expect(parseMetaCallbackFormBody('signed_request=hello+there%21')).toEqual({
      signed_request: 'hello there!',
    });
    expect(parseMetaCallbackFormBody('note=1&signed_request=a.b&other=2')).toEqual({
      signed_request: 'a.b',
    });
  });

  it.each([
    ['side by side', 'signed_request=a&signed_request=b'],
    ['apart', 'signed_request=a&note=1&signed_request=b'],
    ['one of them without a value', 'signed_request&signed_request=b'],
    ['one of them empty', 'signed_request=&signed_request=b'],
    ['many times', 'signed_request=a&'.repeat(900)],
  ])('reads no signed request when the field is sent more than once (%s)', (_case, body) => {
    // Never one silently picked: without the field the signed request is refused.
    expect(parseMetaCallbackFormBody(body)).toEqual({});
  });

  it.each([
    ['an empty body', ''],
    ['another field only', 'something=else'],
    ['a field whose name only contains it', 'old_signed_request=a&signed_request_id=b'],
    ['its name inside another field’s value', 'note=signed_request=a'],
  ])('reads no signed request from %s', (_case, body) => {
    expect(parseMetaCallbackFormBody(body)).toEqual({});
  });

  it('keeps a malformed percent escape as it came, as a browser form does', () => {
    expect(parseMetaCallbackFormBody('signed_request=%zz')).toEqual({ signed_request: '%zz' });
  });

  it('reads no other field — a field named __proto__ never reaches an object', () => {
    const fields = parseMetaCallbackFormBody('__proto__=polluted&signed_request=a.b');
    expect(Object.keys(fields)).toEqual(['signed_request']);
    expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('decodes one field however many the body repeats — the work does not grow with the fields', () => {
    const decodedPairs = vi.spyOn(globalThis, 'URLSearchParams');
    try {
      for (const fieldCount of [0, 10, 1_000, 8_000]) {
        decodedPairs.mockClear();
        const body = `${'a&'.repeat(fieldCount)}signed_request=a.b`;

        expect(parseMetaCallbackFormBody(body)).toEqual({ signed_request: 'a.b' });

        // The only pair ever decoded is the signed request's own, at any field count.
        expect(decodedPairs.mock.calls).toEqual([['signed_request=a.b']]);
      }
    } finally {
      decodedPairs.mockRestore();
    }
  });

  it('reads 128 KB of one repeated field at once — it blocked the process for 38 seconds', () => {
    const body = 'a&'.repeat(64 * 1024);
    const startedAt = performance.now();

    expect(parseMetaCallbackFormBody(body)).toEqual({});

    // A generous bound: the read is one pass over the text (well under a millisecond).
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});

/**
 * The ingress inside an encapsulated child, as the routes register it (with the zod validator and
 * a body schema, to prove the check runs before validation), beside a parent route that keeps the
 * default JSON parser. The error handler reports the status and the reason only.
 */
async function buildIngressApplication(): Promise<{
  application: FastifyInstance;
  seen: MetaSignedRequestPayload[];
}> {
  const application = Fastify({ logger: false });
  application.setValidatorCompiler(validatorCompiler);
  application.setSerializerCompiler(serializerCompiler);
  application.setErrorHandler((error, _request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    void reply.status(statusCode).send({ reason: (error as { reason?: string }).reason ?? null });
  });
  const seen: MetaSignedRequestPayload[] = [];
  await application.register(async (child) => {
    await instagramAccountMetaCallbackIngressPlugin(child, {});
    child.withTypeProvider<ZodTypeProvider>().post(
      '/callback',
      {
        bodyLimit: META_CALLBACK_BODY_LIMIT_BYTES,
        schema: { body: MetaSignedRequestDto },
      },
      async (request) => {
        if (request.metaSignedRequest !== undefined) seen.push(request.metaSignedRequest);
        return { ok: true };
      },
    );
  });
  application.post('/json-elsewhere', async (request) => ({ body: request.body }));
  await application.ready();
  return { application, seen };
}

describe('instagramAccountMetaCallbackIngressPlugin — Meta’s signed request (IA18)', () => {
  let application: FastifyInstance;
  let seen: MetaSignedRequestPayload[];

  beforeEach(async () => {
    appSettings.appSecret = APP_SECRET;
    ({ application, seen } = await buildIngressApplication());
  });

  afterEach(async () => {
    await application.close();
  });

  function postForm(body: string) {
    return application.inject({
      method: 'POST',
      url: '/callback',
      headers: { 'content-type': FORM_CONTENT_TYPE },
      payload: body,
    });
  }

  function signed(payload = metaSignedRequestPayload({ userId: USER_ID }), appSecret = APP_SECRET) {
    return metaCallbackFormBody(buildMetaSignedRequest({ payload, appSecret }));
  }

  it('lets a correctly signed request through and hands the handler its user id and issued_at', async () => {
    const response = await postForm(signed());

    expect(response.statusCode).toBe(200);
    expect(seen).toEqual([{ userId: USER_ID, issuedAt: 1_763_740_000 }]);
  });

  it('accepts a field Meta may add beside signed_request (the body is Meta’s own shape)', async () => {
    const response = await postForm(`${signed()}&extra=1`);

    expect(response.statusCode).toBe(200);
  });

  it.each([
    ['signed with another secret', () => signed(undefined, 'another-secret')],
    ['another algorithm', () => signed({ algorithm: 'HMAC-SHA1', issued_at: 1, user_id: USER_ID })],
    ['no user_id', () => signed({ algorithm: 'HMAC-SHA256', issued_at: 1 })],
    [
      'a user_id that is not digits',
      () => signed({ algorithm: 'HMAC-SHA256', issued_at: 1, user_id: 'abc' }),
    ],
    ['malformed (no dot)', () => metaCallbackFormBody('not-a-signed-request')],
    ['missing (an empty form)', () => ''],
    ['missing (another field only)', () => 'something=else'],
    ['sent twice', () => `${signed()}&${signed()}`],
  ])(
    'refuses a signed request %s with 400 instagram_signed_request_invalid, before the handler',
    async (_case, body) => {
      const response = await postForm(body());

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ reason: 'instagram_signed_request_invalid' });
      expect(seen).toEqual([]);
    },
  );

  it('reads a body at the limit, and refuses one byte more with 413 before anything is verified', async () => {
    const good = signed();
    const padding = META_CALLBACK_BODY_LIMIT_BYTES - good.length;
    const atTheLimit = good + '&a'.repeat(Math.ceil(padding / 2)).slice(0, padding);
    expect(Buffer.byteLength(atTheLimit)).toBe(META_CALLBACK_BODY_LIMIT_BYTES);

    const accepted = await postForm(atTheLimit);
    expect(accepted.statusCode).toBe(200);
    expect(seen).toHaveLength(1);

    const refused = await postForm(`${atTheLimit}a`);
    expect(refused.statusCode).toBe(413);
    expect(seen).toHaveLength(1);
  });

  it('refuses a body at the limit made of repeated fields with the signature answer, at once', async () => {
    const startedAt = performance.now();

    const response = await postForm('a&'.repeat(META_CALLBACK_BODY_LIMIT_BYTES / 2));

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ reason: 'instagram_signed_request_invalid' });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it('refuses a body that is not form-encoded with 415', async () => {
    const response = await application.inject({
      method: 'POST',
      url: '/callback',
      payload: {
        signed_request: buildMetaSignedRequest({
          payload: metaSignedRequestPayload({ userId: USER_ID }),
          appSecret: APP_SECRET,
        }),
      },
    });

    expect(response.statusCode).toBe(415);
    expect(seen).toEqual([]);
  });

  it('answers 503 instagram_not_configured without an app secret, verifying nothing', async () => {
    appSettings.appSecret = null;

    const response = await postForm(signed());

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ reason: 'instagram_not_configured' });
    expect(seen).toEqual([]);
  });

  it('keeps the form parser inside its plugin: a route outside still reads JSON and refuses a form', async () => {
    const json = await application.inject({
      method: 'POST',
      url: '/json-elsewhere',
      payload: { hello: 'world' },
    });
    expect(json.statusCode).toBe(200);
    expect(json.json()).toEqual({ body: { hello: 'world' } });

    const form = await application.inject({
      method: 'POST',
      url: '/json-elsewhere',
      headers: { 'content-type': FORM_CONTENT_TYPE },
      payload: signed(),
    });
    expect(form.statusCode).toBe(415);
  });
});
