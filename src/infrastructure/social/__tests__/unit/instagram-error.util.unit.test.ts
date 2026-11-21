import { describe, expect, it } from 'vitest';
import { ExternalServiceError } from '@/infrastructure/outbound/outbound-error.js';
import {
  buildInstagramMalformedAnswerError,
  classifyInstagramErrorResponse,
  INSTAGRAM_OUTSIDE_MESSAGING_WINDOW_SUBCODE,
  INSTAGRAM_THROTTLE_DEFAULT_RETRY_AFTER_MS,
  InstagramApiError,
  MESSENGER_OUTSIDE_MESSAGING_WINDOW_SUBCODE,
  readInstagramErrorBody,
  readInstagramErrorResponse,
  readInstagramRetryAfterMs,
  toInstagramApiError,
} from '@/infrastructure/social/instagram-error.util.js';

/** A Graph error body, as graph.instagram.com sends it. */
function graphErrorBody(error: {
  code: number;
  error_subcode?: number;
  type?: string;
  message?: string;
}): string {
  return JSON.stringify({
    error: {
      message: 'Instagram says no',
      type: 'OAuthException',
      fbtrace_id: 'trace-1',
      ...error,
    },
  });
}

/** Instagram's error answer for `body` at `httpStatus`, read the way every client call reads it. */
function answer({
  httpStatus,
  body,
  retryAfterHeader = null,
}: {
  httpStatus: number;
  body: string;
  retryAfterHeader?: string | null;
}): InstagramApiError {
  return readInstagramErrorResponse({ httpStatus, body, retryAfterHeader });
}

describe('readInstagramErrorBody', () => {
  it('reads the Graph shape once — code, subcode, type, message, fbtrace id', () => {
    expect(
      readInstagramErrorBody(graphErrorBody({ code: 190, error_subcode: 463, message: 'expired' })),
    ).toEqual({
      code: 190,
      subcode: 463,
      type: 'OAuthException',
      message: 'expired',
      fbtraceId: 'trace-1',
    });
  });

  it("reads the code exchange's flat shape (error_type, code, error_message)", () => {
    const body = JSON.stringify({
      error_type: 'OAuthException',
      code: 400,
      error_message: 'Invalid authorization code',
    });
    expect(readInstagramErrorBody(body)).toEqual({
      code: 400,
      subcode: null,
      type: 'OAuthException',
      message: 'Invalid authorization code',
      fbtraceId: null,
    });
  });

  it('reads a body that is not JSON, or JSON of neither shape, as all null', () => {
    const empty = { code: null, subcode: null, type: null, message: null, fbtraceId: null };
    expect(readInstagramErrorBody('<html>Bad Gateway</html>')).toEqual(empty);
    expect(readInstagramErrorBody('[1,2]')).toEqual(empty);
    expect(readInstagramErrorBody('null')).toEqual(empty);
  });

  it("cuts Instagram's message to 300 characters", () => {
    const details = readInstagramErrorBody(graphErrorBody({ code: 100, message: 'x'.repeat(900) }));
    expect(details.message).toHaveLength(300);
  });
});

