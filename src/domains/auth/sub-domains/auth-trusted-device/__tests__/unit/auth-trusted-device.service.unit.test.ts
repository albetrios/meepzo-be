import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TRUSTED_DEVICE_DAYS,
  TRUSTED_DEVICE_TOKEN_BYTES,
  TRUSTED_DEVICES_MAX,
} from '@/domains/auth/sub-domains/auth-trusted-device/auth-trusted-device.constants.js';
import type { TrustedDeviceRepository } from '@/domains/auth/sub-domains/auth-trusted-device/auth-trusted-device.repository.js';
import { TrustedDeviceService } from '@/domains/auth/sub-domains/auth-trusted-device/auth-trusted-device.service.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';

const { contextScopes } = vi.hoisted(() => ({ contextScopes: [] as unknown[] }));

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // The unit lane has no Postgres: the unit of work runs the callback directly, its scope recorded.
    withAppDatabaseContext: vi.fn(
      async ({
        scope,
        callback,
      }: {
        scope: unknown;
        callback: (databaseHandle: unknown) => Promise<unknown>;
      }) => {
        contextScopes.push(scope);
        return callback({});
      },
    ),
  };
});

/**
 * The trusted-device service's own decisions (AT17, D56) with its repository faked: the cookie value
 * is random and only its SHA-256 is stored, a new device keeps at most {@link TRUSTED_DEVICES_MAX}
 * live under the per-user lock, an absent cookie is refused without a query, and "sign out everywhere
 * else" keeps only this browser's hash. The SQL is covered by the trusted-device integration test.
 */

const NOW = new Date('2026-11-24T09:00:00.000Z');
const OWNER = { id: 41, public_id: 'usr_a1b2c3d4e5f6g7h8i9j0k' };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function setup() {
  const calls: string[] = [];
  const repository = {
    acquireCreationQuotaLock: vi.fn(async () => {
      calls.push('lock');
    }),
    revokeOldestLiveBeyond: vi.fn(async () => {
      calls.push('revoke-oldest');
      return ['tdv_oldest000000000000000'];
    }),
    create: vi.fn(async (data: { expires_at: Date; user_agent: string | null }) => {
      calls.push('create');
      return { public_id: 'tdv_new00000000000000000', expires_at: data.expires_at };
    }),
    touchLiveByTokenHash: vi.fn(async (): Promise<{ id: number } | null> => null),
    revokeAllForUser: vi.fn(async () => ['tdv_a0000000000000000000', 'tdv_b0000000000000000000']),
  };
  const service = new TrustedDeviceService(repository as unknown as TrustedDeviceRepository);
  return { service, repository, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  contextScopes.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TrustedDeviceService.trustDevice', () => {
  it('returns a random base64url cookie value and stores only its SHA-256', async () => {
    const { service, repository } = setup();

    const result = await service.trustDevice({ owner: OWNER, userAgent: 'Firefox' });

    expect(Buffer.from(result.token, 'base64url')).toHaveLength(TRUSTED_DEVICE_TOKEN_BYTES);
    const stored = repository.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(stored).toMatchObject({ user_id: OWNER.id, user_agent: 'Firefox' });
    expect(stored.token_hash).toBe(sha256(result.token));
    expect(stored.token_hash).not.toBe(result.token);
  });

  it('ends the device the configured number of days after the tick', async () => {
    const { service } = setup();

    const result = await service.trustDevice({ owner: OWNER, userAgent: undefined });

    expect(result.expires_at.getTime()).toBe(
      NOW.getTime() + TRUSTED_DEVICE_DAYS * MILLISECONDS_PER_DAY,
    );
    expect(result.public_id).toBe('tdv_new00000000000000000');
  });

  it('locks first, revokes beyond the cap minus one, then creates — and reports the revoked ids', async () => {
    const { service, repository, calls } = setup();

    const result = await service.trustDevice({ owner: OWNER, userAgent: undefined });

    expect(calls).toEqual(['lock', 'revoke-oldest', 'create']);
    expect(repository.acquireCreationQuotaLock).toHaveBeenCalledWith(OWNER.id);
    expect(repository.revokeOldestLiveBeyond).toHaveBeenCalledWith({
      userId: OWNER.id,
      keepCount: TRUSTED_DEVICES_MAX - 1,
    });
    expect(result.revoked_public_ids).toEqual(['tdv_oldest000000000000000']);
  });

  it('stores a missing user agent as null and truncates a long one to 512 characters', async () => {
    const { service, repository } = setup();

    await service.trustDevice({ owner: OWNER, userAgent: undefined });
    await service.trustDevice({ owner: OWNER, userAgent: 'x'.repeat(600) });

    expect(repository.create.mock.calls[0]?.[0]).toMatchObject({ user_agent: null });
    expect(repository.create.mock.calls[1]?.[0]?.user_agent).toHaveLength(512);
  });

  it('mints a different cookie value on every call', async () => {
    const { service } = setup();

    const first = await service.trustDevice({ owner: OWNER, userAgent: undefined });
    const second = await service.trustDevice({ owner: OWNER, userAgent: undefined });

    expect(first.token).not.toBe(second.token);
  });

  it("runs in the owner's verified user scope", async () => {
    const { service } = setup();

    await service.trustDevice({ owner: OWNER, userAgent: undefined });

    expect(contextScopes).toHaveLength(1);
    expect(JSON.stringify(contextScopes[0])).toContain(OWNER.public_id);
  });
});

