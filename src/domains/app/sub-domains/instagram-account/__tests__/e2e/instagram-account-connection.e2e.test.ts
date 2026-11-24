import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instagramCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  injectAuthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  INSTAGRAM_ACCOUNT_PATH,
  INSTAGRAM_CONNECT_PATH,
  buildInstagramProfile,
  createInstagramTeam,
  mockInstagramConnect,
  mockInstagramUnsubscribe,
  readInstagramAccountRows,
  readInstagramSettingsRows,
  readInstagramTokenCiphertexts,
  type TestInstagramProfile,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';

interface ConnectAnswer {
  is_new_connection: boolean;
  instagram_account: { id: string; connection_status: string; instagram_user_id: string };
}

/**
 * The Instagram account's life over HTTP (routes-final § 1.A, IA11–IA14, ROUTE R3): connect, read
 * as an Editor, disconnect, connect another account, reconnect the first — the row, its public id
 * and its settings come back — and one Instagram account moving between two organizations.
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
    await instagramCircuit.reset();
  });

  async function connect(token: string, profile: TestInstagramProfile): Promise<InjectHttpResult> {
    mockInstagramConnect({ profile });
    return injectAuthenticated(app, {
      method: 'POST',
      url: INSTAGRAM_CONNECT_PATH,
      token,
      payload: { code: `AQB-${generatePublicId('instagramAccount')}#_` },
      headers: { 'x-idempotency-key': `ig-e2e-${generatePublicId('instagramAccount')}` },
    });
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

    const connected = await connect(team.ownerToken, first);
    expect(connected.statusCode).toBe(200);
    const firstAnswer = (connected.json() as { data: ConnectAnswer }).data;
    expect(firstAnswer.is_new_connection).toBe(true);
    const [firstSettings] = await readInstagramSettingsRows(team.organization.id);

    const editorRead = await read(team.editorToken);
    expect(editorRead.statusCode).toBe(200);
    expect((editorRead.json() as { data: { id: string } }).data.id).toBe(
      firstAnswer.instagram_account.id,
    );
    const editorDisconnect = await injectAuthenticated(app, {
      method: 'DELETE',
      url: INSTAGRAM_ACCOUNT_PATH,
      token: team.editorToken,
    });
    expect(editorDisconnect.statusCode).toBe(403);

    expect((await disconnect(team.ownerToken, first)).statusCode).toBe(204);
    expect((await read(team.ownerToken)).statusCode).toBe(404);

    // The organization is free for another account (D5).
    const other = await connect(team.ownerToken, second);
    expect(other.statusCode).toBe(200);
    const otherAnswer = (other.json() as { data: ConnectAnswer }).data;
    expect(otherAnswer.is_new_connection).toBe(true);
    expect(otherAnswer.instagram_account.id).not.toBe(firstAnswer.instagram_account.id);
    expect((await disconnect(team.ownerToken, second)).statusCode).toBe(204);

    // Reconnecting the first account reuses its revoked row: same public id, same settings.
    const again = await connect(team.ownerToken, first);
    expect(again.statusCode).toBe(200);
    const againAnswer = (again.json() as { data: ConnectAnswer }).data;
    expect(againAnswer.is_new_connection).toBe(false);
    expect(againAnswer.instagram_account).toMatchObject({
      id: firstAnswer.instagram_account.id,
      connection_status: 'connected',
    });
    const settings = await readInstagramSettingsRows(team.organization.id);
    expect(settings).toHaveLength(2);
    expect(settings).toContainEqual(firstSettings);
    expect(await readInstagramTokenCiphertexts(team.organization.id)).toHaveLength(1);

    const finalRead = await read(team.ownerToken);
    expect(finalRead.statusCode).toBe(200);
    expect((finalRead.json() as { data: { id: string } }).data.id).toBe(
      firstAnswer.instagram_account.id,
    );
    const rows = await readInstagramAccountRows(team.organization.id);
    expect(rows.map((row) => row.connection_status).sort()).toEqual(['connected', 'revoked']);
  });

  it('one Instagram account moves between organizations only once the first disconnects', async () => {
    const firstTeam = await createInstagramTeam();
    const secondTeam = await createInstagramTeam();
    const profile = buildInstagramProfile();

    expect((await connect(firstTeam.ownerToken, profile)).statusCode).toBe(200);

    const refused = await connect(secondTeam.ownerToken, profile);
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: { reason: string } }).error.reason).toBe(
      'instagram_account_connected_elsewhere',
    );

    expect((await disconnect(firstTeam.ownerToken, profile)).statusCode).toBe(204);

    const moved = await connect(secondTeam.ownerToken, profile);
    expect(moved.statusCode).toBe(200);
    // New for the second organization, even though the first had it.
    expect((moved.json() as { data: ConnectAnswer }).data.is_new_connection).toBe(true);
    expect((await read(firstTeam.ownerToken)).statusCode).toBe(404);
    expect((await read(secondTeam.editorToken)).statusCode).toBe(200);
  });
});
