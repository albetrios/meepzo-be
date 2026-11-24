import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { writeSessionPlaceMmdb } from '@/tests/helpers/session-place-mmdb.helper.js';
import { AuthSessionRepository } from '@/domains/auth/sub-domains/auth-session/auth-session.repository.js';
import { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import { sessions } from '@/domains/auth/sub-domains/auth-session/auth-session.schema.js';
import { createSessionPlaceLookup } from '@/domains/auth/sub-domains/auth-session/session-place.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { UserService } from '@/domains/user/user.service.js';

const placeFilePath = writeSessionPlaceMmdb([
  {
    network: '203.0.113.0',
    prefixLength: 24,
    record: { city: { names: { en: 'Mumbai' } }, country: { iso_code: 'IN' } },
  },
  {
    network: '198.51.100.0',
    prefixLength: 24,
    record: { city: { names: { en: 'Berlin' } }, country: { iso_code: 'DE' } },
  },
]);

/** Reads one session row's address and place straight from the table. */
async function readNetwork(sessionPublicId: string) {
  const [row] = await database
    .select({
      ip_address: sessions.ip_address,
      place_city: sessions.place_city,
      place_country: sessions.place_country,
    })
    .from(sessions)
    .where(eq(sessions.public_id, sessionPublicId));
  return row;
}

describe('AuthSessionService — the session place (database, routes-final § 10.D AT18)', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  async function buildService(
    placeLookup = createSessionPlaceLookup({ databasePath: placeFilePath }),
  ) {
    const user = await createTestUser();
    const userService = {
      requireUserRecordByPublicId: async () => user,
    } as unknown as UserService;
    const service = new AuthSessionService(
      userService,
      new AuthSessionRepository(),
      undefined,
      placeLookup,
    );
    return { user, service, placeLookup };
  }

  async function signIn({
    service,
    userPublicId,
    ipAddress,
  }: {
    service: AuthSessionService;
    userPublicId: string;
    ipAddress: string;
  }) {
    return service.createSessionForUser({
      userPublicId,
      data: {
        token_hash: `tok-${generatePublicId('authSession')}`,
        ip_address: ipAddress,
        expires_at: new Date(Date.now() + 86_400_000),
      },
    });
  }

  it('stores the city and country of the sign-in IP on the new session', async () => {
    const { user, service } = await buildService();
    const session = await signIn({
      service,
      userPublicId: user.public_id,
      ipAddress: '203.0.113.7',
    });
    expect(await readNetwork(session.public_id)).toEqual({
      ip_address: '203.0.113.7',
      place_city: 'Mumbai',
      place_country: 'IN',
    });
  });

  it('leaves the place empty without a place file (sign-in still succeeds)', async () => {
    const { user, service } = await buildService(
      createSessionPlaceLookup({ databasePath: undefined }),
    );
    const session = await signIn({
      service,
      userPublicId: user.public_id,
      ipAddress: '203.0.113.7',
    });
    expect(await readNetwork(session.public_id)).toMatchObject({
      place_city: null,
      place_country: null,
    });
  });

  it('moves the address and the place when a refresh comes from a new IP', async () => {
    const { user, service } = await buildService();
    const session = await signIn({
      service,
      userPublicId: user.public_id,
      ipAddress: '203.0.113.7',
    });
    await service.refreshSessionCredentials({
      sessionPublicId: session.public_id,
      userPublicId: user.public_id,
      refreshSecret: session.refresh_secret,
      nextAccessToken: 'next-access-token-one',
      ipAddress: '198.51.100.9',
    });
    expect(await readNetwork(session.public_id)).toEqual({
      ip_address: '198.51.100.9',
      place_city: 'Berlin',
      place_country: 'DE',
    });
  });

  it('keeps the place without a new lookup when a refresh comes from the same IP', async () => {
    const { user, service, placeLookup } = await buildService();
    const session = await signIn({
      service,
      userPublicId: user.public_id,
      ipAddress: '203.0.113.7',
    });
    const findPlace = vi.spyOn(placeLookup, 'findPlace');
    await service.refreshSessionCredentials({
      sessionPublicId: session.public_id,
      userPublicId: user.public_id,
      refreshSecret: session.refresh_secret,
      nextAccessToken: 'next-access-token-two',
      ipAddress: '203.0.113.7',
    });
    expect(findPlace).not.toHaveBeenCalled();
    expect(await readNetwork(session.public_id)).toEqual({
      ip_address: '203.0.113.7',
      place_city: 'Mumbai',
      place_country: 'IN',
    });
  });

  it('refuses a country that is not two upper-case letters (chk_sessions_place_country)', async () => {
    const { user, service } = await buildService();
    const session = await signIn({
      service,
      userPublicId: user.public_id,
      ipAddress: '203.0.113.7',
    });
    await expect(
      database
        .update(sessions)
        .set({ place_country: 'in' })
        .where(eq(sessions.public_id, session.public_id)),
    ).rejects.toThrow();
  });
});
