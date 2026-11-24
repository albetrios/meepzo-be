import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import {
  EDITOR_ROLE_NAME,
  VIEWER_ROLE_NAME,
} from '@/domains/tenancy/sub-domains/member-roles/member-role.constants.js';
import { provisionOrganizationWithOwner } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import {
  createMembership,
  createRoleWithPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import {
  META_GRAPH_VERSION,
  META_GRAPH_BASE_URL,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  TEST_META_SYSTEM_USER_TOKEN,
  connectInstagramAccountsThroughRoutes,
  readChannelConnectionTokenCiphertexts,
} from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import { channelAccountPath } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import type { InstagramAccountPickValues } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
/** `PATCH /app/social/instagram/account/settings` (route 3). */
export const INSTAGRAM_ACCOUNT_SETTINGS_PATH = testApiPath(
  '/app/social/instagram/account/settings',
);

/**
 * The plain token every mocked connect issues — the channel connection's system-user token
 * (feat-instagram-dm-sending MC9); it must never reach a response.
 */
export const TEST_INSTAGRAM_LONG_LIVED_TOKEN = TEST_META_SYSTEM_USER_TOKEN;

/**
 * An Instagram professional account's profile as the tests describe it. Under Unified Login the
 * Graph id (`id`) is the Instagram user id (`user_id`) — the pick writes it as both (P111).
 */
export interface TestInstagramProfile {
  user_id: string;
  id: string;
  username: string;
  name: string;
  account_type: string;
  profile_picture_url: string;
  followers_count: number;
  follows_count: number;
  media_count: number;
  biography: string;
  website: string;
}

let instagramIdentifierSequence = 0;

/** A `/me` answer with fresh digit ids (unique per call) and any field overridden. */
export function buildInstagramProfile(
  overrides: Partial<TestInstagramProfile> = {},
): TestInstagramProfile {
  instagramIdentifierSequence += 1;
  const suffix = `${Date.now()}${instagramIdentifierSequence}`.slice(-12).padStart(12, '0');
  return {
    user_id: `1784${suffix}`,
    id: `1784${suffix}`,
    username: `shop.${suffix}`,
    name: 'Handmade Shop',
    account_type: 'BUSINESS',
    profile_picture_url: 'https://scontent.cdninstagram.com/v/test-profile.jpg',
    followers_count: 1204,
    follows_count: 87,
    media_count: 54,
    biography: 'Handmade things, shipped weekly.',
    website: 'https://example.com/shop',
    ...overrides,
    // One id under Unified Login: an override of either sets both.
    ...(overrides.user_id !== undefined ? { id: overrides.user_id } : {}),
    ...(overrides.id !== undefined && overrides.user_id === undefined
      ? { user_id: overrides.id }
      : {}),
  };
}

/** How the mocked `subscribed_apps` call answers after a connect. */
export type TestSubscriptionOutcome = 'success' | 'failure' | 'none';

/** The Channel account object `GET /app/social/channel-accounts/{channel_account_id}` answers (route 7). */
export type TestConnectedInstagramAccount = Record<string, unknown> & {
  id: string;
  connection_status: string;
  instagram: Record<string, unknown> & { instagram_user_id: string };
};

/**
 * Connects one Instagram account for the team the way the frontend does now — start, callback and
 * pick of a channel connection (feat-instagram-dm-sending routes 1–3), Meta mocked with nock — and
 * answers the channel account as route 7 reads it (R5), with the connection's public id. Replaces the launch's
 * Instagram Login connect (RC-6).
 */
export async function connectInstagramAccount({
  app,
  token,
  profile,
  subscription = 'success',
  clientBusinessId,
}: {
  app: FastifyInstance;
  token: string;
  profile: TestInstagramProfile;
  subscription?: TestSubscriptionOutcome;
  clientBusinessId?: string;
}): Promise<{
  account: TestConnectedInstagramAccount;
  channelConnectionPublicId: string;
  /** The account's one id (`cha_…`, P47) — the channel account's, since R6 the Instagram row's too. */
  instagramAccountPublicId: string;
}> {
  const { channelConnectionPublicId, pick } = await connectInstagramAccountsThroughRoutes({
    app,
    token,
    accounts: [{ id: profile.user_id, username: profile.username }],
    subscription,
    ...(clientBusinessId !== undefined ? { clientBusinessId } : {}),
  });
  const picked = (pick as { results: Array<{ channel_account: { id: string } | null }> }).results[0]
    ?.channel_account;
  if (picked == null) throw new Error('the pick connected no account');
  const read = await injectAuthenticated(app, {
    method: 'GET',
    url: channelAccountPath(picked.id),
    token,
  });
  if (read.statusCode !== 200) throw new Error(`account read answered ${read.statusCode}`);
  return {
    account: (read.json() as { data: TestConnectedInstagramAccount }).data,
    channelConnectionPublicId,
    instagramAccountPublicId: picked.id,
  };
}

/** Mocks the disconnect's `DELETE subscribed_apps` for an account's Instagram user id. */
export function mockInstagramUnsubscribe({
  instagramUserId,
  outcome = 'success',
}: {
  instagramUserId: string;
  outcome?: 'success' | 'failure';
}): nock.Scope {
  const scope = nock(META_GRAPH_BASE_URL)
    .delete(`/${META_GRAPH_VERSION}/${instagramUserId}/subscribed_apps`)
    .query(true);
  return outcome === 'success'
    ? scope.reply(200, { success: true })
    : scope.reply(500, { error: { message: 'An unexpected error has occurred.', code: 2 } });
}

/** A team organization with its Owner, an Admin, an Editor and a Viewer, each with a token. */
export interface InstagramTeamFixture {
  organization: { id: number; public_id: string };
  owner: { id: number; public_id: string };
  ownerToken: string;
  adminToken: string;
  editorToken: string;
  editor: { id: number; public_id: string };
  viewerToken: string;
  viewer: { id: number; public_id: string };
}

/** The id of one of an organization's default roles, by name. */
async function findDefaultRoleId({
  organizationId,
  name,
}: {
  organizationId: number;
  name: string;
}): Promise<number> {
  const rows = await operatorQuery<Array<{ id: string }>>`
    SELECT id FROM tenancy.roles
    WHERE organization_id = ${organizationId} AND name = ${name} AND deleted_at IS NULL`;
  const roleId = rows[0]?.id;
  if (roleId === undefined) throw new Error(`no ${name} role in organization ${organizationId}`);
  return Number(roleId);
}

/**
 * Provisions a TEAM organization the real way (Owner and the locked Admin, Editor and Viewer roles
 * with their codes, IA2, feat-instagram-dm-sending TN1) and adds an Admin, an Editor and a Viewer —
 * the permissions the routes check are the real ones.
 * Needs the permission catalog seeded (`seedAllPermissions`).
 */
export async function createInstagramTeam(): Promise<InstagramTeamFixture> {
  const owner = await createTestUser();
  const { organization } = await provisionOrganizationWithOwner({
    name: 'Instagram Team',
    slug: `instagram-team-${generatePublicId('organization').slice(4, 14)}`,
    type: 'TEAM',
    ownerUserId: owner.id,
  });
  const admin = await createTestUser();
  await createMembership({
    userId: admin.id,
    organizationId: organization.id,
    roleId: await findDefaultRoleId({ organizationId: organization.id, name: 'Admin' }),
  });
  const editor = await createTestUser();
  await createMembership({
    userId: editor.id,
    organizationId: organization.id,
    roleId: await findDefaultRoleId({ organizationId: organization.id, name: EDITOR_ROLE_NAME }),
  });
  const viewer = await createTestUser();
  await createMembership({
    userId: viewer.id,
    organizationId: organization.id,
    roleId: await findDefaultRoleId({ organizationId: organization.id, name: VIEWER_ROLE_NAME }),
  });
  const tokenFor = (userPublicId: string) =>
    generateTestToken({ userId: userPublicId, organizationPublicId: organization.public_id });
  return {
    organization,
    owner,
    ownerToken: await tokenFor(owner.public_id),
    adminToken: await tokenFor(admin.public_id),
    editorToken: await tokenFor(editor.public_id),
    editor,
    viewerToken: await tokenFor(viewer.public_id),
    viewer,
  };
}

/**
 * A PERSONAL organization whose caller holds app codes through a custom role — both Instagram
 * account codes unless `permissionCodes` names others (the contact routes pass theirs) — a shape
 * the API never builds (a personal Owner holds none, IA2), made so a test reaches the team-only
 * guard behind the permission gate: `422` on a write, `404 team_organization_required` on a read.
 */
export async function createPersonalOrganizationWithInstagramCodes({
  permissionCodes = [
    APP_PERMISSIONS.INSTAGRAM_ACCOUNT_READ,
    APP_PERMISSIONS.INSTAGRAM_ACCOUNT_MANAGE,
  ],
}: {
  permissionCodes?: readonly string[];
} = {}): Promise<{
  organization: { id: number; public_id: string };
  token: string;
}> {
  const owner = await createTestUser();
  const organization = await createTestOrganization({ ownerUserId: owner.id, type: 'PERSONAL' });
  const role = await createRoleWithPermissions({
    organizationId: organization.id,
    permissionCodes: [...permissionCodes],
  });
  await createMembership({ userId: owner.id, organizationId: organization.id, roleId: role.id });
  const token = await generateTestToken({
    userId: owner.public_id,
    organizationPublicId: organization.public_id,
  });
  return { organization, token };
}

/**
 * Ends a team's paid plan without it paying on (routes-final BL3): a paid plan's subscription,
 * cancelled, whose period ended yesterday — with `BILLING_READ_ONLY_ENFORCED` on, its plan is
 * read-only (AQ8, D27). Free never ends, so only a lapsed or cancelled paid plan gets here.
 */
export async function endPaidPlanWithoutPaying(organizationId: number): Promise<void> {
  const plan = await createTestPlan({ priceMonthly: '29.00', priceYearly: '276.00' });
  const subscription = await createTestSubscription({
    organizationId,
    planId: plan.id,
    status: 'CANCELED',
  });
  await operatorQuery`
    UPDATE billing.subscriptions
    SET current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 day'
    WHERE id = ${subscription.id}`;
}

/**
 * The account rows of an organization, read as the operator (any status): the Instagram extension
 * with its channel account's public id, status and `disconnected_at` (R6 — the extension holds none).
 */
export async function readInstagramAccountRows(organizationId: number): Promise<
  Array<{
    id: string;
    /** `app.channel_accounts.id` — the key of the stored posts (P47, R8). */
    channel_account_id: string;
    public_id: string;
    instagram_user_id: string;
    connection_status: string;
    username: string | null;
    disconnected_at: Date | null;
    webhook_subscribed_at: Date | null;
    profile_erased_at: Date | null;
  }>
> {
  return operatorQuery`
    SELECT i.id, i.channel_account_id, c.public_id, i.instagram_user_id, c.connection_status, i.username,
           c.disconnected_at, i.webhook_subscribed_at, i.profile_erased_at
    FROM app.instagram_accounts AS i
    INNER JOIN app.channel_accounts AS c
      ON c.organization_id = i.organization_id AND c.id = i.channel_account_id
    WHERE i.organization_id = ${organizationId} ORDER BY i.id`;
}

/**
 * The organization's token ciphertexts — its channel connections' (MC9), read as the operator.
 */
export async function readInstagramTokenCiphertexts(organizationId: number): Promise<string[]> {
  return readChannelConnectionTokenCiphertexts({ organizationId });
}

/** The settings rows of an organization — read as the operator. */
export async function readInstagramSettingsRows(
  organizationId: number,
): Promise<Array<{ id: string; instagram_account_id: string; is_automation_enabled: boolean }>> {
  return operatorQuery`
    SELECT id, instagram_account_id, is_automation_enabled
    FROM app.instagram_account_settings WHERE organization_id = ${organizationId} ORDER BY id`;
}

/** The audit outbox rows an organization staged for one action — read as the operator. */
export async function readStagedAuditRows({
  organizationPublicId,
  action,
}: {
  organizationPublicId: string;
  action: string;
}): Promise<Array<{ severity: string; resource_type: string; metadata: Record<string, unknown> }>> {
  return operatorQuery`
    SELECT severity, resource_type, metadata FROM audit.outbox
    WHERE organization_public_id = ${organizationPublicId} AND action = ${action}`;
}

/**
 * The extension values a pick writes (R6, 2.A IA8) with test defaults — for the repository and
 * service tests that seed an Instagram row behind an `insertChannelAccount` fixture.
 */
export function buildInstagramPickValues({
  organizationId,
  channelAccountId,
  instagramUserId,
  ...overrides
}: {
  organizationId: number;
  channelAccountId: number;
  instagramUserId: string;
} & Partial<InstagramAccountPickValues>): InstagramAccountPickValues {
  return {
    organizationId,
    channelAccountId,
    instagramUserId,
    username: `acme_shop_${instagramUserId.slice(-4)}`,
    biography: null,
    website: null,
    profilePictureUrl: null,
    accountType: null,
    isPrivate: false,
    followersCount: 0,
    followsCount: 0,
    mediaCount: 0,
    ...overrides,
  };
}
