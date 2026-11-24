import { organizationChannelAccountPath } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { connectInstagramAccountsThroughRoutes } from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import {
  buildInstagramProfile,
  connectInstagramAccount,
  createInstagramTeam,
  mockInstagramUnsubscribe,
  readInstagramAccountRows,
  readInstagramSettingsRows,
  readInstagramTokenCiphertexts,
  type TestInstagramProfile,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';

/**
 * The Instagram account's life over HTTP (routes-final § 1.A, IA11–IA14; connected through a channel
 * connection since feat-instagram-dm-sending R3 — start, callback, pick): connect, read as an
 * Editor, disconnect, connect another account, reconnect the first — the row, its public id and its
 * settings come back — and one Instagram account moving between two organizations.
 */
describe('Instagram account connection flow (e2e)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
  });

  afterEach(async () => {
    nock.cleanAll();
    await metaGraphCircuit.reset();
  });

  async function connect(token: string, profile: TestInstagramProfile) {
    return (await connectInstagramAccount({ app, token, profile })).account;
  }

  /** The organization's account — routes 7 and 8 name it since R5 (CA2). */
  type TeamCaller = { token: string; organizationId: number };

  async function disconnect({ token, organizationId }: TeamCaller, profile: TestInstagramProfile) {
    mockInstagramUnsubscribe({ instagramAppUserId: profile.id });
    return injectAuthenticated(app, {
      method: 'DELETE',
      url: await organizationChannelAccountPath(organizationId),
      token,
    });
  }

  async function read({ token, organizationId }: TeamCaller) {
    return injectAuthenticated(app, {
      url: await organizationChannelAccountPath(organizationId),
      token,
    });
  }

  it('connect → read as an Editor → disconnect → connect another → reconnect the first (its row and settings come back)', async () => {
    const team = await createInstagramTeam();
    const first = buildInstagramProfile();
    const second = buildInstagramProfile();

    const firstAccount = await connect(team.ownerToken, first);
    const [firstSettings] = await readInstagramSettingsRows(team.organization.id);

    const editorRead = await read({
      token: team.editorToken,
      organizationId: team.organization.id,
    });
    expect(editorRead.statusCode).toBe(200);
    expect((editorRead.json() as { data: { id: string } }).data.id).toBe(firstAccount.id);
    const editorDisconnect = await injectAuthenticated(app, {
      method: 'DELETE',
      url: await organizationChannelAccountPath(team.organization.id),
      token: team.editorToken,
    });
    expect(editorDisconnect.statusCode).toBe(403);

    expect(
      (await disconnect({ token: team.ownerToken, organizationId: team.organization.id }, first))
        .statusCode,
    ).toBe(204);
    expect(
      (await read({ token: team.ownerToken, organizationId: team.organization.id })).statusCode,
    ).toBe(404);

    // The organization has room for another account (Free: one at a time).
    const otherAccount = await connect(team.ownerToken, second);
    expect(otherAccount.id).not.toBe(firstAccount.id);
    expect(
      (await disconnect({ token: team.ownerToken, organizationId: team.organization.id }, second))
        .statusCode,
    ).toBe(204);

    // Reconnecting the first account reuses its revoked row: same public id, same settings.
    const again = await connect(team.ownerToken, first);
    expect(again).toMatchObject({ id: firstAccount.id, connection_status: 'connected' });
    const settings = await readInstagramSettingsRows(team.organization.id);
    expect(settings).toHaveLength(2);
    expect(settings).toContainEqual(firstSettings);
    expect(await readInstagramTokenCiphertexts(team.organization.id)).toHaveLength(1);

    const finalRead = await read({ token: team.ownerToken, organizationId: team.organization.id });
    expect(finalRead.statusCode).toBe(200);
    expect((finalRead.json() as { data: { id: string } }).data.id).toBe(firstAccount.id);
    const rows = await readInstagramAccountRows(team.organization.id);
    expect(rows.map((row) => row.connection_status).sort()).toEqual(['connected', 'revoked']);
  });

  it('one Instagram account moves between organizations only once the first disconnects', async () => {
    const firstTeam = await createInstagramTeam();
    const secondTeam = await createInstagramTeam();
    const profile = buildInstagramProfile();

    await connect(firstTeam.ownerToken, profile);

    // The second organization's pick answers connected_elsewhere for it (MC7, AC-1.5).
    const { pick: refused } = await connectInstagramAccountsThroughRoutes({
      app,
      token: secondTeam.ownerToken,
      accounts: [{ id: profile.user_id, username: profile.username }],
      subscription: 'none',
    });
    expect((refused.results as Array<{ result: string }>)[0]?.result).toBe('connected_elsewhere');
    nock.cleanAll();

    expect(
      (
        await disconnect(
          { token: firstTeam.ownerToken, organizationId: firstTeam.organization.id },
          profile,
        )
      ).statusCode,
    ).toBe(204);

    const moved = await connect(secondTeam.ownerToken, profile);
    expect(moved.connection_status).toBe('connected');
    expect(
      (await read({ token: firstTeam.ownerToken, organizationId: firstTeam.organization.id }))
        .statusCode,
    ).toBe(404);
    expect(
      (await read({ token: secondTeam.editorToken, organizationId: secondTeam.organization.id }))
        .statusCode,
    ).toBe(200);
  });
});
