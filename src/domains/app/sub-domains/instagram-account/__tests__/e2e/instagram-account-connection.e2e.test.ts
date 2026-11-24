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
  INSTAGRAM_ACCOUNT_PATH,
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

  async function disconnect(token: string, profile: TestInstagramProfile) {
    mockInstagramUnsubscribe({ instagramAppUserId: profile.id });
    return injectAuthenticated(app, { method: 'DELETE', url: INSTAGRAM_ACCOUNT_PATH, token });
  }

  function read(token: string) {
    return injectAuthenticated(app, { url: INSTAGRAM_ACCOUNT_PATH, token });
  }

  it('connect → read as an Editor → disconnect → connect another → reconnect the first (its row and settings come back)', async () => {
    const team = await createInstagramTeam();
    const first = buildInstagramProfile();
    const second = buildInstagramProfile();

    const firstAccount = await connect(team.ownerToken, first);
    const [firstSettings] = await readInstagramSettingsRows(team.organization.id);

    const editorRead = await read(team.editorToken);
    expect(editorRead.statusCode).toBe(200);
    expect((editorRead.json() as { data: { id: string } }).data.id).toBe(firstAccount.id);
    const editorDisconnect = await injectAuthenticated(app, {
      method: 'DELETE',
      url: INSTAGRAM_ACCOUNT_PATH,
      token: team.editorToken,
    });
    expect(editorDisconnect.statusCode).toBe(403);

    expect((await disconnect(team.ownerToken, first)).statusCode).toBe(204);
    expect((await read(team.ownerToken)).statusCode).toBe(404);

    // The organization has room for another account (Free: one at a time).
    const otherAccount = await connect(team.ownerToken, second);
    expect(otherAccount.id).not.toBe(firstAccount.id);
    expect((await disconnect(team.ownerToken, second)).statusCode).toBe(204);

    // Reconnecting the first account reuses its revoked row: same public id, same settings.
    const again = await connect(team.ownerToken, first);
    expect(again).toMatchObject({ id: firstAccount.id, connection_status: 'connected' });
    const settings = await readInstagramSettingsRows(team.organization.id);
    expect(settings).toHaveLength(2);
    expect(settings).toContainEqual(firstSettings);
    expect(await readInstagramTokenCiphertexts(team.organization.id)).toHaveLength(1);

    const finalRead = await read(team.ownerToken);
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

    expect((await disconnect(firstTeam.ownerToken, profile)).statusCode).toBe(204);

    const moved = await connect(secondTeam.ownerToken, profile);
    expect(moved.connection_status).toBe('connected');
    expect((await read(firstTeam.ownerToken)).statusCode).toBe(404);
    expect((await read(secondTeam.editorToken)).statusCode).toBe(200);
  });
});
