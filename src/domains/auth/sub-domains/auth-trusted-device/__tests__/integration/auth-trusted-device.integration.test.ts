import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { generate as generateTotpCode } from 'otplib';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { generateTestTokenAndSession, signInWithEmailCode } from '@/tests/helpers/test-auth.js';
import { seedRecentStepUpForTestUser } from '@/tests/helpers/test-step-up.helper.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { organization_settings } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.schema.js';
import { sessions } from '@/domains/auth/sub-domains/auth-session/auth-session.schema.js';
import { audit_outbox } from '@/domains/audit/audit-outbox.schema.js';
import { trusted_devices } from '@/domains/auth/sub-domains/auth-trusted-device/auth-trusted-device.schema.js';
import { TrustedDeviceRepository } from '@/domains/auth/sub-domains/auth-trusted-device/auth-trusted-device.repository.js';
import { TrustedDeviceService } from '@/domains/auth/sub-domains/auth-trusted-device/auth-trusted-device.service.js';
import { TRUSTED_DEVICE_COOKIE_NAME as COOKIE } from '@/domains/auth/auth.http.util.js';
import { TRUSTED_DEVICES_MAX } from '@/domains/auth/sub-domains/auth-trusted-device/auth-trusted-device.constants.js';

/** Codes each TOTP secret has already spent in this file — the server refuses a replayed code. */
const spentTotpCodesBySecret = new Map<string, Set<string>>();

/** A TOTP code the server accepts now that this secret has not spent (current, next, previous window). */
async function unspentTotpCode(secret: string): Promise<string> {
  const spentCodes = spentTotpCodesBySecret.get(secret) ?? new Set<string>();
  spentTotpCodesBySecret.set(secret, spentCodes);
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const offsetSeconds of [0, 30, -30]) {
    const candidate = await generateTotpCode({ secret, epoch: nowSeconds + offsetSeconds });
    if (!spentCodes.has(candidate)) {
      spentCodes.add(candidate);
      return candidate;
    }
  }
  throw new Error('Every TOTP code in the accepted window is already spent');
}

/** The value of one `Set-Cookie` of the response, or undefined. */
function setCookie(
  headers: { 'set-cookie'?: string | string[] | number | undefined },
  name: string,
): string | undefined {
  const raw = headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return cookies.find((cookie) => cookie.startsWith(`${name}=`));
}

/** The error envelope's `reason` and extra fields. */
function errorOf(response: { json: () => unknown }) {
  return (
    response.json() as {
      error?: { reason?: string; tries_left?: number; retry_after_seconds?: number };
    }
  ).error;
}

/**
 * "Trust this device for 30 days" (feat-instagram-dm-sending R32, routes-final § 10.C AT16, AT17;
 * AC-13.8–AC-13.10): route 126's `trust_device`, the skip at sign-in, its limits and early ends.
 */
