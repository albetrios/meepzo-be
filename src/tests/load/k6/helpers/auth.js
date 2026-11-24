import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, PUBLIC_AUTH_FORM_HEADERS } from './config.js';

/**
 * `POST /auth/email/send-code` and return the code the target echoes under `TEST_MODE`
 * (`debug_verification_code`). A send within 60 s of the last one for this email answers
 * `429 code_resend_too_soon` with `retry_after_seconds`: this waits that long once and sends again.
 */
export function sendCodeAndReadEcho(email) {
  let sent = http.post(`${API_PREFIX}/auth/email/send-code`, JSON.stringify({ email }), {
    headers: PUBLIC_AUTH_FORM_HEADERS,
    tags: { name: 'send-code' },
    // The send spacing's 429 is waited out below, not a failed request.
    responseCallback: http.expectedStatuses(200, 429),
  });
  if (sent.status === 429) {
    const waitSeconds = Number(JSON.parse(sent.body).error?.retry_after_seconds ?? 60);
    sleep(waitSeconds + 1);
    sent = http.post(`${API_PREFIX}/auth/email/send-code`, JSON.stringify({ email }), {
      headers: PUBLIC_AUTH_FORM_HEADERS,
      tags: { name: 'send-code' },
    });
  }
  if (sent.status !== 200) throw new Error(`Load send-code failed with HTTP ${sent.status}`);
  const code = JSON.parse(sent.body).data?.debug_verification_code;
  if (typeof code !== 'string' || code.length === 0) {
    throw new Error('Load send-code returned no code echo — the target needs TEST_MODE');
  }
  return code;
}

/**
 * Step up on `token`'s session with an email code (`POST /auth/step-up`, route 127) and return the
 * response. For a person without settled 2FA this is a strong step-up (AT15): it covers deleting an
 * organization, the data export, revoking sessions and removing a credential. A person with settled
 * 2FA is refused with `403 mfa_step_up_required` and steps up with `POST /auth/me/mfa/verify`.
 */
export function stepUpByEmailCode(token, email, tags = { name: 'step-up' }) {
  const code = sendCodeAndReadEcho(email);
  return http.post(`${API_PREFIX}/auth/step-up`, JSON.stringify({ code }), {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    tags,
  });
}

/**
 * Sign in by email code and return the access token (passwords are off, P84).
 *
 * `POST /auth/email/send-code`, then `POST /auth/email/login` with the code the target echoes under
 * `TEST_MODE` (`debug_verification_code`) — a load target must run with it. Each sign-in emails
 * the account a new code; a second send for the same email within 60 s is refused
 * (`429 code_resend_too_soon`) unless the target turns the resend spacing off
 * (`AUTH_EMAIL_CODE_RESEND_COOLDOWN_ENABLED=false`, local and development only).
 *
 * The token is a signed JWT whose `org` claim is the user's default active organization.
 * Organization-scoped routes resolve the tenant from this claim — there is no `{organization_id}`
 * path segment and no organization id header for the flat routes. To act in a different
 * organization, re-mint the token with `switchToOrganization` / `switchToPersonal`.
 */
export function login(email) {
  const code = sendCodeAndReadEcho(email);
  const response = http.post(`${API_PREFIX}/auth/email/login`, JSON.stringify({ email, code }), {
    headers: PUBLIC_AUTH_FORM_HEADERS,
  });

  if (response.status === 200) {
    const body = JSON.parse(response.body);
    const token = body.data?.access_token || body.data?.token;
    if (typeof token === 'string' && token.length > 0) return token;
    throw new Error('Load login returned no access token');
  }
  throw new Error(`Load login failed with HTTP ${response.status}`);
}

/**
 * Re-mint the access token scoped to a specific team organization the user belongs to
 * (`POST /auth/switch-to-organization`). Use the returned token for subsequent organization-scoped calls —
 * the active organization rides its `org` claim. Returns the new token, or null on failure.
 */
export function switchToOrganization(token, organizationPublicId) {
  const response = http.post(
    `${API_PREFIX}/auth/switch-to-organization`,
    JSON.stringify({ organization_id: organizationPublicId }),
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
  );
  if (response.status === 200) {
    const body = JSON.parse(response.body);
    if (typeof body.data?.access_token !== 'string' || !body.data.access_token) {
      throw new Error('Load organization switch returned no access token');
    }
    return body.data.access_token;
  }
  throw new Error(`Load organization switch failed with HTTP ${response.status}`);
}

/**
 * Re-mint the access token scoped to the caller's personal organization
 * (`POST /auth/switch-to-personal`). Returns the new token, or null on failure.
 */
export function switchToPersonal(token) {
  const response = http.post(`${API_PREFIX}/auth/switch-to-personal`, null, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (response.status === 200) {
    const body = JSON.parse(response.body);
    if (typeof body.data?.access_token !== 'string' || !body.data.access_token) {
      throw new Error('Load organization switch returned no access token');
    }
    return body.data.access_token;
  }
  throw new Error(`Load organization switch failed with HTTP ${response.status}`);
}

/**
 * Convenience: log in, then switch the active organization so the returned token is scoped to
 * `organizationPublicId`. Returns the plain login token only when no organization is requested.
 * Login or requested scope failure aborts setup instead of targeting another tenant.
 */
export function loginScopedToOrganization(email, organizationPublicId) {
  const token = login(email);
  if (!(token && organizationPublicId)) return token;
  return switchToOrganization(token, organizationPublicId);
}

/**
 * Build authorization headers for authenticated requests.
 *
 * The active organization comes from the token's `org` claim — do NOT add an organization id
 * header for organization-scoped routes (it is ignored by the flat routes; only the upload domain reads it).
 */
export function authHeaders(token) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
}
