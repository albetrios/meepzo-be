import { randomUUID } from 'node:crypto';
import nock from 'nock';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { encryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';
import { channel_connections } from '@/domains/app/sub-domains/channel-connection/channel-connection.schema.js';
import { channel_connection_tokens } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.schema.js';
import { META_REQUIRED_PERMISSIONS } from '@/domains/app/sub-domains/channel-connection/channel-connection.constants.js';
import {
  META_GRAPH_BASE_URL,
  META_GRAPH_VERSION,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import {
  type InjectHttpResult,
  injectAuthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

/** `GET /app/social/channel-connections` (route 4). */
export const CHANNEL_CONNECTIONS_PATH = testApiPath('/app/social/channel-connections');

/** `POST …/{provider}/start` (route 1). */
export function channelConnectStartPath(provider = 'meta'): string {
  return `${CHANNEL_CONNECTIONS_PATH}/${provider}/start`;
}

/** `POST …/{provider}/callback` (route 2). */
export function channelConnectCallbackPath(provider = 'meta'): string {
  return `${CHANNEL_CONNECTIONS_PATH}/${provider}/callback`;
}

/** `GET` / `DELETE …/{channel_connection_id}` (routes 42, 5). */
export function channelConnectionPath(channelConnectionPublicId: string): string {
  return `${CHANNEL_CONNECTIONS_PATH}/${channelConnectionPublicId}`;
}

/** `POST …/{channel_connection_id}/accounts` (route 3). */
export function channelAccountPickPath(channelConnectionPublicId: string): string {
  return `${channelConnectionPath(channelConnectionPublicId)}/accounts`;
}

/** `POST …/{channel_connection_id}/reconnect` (route 40). */
export function channelReconnectPath(channelConnectionPublicId: string): string {
  return `${channelConnectionPath(channelConnectionPublicId)}/reconnect`;
}

/** `GET …/{channel_connection_id}/ad-accounts` (route 41). */
export function channelAdAccountsPath(channelConnectionPublicId: string): string {
  return `${channelConnectionPath(channelConnectionPublicId)}/ad-accounts`;
}

/** `GET …/{channel_connection_id}/ads` (route 15) with its query. */
export function channelAdsPath({
  channelConnectionPublicId,
  query,
}: {
  channelConnectionPublicId: string;
  query?: Readonly<Record<string, string>>;
}): string {
  const search = new URLSearchParams(query ?? {}).toString();
  return `${channelConnectionPath(channelConnectionPublicId)}/ads${search === '' ? '' : `?${search}`}`;
}

/** The plain token every mocked code exchange issues — it must never reach a response. */
export const TEST_META_SYSTEM_USER_TOKEN = 'EAAG-test-system-user-token-never-returned';

let businessSequence = 0;

/** A fresh digit-only business id (unique per call). */
export function nextClientBusinessId(): string {
  businessSequence += 1;
  return `5${`${Date.now()}${businessSequence}`.slice(-12).padStart(12, '0')}`;
}

/** One Instagram account a mocked business assigns: its id and username. */
export interface TestAssignedAccount {
  id: string;
  username: string;
}

/**
 * Mocks the callback's Meta calls with nock: the code exchange, `client_business_id`, the assigned
 * Instagram accounts and the granted permissions.
 */
export function mockMetaLogin({
  clientBusinessId,
  assignedAccounts,
  grantedPermissions = [...META_REQUIRED_PERMISSIONS],
  exchange = 'success',
  expiresInSeconds,
}: {
  clientBusinessId: string;
  assignedAccounts: readonly TestAssignedAccount[];
  grantedPermissions?: readonly string[];
  exchange?: 'success' | 'refused' | 'outage';
  /** The exchange's `expires_in` — absent for a configuration whose token never ends (P355). */
  expiresInSeconds?: number;
}): nock.Scope {
  const graph = nock(META_GRAPH_BASE_URL)
    .get(`/${META_GRAPH_VERSION}/oauth/access_token`)
    .query(true);
  if (exchange === 'refused') {
    return graph.reply(400, {
      error: { message: 'Invalid verification code format.', type: 'OAuthException', code: 100 },
    });
  }
  if (exchange === 'outage') {
    return graph.reply(500, { error: { message: 'An unexpected error has occurred.', code: 2 } });
  }
  return graph
    .reply(200, {
      access_token: TEST_META_SYSTEM_USER_TOKEN,
      token_type: 'bearer',
      ...(expiresInSeconds === undefined ? {} : { expires_in: expiresInSeconds }),
    })
    .get(`/${META_GRAPH_VERSION}/me`)
    .query(true)
    .reply(200, { client_business_id: clientBusinessId, id: '10001' })
    .get(`/${META_GRAPH_VERSION}/me/assigned_instagram_accounts`)
    .query(true)
    .reply(200, { data: assignedAccounts })
    .get(`/${META_GRAPH_VERSION}/me/permissions`)
    .query(true)
    .reply(200, {
      data: grantedPermissions.map((permission) => ({ permission, status: 'granted' })),
    });
}

/**
 * Mocks a pick's Meta calls: the assigned accounts again, one profile read per picked account, and
 * — only when `subscription` asks for it — `subscribed_apps` per picked account. Since ROUTE row R40
 * the pick itself calls no `subscribed_apps` (the set-up is an `instagram-account-setup` task), so the
 * default is `none`.
 */
export function mockMetaPick({
  assignedAccounts,
  pickedAccounts,
  subscription = 'none',
  profileDelayMilliseconds = 0,
}: {
  assignedAccounts: readonly TestAssignedAccount[];
  pickedAccounts: readonly TestAssignedAccount[];
  subscription?: 'success' | 'failure' | 'none';
  /** Holds each profile read this long — two racing picks both pass their checks first. */
  profileDelayMilliseconds?: number;
}): nock.Scope {
  const graph = nock(META_GRAPH_BASE_URL)
    .get(`/${META_GRAPH_VERSION}/me/assigned_instagram_accounts`)
    .query(true)
    .reply(200, { data: assignedAccounts });
  for (const account of pickedAccounts) {
    graph
      .get(`/${META_GRAPH_VERSION}/${account.id}`)
      .query(true)
      .delay(profileDelayMilliseconds)
      .reply(200, {
        id: account.id,
        username: account.username,
        name: 'Handmade Shop',
        profile_picture_url: 'https://scontent.cdninstagram.com/v/test-profile.jpg',
        followers_count: 1204,
        follows_count: 87,
        media_count: 54,
      });
  }
  for (const account of pickedAccounts) {
    if (subscription === 'none') break;
    const call = graph.post(`/${META_GRAPH_VERSION}/${account.id}/subscribed_apps`).query(true);
    if (subscription === 'success') call.reply(200, { success: true });
    else
      call.reply(400, {
        error: { message: 'Unsupported request', type: 'OAuthException', code: 100 },
      });
  }
  return graph;
}

/** A JSON answer's `data` (the routes' `{ data, meta }`). */
function readData(response: InjectHttpResult): Record<string, unknown> {
  return (response.json() as { data: Record<string, unknown> }).data;
}

/** The state of a login address answered by route 1 or 40. */
export function readStateFromLoginUrl(loginUrl: string): string {
  const state = new URL(loginUrl).searchParams.get('state');
  if (state === null) throw new Error('login address carries no state');
  return state;
}

/**
 * Connects Instagram accounts the way the frontend does — start (route 1), callback (route 2), pick
 * (route 3) — with Meta mocked. Returns the connection's public id and the picked account ids.
 */
export async function connectInstagramAccountsThroughRoutes({
  app,
  token,
  accounts,
  clientBusinessId = nextClientBusinessId(),
  subscription = 'none',
  grantedPermissions,
}: {
  app: FastifyInstance;
  token: string;
  accounts: readonly TestAssignedAccount[];
  clientBusinessId?: string;
  subscription?: 'success' | 'failure' | 'none';
  /** The permissions Meta grants the login (default: the three required ones, no `ads_read`). */
  grantedPermissions?: readonly string[];
}): Promise<{
  channelConnectionPublicId: string;
  clientBusinessId: string;
  pick: Record<string, unknown>;
}> {
  const start = await injectAuthenticated(app, {
    method: 'POST',
    url: channelConnectStartPath(),
    token,
  });
  if (start.statusCode !== 200)
    throw new Error(`start answered ${start.statusCode}: ${start.body}`);
  const state = readStateFromLoginUrl(readData(start).login_url as string);
  mockMetaLogin({
    clientBusinessId,
    assignedAccounts: accounts,
    ...(grantedPermissions === undefined ? {} : { grantedPermissions }),
  });
  const callback = await injectAuthenticated(app, {
    method: 'POST',
    url: channelConnectCallbackPath(),
    token,
    payload: { code: `AQB-${randomUUID()}#_`, state },
    headers: { 'x-idempotency-key': `channel-connect:${state}` },
  });
  if (callback.statusCode !== 200) {
    throw new Error(`callback answered ${callback.statusCode}: ${callback.body}`);
  }
  const channelConnectionPublicId = (readData(callback).channel_connection as { id: string }).id;
  mockMetaPick({ assignedAccounts: accounts, pickedAccounts: accounts, subscription });
  const pick = await injectAuthenticated(app, {
    method: 'POST',
    url: channelAccountPickPath(channelConnectionPublicId),
    token,
    payload: { channel: 'instagram', provider_account_ids: accounts.map((account) => account.id) },
    headers: { 'x-idempotency-key': `pick-${randomUUID()}` },
  });
  if (pick.statusCode !== 200) throw new Error(`pick answered ${pick.statusCode}: ${pick.body}`);
  return { channelConnectionPublicId, clientBusinessId, pick: readData(pick) };
}

/**
 * Inserts a connected Meta connection with an encrypted token through the operator, as a callback
 * leaves it — for tests that seed accounts directly. Returns its internal and public ids.
 */
export async function insertChannelConnection({
  organizationId,
  status = 'connected',
  scopes = [...META_REQUIRED_PERMISSIONS],
  plainToken = TEST_META_SYSTEM_USER_TOKEN,
  clientBusinessId = nextClientBusinessId(),
}: {
  organizationId: number;
  status?: 'connected' | 'error' | 'revoked';
  scopes?: readonly string[];
  plainToken?: string | null;
  clientBusinessId?: string;
}): Promise<{ id: number; public_id: string }> {
  const database = getOperatorDatabase();
  const [connection] = await database
    .insert(channel_connections)
    .values({
      public_id: generatePublicId('channelConnection'),
      organization_id: organizationId,
      client_business_id: clientBusinessId,
      config_id: '1234567890',
      status,
      scopes: [...scopes],
      disconnected_at: status === 'revoked' ? new Date() : null,
    })
    .returning({ id: channel_connections.id, public_id: channel_connections.public_id });
  if (connection === undefined)
    throw new Error('channel connection fixture insert returned no row');
  if (plainToken !== null) {
    await database.insert(channel_connection_tokens).values({
      organization_id: organizationId,
      channel_connection_id: connection.id,
      encrypted_access_token: encryptFieldSecret(plainToken),
    });
  }
  return connection;
}

/** An organization's connection rows — read as the operator. */
export async function readChannelConnectionRows(organizationId: number) {
  return getOperatorDatabase()
    .select()
    .from(channel_connections)
    .where(eq(channel_connections.organization_id, organizationId))
    .orderBy(channel_connections.id);
}

/** The token rows' ends (`expires_at`) of the organization's connections — operator (P355). */
export async function readChannelConnectionTokenExpiries(organizationId: number) {
  const rows = await getOperatorDatabase()
    .select({ expiresAt: channel_connection_tokens.expires_at })
    .from(channel_connection_tokens)
    .where(eq(channel_connection_tokens.organization_id, organizationId));
  return rows.map((row) => row.expiresAt);
}

/** The token ciphertexts of one connection (or every connection of the organization) — operator. */
export async function readChannelConnectionTokenCiphertexts({
  organizationId,
  channelConnectionId,
}: {
  organizationId: number;
  channelConnectionId?: number;
}): Promise<string[]> {
  const rows = await getOperatorDatabase()
    .select({ ciphertext: channel_connection_tokens.encrypted_access_token })
    .from(channel_connection_tokens)
    .where(
      and(
        eq(channel_connection_tokens.organization_id, organizationId),
        channelConnectionId === undefined
          ? undefined
          : eq(channel_connection_tokens.channel_connection_id, channelConnectionId),
      ),
    );
  return rows.map((row) => row.ciphertext);
}