describe('trusted devices and the 2FA sign-in step (routes 126, 144, 145)', () => {
  let app: FastifyInstance;
  const trustedDeviceService = new TrustedDeviceService(new TrustedDeviceRepository());

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  /** A person with a settled TOTP factor (enrolled under an MFA window, so not provisional). */
  async function personWithTwoFactor(options: { email?: string } = {}) {
    const user = await createTestUser({
      isEmailVerified: true,
      ...(options.email ? { email: options.email } : {}),
    });
    const { token, sessionPublicId } = await generateTestTokenAndSession({
      userId: user.public_id,
    });
    await seedRecentStepUpForTestUser(user.public_id, sessionPublicId, 'mfa');
    const enroll = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/me/mfa/enroll'),
      token,
      payload: { method_type: 'MFA_TOTP' },
    });
    expect(enroll.statusCode, enroll.body).toBe(200);
    const { secret } = (enroll.json() as { data: { secret: string } }).data;
    const confirm = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/me/mfa/enroll/confirm'),
      token,
      payload: { code: await unspentTotpCode(secret) },
    });
    expect(confirm.statusCode, confirm.body).toBe(200);
    return { user, token, sessionPublicId, secret };
  }

  /** Signs in by email code, sending `trustedDeviceToken` as the cookie when given. */
  function signIn(email: string, trustedDeviceToken?: string) {
    return signInWithEmailCode(app, {
      email,
      ...(trustedDeviceToken ? { headers: { cookie: `${COOKIE}=${trustedDeviceToken}` } } : {}),
    });
  }

  /** Signs in and completes the 2FA step with a right code, ticking "trust this device". */
  async function signInAndTrust(options: { email: string; secret: string }) {
    const first = await signIn(options.email);
    expect(first.statusCode, first.body).toBe(200);
    const { mfa_session_token: mfaSessionToken } = (
      first.json() as { data: { mfa_session_token: string } }
    ).data;
    expect(mfaSessionToken).toBeTypeOf('string');
    const second = await injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/mfa/login'),
      payload: {
        mfa_session_token: mfaSessionToken,
        totp_code: await unspentTotpCode(options.secret),
        trust_device: true,
      },
    });
    expect(second.statusCode, second.body).toBe(200);
    const cookie = setCookie(second.headers, COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(cookie).toMatch(/Max-Age=2592000/);
    const token = String(cookie)
      .split(';')[0]!
      .slice(COOKIE.length + 1);
    return { token };
  }

  async function liveTrustedDevices(userId: number) {
    return getOperatorDatabase()
      .select()
      .from(trusted_devices)
      .where(and(eq(trusted_devices.user_id, userId), isNull(trusted_devices.revoked_at)));
  }

  it('AC-13.8: a trusted browser skips the 2FA code; the session has no proved second factor', async () => {
    const { user, secret } = await personWithTwoFactor();
    const { token } = await signInAndTrust({ email: user.email, secret });

    const [row] = await liveTrustedDevices(user.id);
    expect(row?.public_id).toMatch(/^tdv_[a-z0-9]{21}$/);
    expect(row?.token_hash).not.toBe(token);
    expect(row!.expires_at.getTime() - row!.created_at.getTime()).toBeGreaterThan(29 * 86_400_000);

    const skipped = await signIn(user.email, token);
    expect(skipped.statusCode, skipped.body).toBe(200);
    const data = (skipped.json() as { data: { access_token?: string; mfa_required?: boolean } })
      .data;
    expect(data.mfa_required).toBeUndefined();
    expect(data.access_token).toBeTypeOf('string');

    const [used] = await liveTrustedDevices(user.id);
    expect(used?.last_used_at).not.toBeNull();
    expect(used?.expires_at.getTime()).toBe(row?.expires_at.getTime());

    const newest = await getOperatorDatabase()
      .select({ mfa_verified_at: sessions.mfa_verified_at })
      .from(sessions)
      .where(eq(sessions.user_id, user.id))
      .orderBy(sessions.created_at);
    expect(newest.at(-1)?.mfa_verified_at).toBeNull();

    const audits = await getOperatorDatabase()
      .select({ action: audit_outbox.action })
      .from(audit_outbox)
      .where(eq(audit_outbox.action, 'auth.trusted_device.create'));
    expect(audits).toHaveLength(1);
  });

  it('AC-13.8: a member of an organization that requires 2FA is still asked', async () => {
    await seedPermissions(Object.values(TENANCY_PERMISSIONS));
    const { user, secret } = await personWithTwoFactor();
    const { token } = await signInAndTrust({ email: user.email, secret });

    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    await getOperatorDatabase()
      .insert(organization_settings)
      .values({
        organization_id: organization.id,
        security_policy: { mfa_required: true },
        default_locale: 'en',
      });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [TENANCY_PERMISSIONS.MEMBERSHIP_READ],
    });
    await createMembership({ userId: user.id, organizationId: organization.id, roleId: role.id });

    const asked = await signIn(user.email, token);
    expect(asked.statusCode, asked.body).toBe(200);
    expect((asked.json() as { data: { mfa_required?: boolean } }).data.mfa_required).toBe(true);
  });

  it('a super_admin is always asked, even on a trusted browser', async () => {
    const adminEmail = (process.env.GLOBAL_ADMIN_EMAILS ?? '').split(',')[0]?.trim() ?? '';
    expect(adminEmail, 'the harness sets GLOBAL_ADMIN_EMAILS').not.toBe('');
    const { user } = await personWithTwoFactor({ email: adminEmail });
    const trusted = await trustedDeviceService.trustDevice({ owner: user, userAgent: 'vitest' });

    const asked = await signIn(user.email, trusted.token);
    expect((asked.json() as { data: { mfa_required?: boolean } }).data.mfa_required).toBe(true);
  });

  it("another person's cookie, an expired row and garbage do nothing", async () => {
    const { user } = await personWithTwoFactor();
    const other = await createTestUser({ isEmailVerified: true });
    const stolen = await trustedDeviceService.trustDevice({ owner: other, userAgent: 'vitest' });
    const expired = await trustedDeviceService.trustDevice({ owner: user, userAgent: 'vitest' });
    await getOperatorDatabase()
      .update(trusted_devices)
      .set({
        created_at: new Date(Date.now() - 40 * 86_400_000),
        expires_at: new Date(Date.now() - 86_400_000),
      })
      .where(eq(trusted_devices.public_id, expired.public_id));

    for (const cookie of [stolen.token, expired.token, 'not-a-trusted-device']) {
      const asked = await signIn(user.email, cookie);
      expect((asked.json() as { data: { mfa_required?: boolean } }).data.mfa_required).toBe(true);
    }
  });

  it('AC-13.9: an 11th trusted device ends the oldest', async () => {
    const user = await createTestUser({ isEmailVerified: true });
    const created: string[] = [];
    for (let index = 0; index <= TRUSTED_DEVICES_MAX; index += 1) {
      const trusted = await trustedDeviceService.trustDevice({ owner: user, userAgent: 'vitest' });
      created.push(trusted.public_id);
      if (index === TRUSTED_DEVICES_MAX) expect(trusted.revoked_public_ids).toEqual([created[0]]);
    }
    const live = await liveTrustedDevices(user.id);
    expect(live).toHaveLength(TRUSTED_DEVICES_MAX);
    expect(live.map((row) => row.public_id)).not.toContain(created[0]);
  });

  it('AC-13.9: removing the last 2FA factor ends every trusted device and clears the cookie', async () => {
    const { user, token, secret } = await personWithTwoFactor();
    const trusted = await signInAndTrust({ email: user.email, secret });
    await trustedDeviceService.trustDevice({ owner: user, userAgent: 'vitest' });
    const list = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/auth/me/mfa'),
      token,
    });
    const [method] = (list.json() as { data: { id: string }[] }).data;

    const removed = await injectAuthenticated(app, {
      method: 'DELETE',
      url: testApiPath(`/auth/me/mfa/${method!.id}`),
      token,
      headers: { cookie: `${COOKIE}=${trusted.token}` },
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expect(setCookie(removed.headers, COOKIE)).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect(await liveTrustedDevices(user.id)).toHaveLength(0);
    const audits = await getOperatorDatabase()
      .select({ metadata: audit_outbox.metadata })
      .from(audit_outbox)
      .where(eq(audit_outbox.action, 'auth.trusted_device.revoke'));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({ reason: 'mfa_off' });
  });

  it('AC-13.9: "sign out everywhere else" ends every trusted device but this browser\'s', async () => {
    const { user, token, sessionPublicId } = await personWithTwoFactor();
    const thisBrowser = await trustedDeviceService.trustDevice({ owner: user, userAgent: 'here' });
    const elsewhere = await trustedDeviceService.trustDevice({ owner: user, userAgent: 'there' });
    await seedRecentStepUpForTestUser(user.public_id, sessionPublicId, 'mfa');

    const response = await injectAuthenticated(app, {
      method: 'DELETE',
      url: testApiPath('/auth/me/sessions'),
      token,
      headers: { cookie: `${COOKIE}=${thisBrowser.token}` },
    });
    expect(response.statusCode, response.body).toBe(204);
    const live = await liveTrustedDevices(user.id);
    expect(live.map((row) => row.public_id)).toEqual([thisBrowser.public_id]);
    expect(live.map((row) => row.public_id)).not.toContain(elsewhere.public_id);
  });

  it('an account deleted or suspended ends every trusted device (the revoke-all path)', async () => {
    const user = await createTestUser({ isEmailVerified: true });
    await trustedDeviceService.trustDevice({ owner: user, userAgent: 'vitest' });
    await app.authDomain.authSessionService.revokeAllSessions(user.public_id);
    expect(await liveTrustedDevices(user.id)).toHaveLength(0);
  });

  it('AC-13.10: a wrong code answers the tries left; over the limit it is locked with its wait', async () => {
    const { user } = await personWithTwoFactor();

    async function mfaLoginWith(code: string) {
      const first = await signIn(user.email);
      const { mfa_session_token: mfaSessionToken } = (
        first.json() as { data: { mfa_session_token: string } }
      ).data;
      return injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/mfa/login'),
        payload: { mfa_session_token: mfaSessionToken, totp_code: code },
      });
    }

    const wrong = await mfaLoginWith('000000');
    expect(wrong.statusCode, wrong.body).toBe(401);
    expect(errorOf(wrong)).toMatchObject({ reason: 'mfa_code_wrong', tries_left: 9 });

    // Spend the rest of the 15-minute budget without nine more sign-ins.
    await redisConnection.set(`mfa:verify:fail:login:${user.public_id}`, '10', 'EX', 900);
    const locked = await mfaLoginWith('000000');
    expect(locked.statusCode, locked.body).toBe(429);
    const lockedError = errorOf(locked);
    expect(lockedError?.reason).toBe('mfa_locked');
    expect(lockedError?.retry_after_seconds).toBeGreaterThan(0);
    expect(lockedError?.retry_after_seconds).toBeLessThanOrEqual(900);
  });

  it('an unknown 2FA session token answers 401 mfa_session_invalid', async () => {
    const response = await injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/mfa/login'),
      payload: { mfa_session_token: 'forged-or-expired-token', totp_code: '123456' },
    });
    expect(response.statusCode).toBe(401);
    expect(errorOf(response)?.reason).toBe('mfa_session_invalid');
  });
});
