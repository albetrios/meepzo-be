import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cryptoSpies = vi.hoisted(() => ({ timingSafeEqual: vi.fn() }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  cryptoSpies.timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: cryptoSpies.timingSafeEqual };
});

import {
  parseMetaSignedRequest,
  verifyMetaWebhookSignature,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-signature.js';

const APP_SECRET = 'meta-app-secret-for-unit-tests';
const RAW_BODY = Buffer.from('{"object":"instagram","entry":[{"id":"17841400000000000"}]}');

/** `sha256=<hex HMAC of content>` as Meta sends it. */
function hubSignature(content: Buffer | string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(content).digest('hex')}`;
}

/** `<base64url HMAC>.<base64url payload>` as Meta posts `signed_request`. */
function signedRequest(payload: unknown, secret = APP_SECRET): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${signature}.${encodedPayload}`;
}

/** A correctly signed request whose payload is `rawPayload` as is (not necessarily JSON). */
function signedRawPayload(rawPayload: string): string {
  const encodedPayload = Buffer.from(rawPayload).toString('base64url');
  const signature = createHmac('sha256', APP_SECRET).update(encodedPayload).digest('base64url');
  return `${signature}.${encodedPayload}`;
}

afterEach(() => {
  cryptoSpies.timingSafeEqual.mockClear();
});

describe('verifyMetaWebhookSignature — X-Hub-Signature-256 over the raw body (WH8)', () => {
  it('accepts the HMAC-SHA256 of the raw body with the app secret', () => {
    expect(
      verifyMetaWebhookSignature({
        rawBody: RAW_BODY,
        signatureHeader: hubSignature(RAW_BODY),
        appSecret: APP_SECRET,
      }),
    ).toBe(true);
    // Upper-case hex is still 64 hex characters.
    expect(
      verifyMetaWebhookSignature({
        rawBody: RAW_BODY.toString('utf8'),
        signatureHeader: `sha256=${hubSignature(RAW_BODY).slice(7).toUpperCase()}`,
        appSecret: APP_SECRET,
      }),
    ).toBe(true);
  });

  it('refuses a signature made with another secret, or over other bytes', () => {
    expect(
      verifyMetaWebhookSignature({
        rawBody: RAW_BODY,
        signatureHeader: hubSignature(RAW_BODY, 'another-secret'),
        appSecret: APP_SECRET,
      }),
    ).toBe(false);
    expect(
      verifyMetaWebhookSignature({
        rawBody: Buffer.from(`${RAW_BODY.toString('utf8')} `),
        signatureHeader: hubSignature(RAW_BODY),
        appSecret: APP_SECRET,
      }),
    ).toBe(false);
  });

  it('refuses a missing header and an empty app secret', () => {
    expect(
      verifyMetaWebhookSignature({
        rawBody: RAW_BODY,
        signatureHeader: undefined,
        appSecret: APP_SECRET,
      }),
    ).toBe(false);
    expect(
      verifyMetaWebhookSignature({
        rawBody: RAW_BODY,
        signatureHeader: hubSignature(RAW_BODY, ''),
        appSecret: '',
      }),
    ).toBe(false);
  });

  it.each([
    ['no prefix', hubSignature(RAW_BODY).slice(7)],
    ['the sha1 prefix', `sha1=${hubSignature(RAW_BODY).slice(7)}`],
    ['63 hex characters', hubSignature(RAW_BODY).slice(0, -1)],
    ['65 hex characters', `${hubSignature(RAW_BODY)}0`],
    ['a non-hex character', `${hubSignature(RAW_BODY).slice(0, -1)}g`],
    ['surrounding spaces', ` ${hubSignature(RAW_BODY)} `],
  ])('refuses a malformed header (%s) before any comparison', (_label, signatureHeader) => {
    expect(
      verifyMetaWebhookSignature({ rawBody: RAW_BODY, signatureHeader, appSecret: APP_SECRET }),
    ).toBe(false);
    expect(cryptoSpies.timingSafeEqual).not.toHaveBeenCalled();
  });

  it('compares a well-formed wrong signature in constant time (timingSafeEqual, equal lengths)', () => {
    const wrong = `sha256=${'0'.repeat(64)}`;

    expect(
      verifyMetaWebhookSignature({
        rawBody: RAW_BODY,
        signatureHeader: wrong,
        appSecret: APP_SECRET,
      }),
    ).toBe(false);
    expect(cryptoSpies.timingSafeEqual).toHaveBeenCalledOnce();
    const [presented, expected] = cryptoSpies.timingSafeEqual.mock.calls[0] as [Buffer, Buffer];
    expect(presented).toHaveLength(32);
    expect(expected).toHaveLength(32);
  });
});

