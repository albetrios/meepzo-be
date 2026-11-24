import { generateSecret, verify } from 'otplib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signInOverApi } from '@/scripts/admin/api-sign-in.util.js';

/**
 * A-2 follow-up: `tool:admin-token` signs in as a platform admin by email code (passwords are off,
 * P84 — the target echoes the code under TEST_MODE), and the sign-in answers `mfa_required`. The sign-in completes `POST /auth/mfa/login` with a TOTP code from the account's
 * secret, and retries once on the next time step when the code was just used by another tool.
 */
/** A fresh fixture secret per run (otplib's own generator), never a real factor. */
const SECRET = generateSecret();
const API_PREFIX = 'http://127.0.0.1:3000/api/v1';

function answer(status: number, data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const mfaChallenge = () => answer(200, { mfa_required: true, mfa_session_token: 'mst_1' });
const codeSent = () => answer(200, { message: 'sent', debug_verification_code: '482913' });

describe('signInOverApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns the access token of an email-code sign-in (send-code, then email/login)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(codeSent())
      .mockResolvedValueOnce(answer(200, { access_token: 'token-email-code' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(signInOverApi({ apiPrefix: API_PREFIX, email: 'a@example.com' })).resolves.toBe(
      'token-email-code',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [sendUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(sendUrl).toBe(`${API_PREFIX}/auth/email/send-code`);
    const [loginUrl, loginInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(loginUrl).toBe(`${API_PREFIX}/auth/email/login`);
    expect(JSON.parse(String(loginInit.body))).toEqual({ email: 'a@example.com', code: '482913' });
  });

  it('stops when the target does not echo the code (no TEST_MODE)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer(200, { message: 'sent' })),
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        signInOverApi({ apiPrefix: API_PREFIX, email: 'a@example.com' }),
      ).rejects.toThrow('process.exit');
      expect(String(error.mock.calls[0]?.[0])).toContain('TEST_MODE');
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it('completes an MFA challenge with a TOTP code the secret verifies', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(codeSent())
      .mockResolvedValueOnce(mfaChallenge())
      .mockResolvedValueOnce(answer(200, { access_token: 'token-mfa' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      signInOverApi({
        apiPrefix: API_PREFIX,
        email: 'ops@example.com',
        totpSecret: SECRET,
      }),
    ).resolves.toBe('token-mfa');

    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toBe(`${API_PREFIX}/auth/mfa/login`);
    const body = JSON.parse(String(init.body)) as { mfa_session_token: string; totp_code: string };
    expect(body.mfa_session_token).toBe('mst_1');
    expect((await verify({ secret: SECRET, token: body.totp_code })).valid).toBe(true);
  });

  it('retries once on the next time step when the code is refused', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(codeSent())
      .mockResolvedValueOnce(mfaChallenge())
      .mockResolvedValueOnce(answer(401, {}))
      .mockResolvedValueOnce(codeSent())
      .mockResolvedValueOnce(mfaChallenge())
      .mockResolvedValueOnce(answer(200, { access_token: 'token-retried' }));
    vi.stubGlobal('fetch', fetchMock);

    const signIn = signInOverApi({
      apiPrefix: API_PREFIX,
      email: 'ops@example.com',
      totpSecret: SECRET,
    });
    await vi.advanceTimersByTimeAsync(31_000);

    await expect(signIn).resolves.toBe('token-retried');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('stops instead of returning a token when the MFA challenge has no secret', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(codeSent()).mockResolvedValueOnce(mfaChallenge()),
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        signInOverApi({ apiPrefix: API_PREFIX, email: 'ops@example.com' }),
      ).rejects.toThrow('process.exit');
      expect(exit).toHaveBeenCalledWith(1);
      expect(String(error.mock.calls[0]?.[0])).toContain('ADMIN_TOTP_SECRET');
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});