describe('classifyInstagramErrorResponse — the four classes of IA4', () => {
  const classify = (httpStatus: number, code: number | null, subcode: number | null = null) =>
    classifyInstagramErrorResponse({
      httpStatus,
      details: { code, subcode, type: null, message: null, fbtraceId: null },
    });

  it('auth: code 190 with subcode 463 → expired', () => {
    expect(classify(400, 190, 463)).toEqual({ errorClass: 'auth', connectionStatus: 'expired' });
  });

  it.each([[460], [464], [null]])('auth: code 190 with subcode %s → error', (subcode) => {
    expect(classify(400, 190, subcode)).toEqual({ errorClass: 'auth', connectionStatus: 'error' });
  });

  it.each([[10], [200], [250], [299]])('auth: permission code %s → error', (code) => {
    expect(classify(403, code)).toEqual({ errorClass: 'auth', connectionStatus: 'error' });
  });

  it('names Meta\'s two "outside the messaging window" subcodes (D32)', () => {
    expect(INSTAGRAM_OUTSIDE_MESSAGING_WINDOW_SUBCODE).toBe(2534022);
    expect(MESSENGER_OUTSIDE_MESSAGING_WINDOW_SUBCODE).toBe(2018278);
  });

  it.each([
    [INSTAGRAM_OUTSIDE_MESSAGING_WINDOW_SUBCODE],
    [MESSENGER_OUTSIDE_MESSAGING_WINDOW_SUBCODE],
  ])(
    'refused: code 10 outside the messaging window (subcode %s) — the account is not marked broken',
    (subcode) => {
      expect(classify(400, 10, subcode)).toEqual({ errorClass: 'refused', connectionStatus: null });
      // The code decides before the status, as for code 190.
      expect(classify(500, 10, subcode)).toEqual({ errorClass: 'refused', connectionStatus: null });
    },
  );

  it.each([[null], [33], [2534015]])('auth: plain code 10 (subcode %s) → error', (subcode) => {
    expect(classify(400, 10, subcode)).toEqual({ errorClass: 'auth', connectionStatus: 'error' });
  });

  it('a window subcode under another code is not a window refusal', () => {
    expect(classify(403, 200, INSTAGRAM_OUTSIDE_MESSAGING_WINDOW_SUBCODE)).toEqual({
      errorClass: 'auth',
      connectionStatus: 'error',
    });
  });

  it.each([[4], [17], [32], [613]])('throttled: code %s', (code) => {
    expect(classify(400, code).errorClass).toBe('throttled');
  });

  it('throttled: HTTP 429 without a code', () => {
    expect(classify(429, null).errorClass).toBe('throttled');
  });

  it.each([
    [400, 100],
    [400, 300],
    [404, null],
    [401, null],
  ])('refused: any other 4xx (HTTP %s, code %s)', (httpStatus, code) => {
    expect(classify(httpStatus, code)).toEqual({ errorClass: 'refused', connectionStatus: null });
  });

  it.each([[500], [502], [503]])('outage: HTTP %s', (httpStatus) => {
    expect(classify(httpStatus, 1).errorClass).toBe('outage');
  });

  it('reads the code before the status: a 5xx carrying code 190 is still auth', () => {
    expect(classify(500, 190, 463).errorClass).toBe('auth');
  });
});

describe('readInstagramRetryAfterMs', () => {
  it('reads whole seconds, at least one', () => {
    expect(readInstagramRetryAfterMs('120')).toBe(120_000);
    expect(readInstagramRetryAfterMs('0')).toBe(1_000);
  });

  it('falls back to the default wait when the header is absent or unreadable', () => {
    expect(readInstagramRetryAfterMs(null)).toBe(INSTAGRAM_THROTTLE_DEFAULT_RETRY_AFTER_MS);
    expect(readInstagramRetryAfterMs('soon')).toBe(INSTAGRAM_THROTTLE_DEFAULT_RETRY_AFTER_MS);
  });
});

