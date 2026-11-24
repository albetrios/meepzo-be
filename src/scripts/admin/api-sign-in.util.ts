import { generate as generateTotpCode } from 'otplib';
import { TOTP_STEP_SECONDS } from '@/shared/constants/ttl.constants.js';

/**
 * The answers the sign-in routes give: `POST /auth/email/send-code` (the TEST_MODE code echo) and
 * `POST /auth/email/login` / `POST /auth/mfa/login` (a session, or an MFA challenge).
 */
type LoginAnswer = {
  access_token?: string;
  mfa_required?: boolean;
  mfa_session_token?: string;
  debug_verification_code?: string;
};

/** Sends one JSON POST to the API and returns the status and the `data` of the answer. */
async function postJson(options: { url: string; body: Record<string, unknown> }): Promise<{
  status: number;
  ok: boolean;
  text: string;
  data: LoginAnswer | undefined;
  retryAfterSeconds: number | undefined;
}> {
  const response = await fetch(options.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options.body),
  });
  const text = await response.text();
  let data: LoginAnswer | undefined;
  let retryAfterSeconds: number | undefined;
  try {
    const parsed = JSON.parse(text) as {
      data?: LoginAnswer;
      error?: { retry_after_seconds?: number };
    };
    data = parsed.data;
    retryAfterSeconds = parsed.error?.retry_after_seconds;
  } catch {
    data = undefined;
  }
  return { status: response.status, ok: response.ok, text, data, retryAfterSeconds };
}

/** Longest wait for a `429 code_resend_too_soon` before asking again (the resend spacing is 60 s). */
const MAXIMUM_RESEND_WAIT_SECONDS = 65;

/**
 * Asks for an email code and returns the TEST_MODE echo of it. Waits out one
 * `429 code_resend_too_soon` (another tool asked a moment ago) and asks again.
 */
async function requestEchoedEmailCode(options: {
  apiPrefix: string;
  email: string;
}): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const sent = await postJson({
      url: `${options.apiPrefix}/auth/email/send-code`,
      body: { email: options.email },
    });
    if (sent.status === 429 && attempt === 1 && sent.retryAfterSeconds !== undefined) {
      const waitSeconds = Math.min(sent.retryAfterSeconds, MAXIMUM_RESEND_WAIT_SECONDS);
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      continue;
    }
    if (!sent.ok) {
      console.error('Send-code for %s failed: %d %s', options.email, sent.status, sent.text);
      process.exit(1);
    }
    if (!sent.data?.debug_verification_code) {
      console.error(
        'The API did not echo the email code: sign-in over the API needs TEST_MODE on the target (passwords are off).',
      );
      process.exit(1);
    }
    return sent.data.debug_verification_code;
  }
}

/** Milliseconds until the next TOTP time step starts, so a fresh code differs from the last. */
function millisecondsUntilNextTotpStep(nowMilliseconds = Date.now()): number {
  const stepMilliseconds = TOTP_STEP_SECONDS * 1000;
  return stepMilliseconds - (nowMilliseconds % stepMilliseconds) + 250;
}

/**
 * Sign in over the running API and return the session's access token, for the operator tools that
 * mint k6 credentials (`tool:load-test-credentials`, `tool:admin-token`).
 *
 * @remarks
 * - **Algorithm:** `POST /auth/email/send-code`, then `POST /auth/email/login` with the code the
 *   target echoes under `TEST_MODE` (passwords are off, P84). A session answer returns its
 *   `access_token`. An `mfa_required` answer — every platform admin (A-2) — is completed with
 *   `POST /auth/mfa/login`, a TOTP code computed from `totpSecret` (otplib, the library the API
 *   verifies with). A refused code is retried once on the next time step with a fresh login: the
 *   API rejects a code already used in its window (another tool signed in a moment ago), and the
 *   `mfa_session_token` is single-use.
 * - **Failure modes:** exits the process with a message on a non-2xx answer (its body is printed
 *   and holds no secret), on a target that does not echo the code (no `TEST_MODE`), on an MFA
 *   challenge without `totpSecret`, or on an answer without `access_token`. Every caller is a CLI whose only useful reaction is to stop.
 * - **Side effects:** network calls to the API (each sends the account an email code); may wait
 *   up to one TOTP step (30 s) and one resend spacing (60 s) before the retry.
 */
export async function signInOverApi(options: {
  apiPrefix: string;
  email: string;
  /** Base32 TOTP secret of the account's MFA factor; required when the account has one. */
  totpSecret?: string | undefined;
}): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const code = await requestEchoedEmailCode({
      apiPrefix: options.apiPrefix,
      email: options.email,
    });
    const login = await postJson({
      url: `${options.apiPrefix}/auth/email/login`,
      body: { email: options.email, code },
    });
    if (!login.ok) {
      console.error('Login as %s failed: %d %s', options.email, login.status, login.text);
      process.exit(1);
    }
    if (login.data?.access_token) return login.data.access_token;
    if (!(login.data?.mfa_required && login.data.mfa_session_token)) {
      console.error('Login response missing access_token');
      process.exit(1);
    }
    if (!options.totpSecret) {
      console.error(
        '%s has MFA enrolled: set its TOTP secret (ADMIN_TOTP_SECRET or DEMO_TOTP_SECRET) to complete POST /auth/mfa/login.',
        options.email,
      );
      process.exit(1);
    }

    const verification = await postJson({
      url: `${options.apiPrefix}/auth/mfa/login`,
      body: {
        mfa_session_token: login.data.mfa_session_token,
        totp_code: await generateTotpCode({ secret: options.totpSecret }),
      },
    });
    if (verification.ok && verification.data?.access_token) {
      return verification.data.access_token;
    }
    if (verification.status !== 401 || attempt > 1) {
      console.error(
        'MFA login as %s failed: %d %s',
        options.email,
        verification.status,
        verification.text,
      );
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, millisecondsUntilNextTotpStep()));
  }
}