describe('TrustedDeviceService.acceptTrustedDevice', () => {
  it.each([undefined, ''])('refuses an absent cookie (%j) without a query', async (token) => {
    const { service, repository } = setup();

    await expect(service.acceptTrustedDevice({ owner: OWNER, token })).resolves.toBe(false);
    expect(repository.touchLiveByTokenHash).not.toHaveBeenCalled();
    expect(contextScopes).toHaveLength(0);
  });

  it('accepts a cookie whose hash matches a live row of the person', async () => {
    const { service, repository } = setup();
    repository.touchLiveByTokenHash.mockResolvedValueOnce({ id: 3 });

    await expect(
      service.acceptTrustedDevice({ owner: OWNER, token: 'cookie-value' }),
    ).resolves.toBe(true);
    expect(repository.touchLiveByTokenHash).toHaveBeenCalledWith({
      userId: OWNER.id,
      tokenHash: sha256('cookie-value'),
    });
  });

  it('refuses a cookie that matches no live row', async () => {
    const { service } = setup();

    await expect(service.acceptTrustedDevice({ owner: OWNER, token: 'unknown' })).resolves.toBe(
      false,
    );
  });
});

describe('TrustedDeviceService.revokeAllForUser', () => {
  it('ends every device of the person when no cookie is kept', async () => {
    const { service, repository } = setup();

    const revoked = await service.revokeAllForUser({ owner: OWNER });

    expect(repository.revokeAllForUser).toHaveBeenCalledWith({ userId: OWNER.id });
    expect(revoked).toEqual(['tdv_a0000000000000000000', 'tdv_b0000000000000000000']);
  });

  it("keeps this browser's device by its hash when a cookie is kept", async () => {
    const { service, repository } = setup();

    await service.revokeAllForUser({ owner: OWNER, keepToken: 'this-browser' });

    expect(repository.revokeAllForUser).toHaveBeenCalledWith({
      userId: OWNER.id,
      exceptTokenHash: sha256('this-browser'),
    });
  });

  it('treats an empty kept cookie as none', async () => {
    const { service, repository } = setup();

    await service.revokeAllForUser({ owner: OWNER, keepToken: '' });

    expect(repository.revokeAllForUser).toHaveBeenCalledWith({ userId: OWNER.id });
  });
});