describe('readInstagramErrorResponse', () => {
  it('a dead token is auth, never counted against the circuit', () => {
    const error = answer({
      httpStatus: 400,
      body: graphErrorBody({ code: 190, error_subcode: 463 }),
    });

    expect(error).toBeInstanceOf(InstagramApiError);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(error).toMatchObject({
      errorClass: 'auth',
      connectionStatus: 'expired',
      integration: 'instagram',
      category: 'http_4xx',
      status: 400,
      instagramErrorCode: 190,
      instagramErrorSubcode: 463,
      fbtraceId: 'trace-1',
      upstreamRequestId: 'trace-1',
      countsAsCircuitFailure: false,
      isQuickReplyRefused: false,
    });
    expect(error.retryAfterMs).toBeUndefined();
  });

  it('a throttle carries the wait, answers 503 with Retry-After, and does not count against the circuit', () => {
    const error = answer({
      httpStatus: 429,
      body: graphErrorBody({ code: 4 }),
      retryAfterHeader: '30',
    });

    expect(error).toMatchObject({
      errorClass: 'throttled',
      retryAfterMs: 30_000,
      statusCode: 503,
      retryAfterSeconds: 30,
      countsAsCircuitFailure: false,
    });
  });

  it('a throttle code on HTTP 400 without Retry-After waits the default', () => {
    const error = answer({ httpStatus: 400, body: graphErrorBody({ code: 613 }) });
    expect(error.errorClass).toBe('throttled');
    expect(error.retryAfterMs).toBe(INSTAGRAM_THROTTLE_DEFAULT_RETRY_AFTER_MS);
  });

  it('a bad authorization code is refused, never counted against the circuit', () => {
    const body = JSON.stringify({
      error_type: 'OAuthException',
      code: 400,
      error_message: 'This authorization code has been used',
    });
    expect(answer({ httpStatus: 400, body })).toMatchObject({
      errorClass: 'refused',
      connectionStatus: null,
      countsAsCircuitFailure: false,
      instagramErrorMessage: 'This authorization code has been used',
    });
  });

  it('flags the email / phone quick reply refusal (code 100, subcode 2534015) as refused', () => {
    const error = answer({
      httpStatus: 400,
      body: graphErrorBody({ code: 100, error_subcode: 2534015 }),
    });
    expect(error).toMatchObject({ errorClass: 'refused', isQuickReplyRefused: true });
    expect(
      answer({ httpStatus: 400, body: graphErrorBody({ code: 100, error_subcode: 33 }) })
        .isQuickReplyRefused,
    ).toBe(false);
  });

  it('a message outside the messaging window is refused, carries no connection status and never counts against the circuit', () => {
    const error = answer({
      httpStatus: 400,
      body: graphErrorBody({
        code: 10,
        error_subcode: INSTAGRAM_OUTSIDE_MESSAGING_WINDOW_SUBCODE,
        message: '(#10) This message is sent outside of allowed window.',
      }),
    });
    expect(error).toMatchObject({
      errorClass: 'refused',
      connectionStatus: null,
      instagramErrorCode: 10,
      instagramErrorSubcode: INSTAGRAM_OUTSIDE_MESSAGING_WINDOW_SUBCODE,
      isQuickReplyRefused: false,
      countsAsCircuitFailure: false,
    });
    expect(error.message).toBe('Instagram answered HTTP 400: refused (code 10, subcode 2534022)');
  });

  it('a 5xx is an outage and counts against the circuit', () => {
    const error = answer({ httpStatus: 502, body: '<html>Bad Gateway</html>' });
    expect(error).toMatchObject({
      errorClass: 'outage',
      category: 'http_5xx',
      status: 502,
      countsAsCircuitFailure: true,
    });
  });

  it('names the class, status and codes in its message — never Instagram text', () => {
    const error = answer({
      httpStatus: 400,
      body: graphErrorBody({ code: 190, error_subcode: 463, message: 'secret-ish detail' }),
    });
    expect(error.message).toBe('Instagram answered HTTP 400: auth (code 190, subcode 463)');
    expect(error.message).not.toContain('secret-ish');
  });
});

describe('toInstagramApiError', () => {
  it.each([
    ['timeout' as const],
    ['network' as const],
    ['http_5xx' as const],
    ['unknown' as const],
  ])('turns an outbound %s failure into an outage that counts against the circuit', (category) => {
    const failure = new ExternalServiceError({ integration: 'instagram', category });
    const error = toInstagramApiError(failure);

    expect(error).toBeInstanceOf(InstagramApiError);
    expect(error).toMatchObject({
      errorClass: 'outage',
      category,
      countsAsCircuitFailure: true,
      cause: failure,
    });
  });

  it("keeps an open circuit's wait, so the answer is 503 with Retry-After", () => {
    const circuitOpen = new ExternalServiceError({
      integration: 'instagram',
      category: 'circuit_open',
      retryAfterMs: 12_000,
    });
    expect(toInstagramApiError(circuitOpen)).toMatchObject({
      errorClass: 'outage',
      category: 'circuit_open',
      retryAfterMs: 12_000,
      retryAfterSeconds: 12,
    });
  });

  it('classes a bare 4xx by its status', () => {
    const throttled = new ExternalServiceError({
      integration: 'instagram',
      category: 'http_4xx',
      status: 429,
    });
    expect(toInstagramApiError(throttled)).toMatchObject({ errorClass: 'throttled' });
  });

  it('passes an InstagramApiError and our own failures through unchanged', () => {
    const instagramError = answer({ httpStatus: 400, body: graphErrorBody({ code: 190 }) });
    const ownFailure = new Error('field-secret value is not encrypted');

    expect(toInstagramApiError(instagramError)).toBe(instagramError);
    expect(toInstagramApiError(ownFailure)).toBe(ownFailure);
  });
});

describe('buildInstagramMalformedAnswerError', () => {
  it('is an outage naming what the answer lacked', () => {
    const error = buildInstagramMalformedAnswerError({
      operation: 'the token renewal',
      missing: 'expires_in',
    });
    expect(error).toMatchObject({ errorClass: 'outage', category: 'unknown' });
    expect(error.message).toBe('Instagram answered the token renewal without expires_in');
  });
});
