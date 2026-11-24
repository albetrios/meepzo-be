import http from 'k6/http';
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { API_PREFIX, PUBLIC_AUTH_FORM_HEADERS } from '../helpers/config.js';
import { assertCondition, requireData } from '../helpers/checks.js';
import { credentialPool } from '../helpers/pool.js';
import { totpCode } from '../helpers/totp.js';
import { sendCodeAndReadEcho, stepUpByEmailCode } from '../helpers/auth.js';

/**
 * Distinct real accounts: session revocation under an email-code step-up, the email-code way always
 * on, the password routes gone, and the full MFA ceremony with "trust this device"
 * (feat-instagram-dm-sending R32). Every sign-in and step-up sends an email code; a target with the
 * 60 s send spacing on makes each VU wait between them (set
 * `AUTH_EMAIL_CODE_RESEND_COOLDOWN_ENABLED=false` on a local or development target).
 */
const VUS = Number(__ENV.VUS || '4');
const ITERATIONS = Number(__ENV.ITERATIONS || '1');
const completed = new Counter('auth_security_journeys_completed');
export const options = {
  scenarios: {
    lifecycle: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: ITERATIONS,
      maxDuration: '15m',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    dropped_iterations: ['count==0'],
    auth_security_journeys_completed: [`count==${VUS * ITERATIONS}`],
    'http_req_duration{phase:read}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{phase:credential}': ['p(95)<1500', 'p(99)<2500'],
  },
};
export function setup() {
  if (
    !Number.isInteger(VUS) ||
    VUS < 1 ||
    !Number.isInteger(ITERATIONS) ||
    ITERATIONS < 1 ||
    credentialPool.length < VUS * ITERATIONS
  )
    throw new Error('Distinct credential required for every complete journey');
  return Array.from(credentialPool).slice(0, VUS * ITERATIONS);
}
function request(method, path, token, body, expected = 200, phase = 'credential') {
  const response = http.request(
    method,
    `${API_PREFIX}${path}`,
    body ? JSON.stringify(body) : null,
    {
      headers: {
        ...PUBLIC_AUTH_FORM_HEADERS,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      tags: {
        route: path.split('?')[0],
        name: `${method} ${path.replace(/\/(?:asm|ses)_[a-z0-9]+/g, '/:id')}`,
        phase,
      },
      responseCallback: http.expectedStatuses(expected),
    },
  );
  assertCondition(
    response.status === expected,
    `${method} ${path.split('/').slice(0, 4).join('/')}: exact ${expected}`,
  );
  return response;
}
/**
 * Email-code sign-in (passwords are off, P84): send-code with the TEST_MODE echo, then
 * `POST /auth/email/login`. Returns the sign-in result — a session, or the 2FA screen
 * (`mfa_required`, `mfa_session_token`). k6's cookie jar sends this VU's `trusted_device` cookie.
 */
function login(credential) {
  const code = sendCodeAndReadEcho(credential.email);
  return requireData(
    request('POST', '/auth/email/login', null, { email: credential.email, code }),
    'email-code sign-in',
  );
}

function emailCodeStepUp({ token, credential, name }) {
  const response = stepUpByEmailCode(token, credential.email, {
    name: 'POST /auth/step-up',
    route: '/auth/step-up',
    phase: 'credential',
  });
  assertCondition(response.status === 200, `${name}: exact 200`);
  const data = JSON.parse(response.body).data;
  assertCondition(data?.stepped_up === true && data?.factor === 'email_code', `${name}: factor`);
  return data;
}

function verifySessionRevocations({ credential, primary, token }) {
  const secondary = login(credential);
  request('DELETE', `/auth/me/sessions/${secondary.session_id}`, token, null, 403);
  emailCodeStepUp({ token, credential, name: 'email-code step-up (strong without 2FA)' });
  request('DELETE', `/auth/me/sessions/${secondary.session_id}`, token, null, 204);
  request('GET', '/users/me', secondary.access_token, null, 401, 'read');
  const third = login(credential);
  request('DELETE', '/auth/me/sessions', token, null, 204);
  request('GET', '/users/me', third.access_token, null, 401, 'read');
  const remaining = requireData(
    request('GET', '/auth/me/sessions', token, null, 200, 'read'),
    'remaining sessions',
  );
  assertCondition(
    remaining.length === 1 && remaining[0].id === primary.session_id,
    'bulk revoke retains exactly current session',
  );
}

function verifyEmailCodeAlwaysOn({ token }) {
  const methods = requireData(
    request('GET', '/auth/me/auth-methods', token, null, 200, 'read'),
    'sign-in ways',
  );
  assertCondition(
    !methods.some((row) => 'encrypted_secret' in row || 'user_id' in row),
    'credential material omitted',
  );
  const emailCodes = methods.filter((row) => row.method_type === 'EMAIL_CODE');
  if (emailCodes.length < 2) {
    // Add an email-code way (the only type this route creates). It can never be removed again
    // (AT13), so a pool user gains at most this one extra row across runs.
    const added = requireData(
      request('POST', '/auth/me/auth-methods', token, { method_type: 'EMAIL_CODE' }),
      'added email-code way',
    );
    emailCodes.push(added);
  }
  const emailCode = emailCodes[0];
  if (emailCode) {
    // The email-code way can never be removed (AT13), even under a strong step-up.
    request('DELETE', `/auth/me/auth-methods/${emailCode.id}`, token, null, 409);
  }
}

function verifyPasswordsGone({ token, credential }) {
  // Passwords are off (P84): the four routes are not registered, and the step-up takes no password.
  request('POST', '/auth/login', null, { email: credential.email, password: 'x' }, 404);
  request(
    'POST',
    '/auth/password/change',
    token,
    { current_password: 'x', new_password: 'y' },
    404,
  );
  request('POST', '/auth/step-up', token, { password: 'x' }, 400);
}

function verifyMfaLifecycle({ token, credential, state }) {
  const enrollment = requireData(
    request('POST', '/auth/me/mfa/enroll', token, { method_type: 'MFA_TOTP' }),
    'MFA init',
  );
  assertCondition(
    typeof enrollment.secret === 'string' && enrollment.provisioning_uri.startsWith('otpauth://'),
    'authenticator enrollment returned',
  );
  const code = totpCode(enrollment.secret);
  const confirmation = requireData(
    request('POST', '/auth/me/mfa/enroll/confirm', token, { code }),
    'MFA confirm',
  );
  state.mfaMethod = confirmation.mfa_method_id;
  assertCondition(
    Boolean(state.mfaMethod) && confirmation.recovery_codes.length > 1,
    'MFA factor and recovery codes issued',
  );
  const factors = requireData(request('GET', '/auth/me/mfa', token, null, 200, 'read'), 'MFA list');
  assertCondition(
    factors.some((row) => row.id === state.mfaMethod),
    'MFA factor persisted',
  );
  request('POST', '/auth/me/mfa/verify', token, { code }, 401);
  // Use the next real authenticator interval: a consumed enrollment code must never be reused.
  sleep((30000 - (Date.now() % 30000) + 100) / 1000);
  const freshCode = totpCode(enrollment.secret);
  const verified = requireData(
    request('POST', '/auth/me/mfa/verify', token, { code: freshCode }),
    'MFA step-up',
  );
  assertCondition(verified.verified === true, 'MFA step-up verified');
  request('POST', '/auth/me/mfa/verify', token, { code: freshCode }, 401);
  const challenge = login(credential);
  assertCondition(
    challenge.mfa_required === true &&
      !challenge.access_token &&
      Boolean(challenge.mfa_session_token),
    'the email code alone cannot bypass MFA',
  );
  // "Trust this device for 30 days" (AT17): the jar keeps the trusted_device cookie.
  const secondFactor = requireData(
    request('POST', '/auth/mfa/login', null, {
      mfa_session_token: challenge.mfa_session_token,
      recovery_code: confirmation.recovery_codes[0],
      trust_device: true,
    }),
    'MFA login',
  );
  assertCondition(Boolean(secondFactor.access_token), 'second factor grants session');
  const trusted = login(credential);
  assertCondition(
    Boolean(trusted.access_token) && !trusted.mfa_required,
    'a trusted browser skips the 2FA code',
  );
  // The factor was enrolled under an email-code window, so it is provisional for 72 hours: the
  // email code still opens the strong step-up that removing it needs (AT15).
  emailCodeStepUp({ token, credential, name: 'email-code step-up with a provisional factor' });
  request('DELETE', `/auth/me/mfa/${state.mfaMethod}`, token, null, 204);
  const cleared = requireData(
    request('GET', '/auth/me/mfa', token, null, 200, 'read'),
    'MFA cleared',
  );
  assertCondition(
    !cleared.some((row) => row.id === state.mfaMethod),
    'MFA factor absent after removal',
  );
  state.mfaMethod = null;
  const restored = login(credential);
  assertCondition(
    Boolean(restored.access_token) && !restored.mfa_required,
    'email-code sign-in restored without MFA',
  );
  request('POST', '/auth/logout', restored.access_token, null, 200);
}

export default function (credentials) {
  const credential = credentials[(__VU - 1) * ITERATIONS + __ITER];
  sleep((__VU - 1) * 0.05);
  const primary = login(credential);
  assertCondition(Boolean(primary.access_token && primary.session_id), 'real session issued');
  const token = primary.access_token;
  const originalProfile = requireData(
    request('GET', '/users/me', token, null, 200, 'read'),
    'owned profile',
  );
  assertCondition(
    originalProfile.id === credential.userPublicId && !originalProfile.is_mfa_enabled,
    'distinct non-MFA fixture',
  );

  const state = { mfaMethod: null };
  try {
    verifySessionRevocations({ credential, primary, token });
    verifyEmailCodeAlwaysOn({ token });
    verifyPasswordsGone({ token, credential });
    verifyMfaLifecycle({ token, credential, state });
    completed.add(1);
  } finally {
    if (state.mfaMethod) {
      emailCodeStepUp({ token, credential, name: 'clean-up step-up' });
      request('DELETE', `/auth/me/mfa/${state.mfaMethod}`, token, null, 204);
    }
  }
}