describe("parseMetaSignedRequest — Meta's signed request (IA18)", () => {
  const validPayload = {
    algorithm: 'HMAC-SHA256',
    issued_at: 1_763_700_000,
    user_id: '12345678901234567',
  };

  it('returns the user id and issued_at of a correctly signed request', () => {
    expect(
      parseMetaSignedRequest({ signedRequest: signedRequest(validPayload), appSecret: APP_SECRET }),
    ).toEqual({ userId: '12345678901234567', issuedAt: 1_763_700_000 });
  });

  it('accepts an exact numeric user_id and a request without issued_at', () => {
    expect(
      parseMetaSignedRequest({
        signedRequest: signedRequest({ algorithm: 'HMAC-SHA256', user_id: 987654321 }),
        appSecret: APP_SECRET,
      }),
    ).toEqual({ userId: '987654321', issuedAt: null });
  });

  it('refuses a request signed with another secret', () => {
    expect(
      parseMetaSignedRequest({
        signedRequest: signedRequest(validPayload, 'another-secret'),
        appSecret: APP_SECRET,
      }),
    ).toBeNull();
  });

  it('refuses a payload changed after signing', () => {
    const [signature] = signedRequest(validPayload).split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ ...validPayload, user_id: '1' })).toString(
      'base64url',
    );
    expect(
      parseMetaSignedRequest({
        signedRequest: `${signature}.${forgedPayload}`,
        appSecret: APP_SECRET,
      }),
    ).toBeNull();
  });

  it('refuses another algorithm and a missing or non-digit user_id, even when signed', () => {
    for (const payload of [
      { ...validPayload, algorithm: 'HMAC-SHA1' },
      { algorithm: 'HMAC-SHA256', issued_at: 1 },
      { ...validPayload, user_id: '12a4' },
      { ...validPayload, user_id: '' },
    ]) {
      expect(
        parseMetaSignedRequest({ signedRequest: signedRequest(payload), appSecret: APP_SECRET }),
      ).toBeNull();
    }
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['one part', 'abc'],
    ['three parts', 'a.b.c'],
    ['not base64url', 'a+b/c.d+e/f'],
    ['a signed payload that is not JSON', signedRawPayload('not json')],
    ['a signed payload that is a JSON list', signedRawPayload('[1,2]')],
  ])('refuses a malformed signed request (%s)', (_label, value) => {
    expect(parseMetaSignedRequest({ signedRequest: value, appSecret: APP_SECRET })).toBeNull();
  });

  it('refuses everything when the app secret is empty', () => {
    expect(
      parseMetaSignedRequest({ signedRequest: signedRequest(validPayload, ''), appSecret: '' }),
    ).toBeNull();
  });

  it('checks the signature in constant time before parsing the payload', () => {
    const [, encodedPayload] = signedRequest(validPayload).split('.');
    const wrongSignature = Buffer.alloc(32).toString('base64url');
    const parse = vi.spyOn(JSON, 'parse');

    expect(
      parseMetaSignedRequest({
        signedRequest: `${wrongSignature}.${encodedPayload}`,
        appSecret: APP_SECRET,
      }),
    ).toBeNull();
    expect(cryptoSpies.timingSafeEqual).toHaveBeenCalledOnce();
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });
});
