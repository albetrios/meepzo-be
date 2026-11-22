import nock from 'nock';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { MEMBER_ROLE_NAME } from '@/domains/tenancy/sub-domains/member-roles/member-role.constants.js';
import { provisionOrganizationWithOwner } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import {
  createMembership,
  createRoleWithPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import {
  INSTAGRAM_AUTHORIZATION_BASE_URL,
  INSTAGRAM_GRAPH_API_VERSION,
  INSTAGRAM_GRAPH_BASE_URL,
} from '@/infrastructure/social/instagram.client.js';

/** `POST /app/social/instagram/connect` (route 1). */
export const INSTAGRAM_CONNECT_PATH = testApiPath('/app/social/instagram/connect');
/** `GET` / `DELETE /app/social/instagram/account` (routes 2 and 4). */
export const INSTAGRAM_ACCOUNT_PATH = testApiPath('/app/social/instagram/account');
/** `PATCH /app/social/instagram/account/settings` (route 3). */
export const INSTAGRAM_ACCOUNT_SETTINGS_PATH = testApiPath(
  '/app/social/instagram/account/settings',
);

/** The plain long-lived token every mocked connect issues — it must never reach a response. */
export const TEST_INSTAGRAM_LONG_LIVED_TOKEN = 'IGAA-test-long-lived-token-never-returned';
/** The plain short-lived token every mocked code exchange issues. */
export const TEST_INSTAGRAM_SHORT_LIVED_TOKEN = 'IGAA-test-short-lived-token';
/** About 60 days, as Instagram grants a long-lived token. */
export const TEST_INSTAGRAM_TOKEN_LIFETIME_SECONDS = 5_184_000;
/** The three permissions a connect needs (IA12). */
export const TEST_INSTAGRAM_GRANTED_PERMISSIONS = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
];

/** An Instagram `/me` answer, flat (D33). */
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
    id: `8724${suffix}`,
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
  };
}

/** How the mocked `subscribed_apps` call answers after a connect. */
export type TestSubscriptionOutcome = 'success' | 'failure' | 'none';

/**
 * Mocks a whole connect against Instagram with nock: the code exchange, the long-lived exchange,
 * `/me` and (unless `subscription` is `none`) `subscribed_apps`. Returns the scopes so a test can
 * assert every call was made (`isDone()`).
 */
export function mockInstagramConnect({
  profile,
  grantedPermissions = TEST_INSTAGRAM_GRANTED_PERMISSIONS,
  subscription = 'success',
}: {
  profile: TestInstagramProfile;
  grantedPermissions?: string[];
  subscription?: TestSubscriptionOutcome;
}): nock.Scope[] {
  const codeExchange = nock(INSTAGRAM_AUTHORIZATION_BASE_URL)
    .post('/oauth/access_token')
    .reply(200, {
      data: [
        {
          access_token: TEST_INSTAGRAM_SHORT_LIVED_TOKEN,
          user_id: profile.user_id,
          permissions: grantedPermissions.join(','),
        },
      ],
    });
  const graph = nock(INSTAGRAM_GRAPH_BASE_URL)
    .get('/access_token')
    .query(true)
    .reply(200, {
      access_token: TEST_INSTAGRAM_LONG_LIVED_TOKEN,
      token_type: 'bearer',
      expires_in: TEST_INSTAGRAM_TOKEN_LIFETIME_SECONDS,
    })
    .get(`/${INSTAGRAM_GRAPH_API_VERSION}/me`)
    .query(true)
    .reply(200, profile);
  if (subscription === 'success') {
    graph
      .post(`/${INSTAGRAM_GRAPH_API_VERSION}/${profile.id}/subscribed_apps`)
      .query(true)
      .reply(200, { success: true });
  } else if (subscription === 'failure') {
    graph
      .post(`/${INSTAGRAM_GRAPH_API_VERSION}/${profile.id}/subscribed_apps`)
      .query(true)
      .reply(400, {
        error: { message: 'Unsupported request', type: 'OAuthException', code: 100 },
      });
  }
  return [codeExchange, graph];
}

/** Mocks the disconnect's `DELETE subscribed_apps` for an account's app-scoped id. */
export function mockInstagramUnsubscribe({
  instagramAppUserId,
  outcome = 'success',
}: {
  instagramAppUserId: string;
  outcome?: 'success' | 'failure';
}): nock.Scope {
  const scope = nock(INSTAGRAM_GRAPH_BASE_URL).delete(
    `/${INSTAGRAM_GRAPH_API_VERSION}/${instagramAppUserId}/subscribed_apps`,
  );
  return outcome === 'success'
    ? scope.reply(200, { success: true })
    : scope.reply(500, { error: { message: 'An unexpected error has occurred.', code: 2 } });
}

/** A team organization with its Owner, an Admin and a Member, each with a token. */
export interface InstagramTeamFixture {
  organization: { id: number; public_id: string };
  owner: { id: number; public_id: string };
  ownerToken: string;
  adminToken: string;
  memberToken: string;
  member: { id: number; public_id: string };
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
 * Provisions a TEAM organization the real way (Owner, Admin and the locked Member role with their
 * codes, IA2) and adds an Admin and a Member — the permissions the routes check are the real ones.
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
  const member = await createTestUser();
  await createMembership({
    userId: member.id,
    organizationId: organization.id,
    roleId: await findDefaultRoleId({ organizationId: organization.id, name: MEMBER_ROLE_NAME }),
  });
  const tokenFor = (userPublicId: string) =>
    generateTestToken({ userId: userPublicId, organizationPublicId: organization.public_id });
  return {
    organization,
    owner,
    ownerToken: await tokenFor(owner.public_id),
    adminToken: await tokenFor(admin.public_id),
    memberToken: await tokenFor(member.public_id),
    member,
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
 * Puts a team past its 14-day trial without it ever paying: with `BILLING_READ_ONLY_ENFORCED` on,
 * its plan is read-only (AQ8, D27).
 */
export async function endTrialWithoutPaying(organizationId: number): Promise<void> {
  await operatorQuery`
    UPDATE tenancy.organizations SET created_at = now() - interval '30 days'
    WHERE id = ${organizationId}`;
}

/** The account rows of an organization, read as the operator (any status). */
export async function readInstagramAccountRows(organizationId: number): Promise<
  Array<{
    id: string;
    public_id: string;
    instagram_user_id: string;
    connection_status: string;
    username: string | null;
    disconnected_at: Date | null;
    token_expires_at: Date | null;
    webhook_subscribed_at: Date | null;
  }>
> {
  return operatorQuery`
    SELECT id, public_id, instagram_user_id, connection_status, username, disconnected_at,
           token_expires_at, webhook_subscribed_at
    FROM app.instagram_accounts WHERE organization_id = ${organizationId} ORDER BY id`;
}

/** How many token rows an organization has, and their ciphertexts — read as the operator. */
export async function readInstagramTokenCiphertexts(organizationId: number): Promise<string[]> {
  const rows = await operatorQuery<Array<{ encrypted_access_token: string }>>`
    SELECT encrypted_access_token FROM app.instagram_account_tokens
    WHERE organization_id = ${organizationId}`;
  return rows.map((row) => row.encrypted_access_token);
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
