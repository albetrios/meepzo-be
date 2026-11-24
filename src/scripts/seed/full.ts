/**
 * Full seed — runs minimal seed + demo data + common flows (add user to organization, invite).
 * Orchestration only; entity logic lives in domain seeds.
 *
 * Run by `pnpm db:seed:full` (`src/scripts/ops/db-prepare.ts`, seed level `full`), which migrates
 * first and drains the pool after.
 */
import { MEMBERSHIP_STATUS } from '@/domains/tenancy/sub-domains/membership/membership.constants.js';
import { createHash, randomBytes } from 'node:crypto';
import {
  seedPermissions,
  SYSTEM_PERMISSIONS,
} from '@/domains/tenancy/sub-domains/permission/seed/permission.reference.seed.js';
import { seedPlans } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { seedDemoUser, seedUser } from '@/domains/user/seed/user.seed.js';
import {
  seedOrganization,
  seedRole,
  seedMembership,
  seedRolePermissions,
  seedMembershipInvitation,
  findSeededSystemRoleId,
} from '@/domains/tenancy/seed/tenancy.seed.js';
import { reconcileTeamOrganizationDefaultRoles } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { EDITOR_ROLE_NAME } from '@/domains/tenancy/sub-domains/member-roles/member-role.constants.js';
import {
  initFakerSeed,
  generateUserPayload,
  generateOrganizationPayload,
  generateInviteeEmail,
} from './faker-data.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { assertBulkSeedAllowed } from './production-guard.js';

const DEMO_EMAIL = 'demo@example.com';

function getDemoPassword(): string {
  const fromEnv = process.env.DEMO_PASSWORD;
  if (fromEnv && fromEnv.length >= 8) return fromEnv;
  const random = randomBytes(16).toString('base64url');
  const generated = `Demo${random}!`;
  logger.info(
    'seed.full: using generated demo password — set DEMO_PASSWORD in .env for a fixed password',
  );
  return generated;
}
const ADMIN_PERMISSION_CODES = SYSTEM_PERMISSIONS.map((permission) => permission.code);

/**
 * Orchestrator for the full demo seed: applies the minimal seed (permissions,
 * plans, demo user) and then layers on faker-generated organizations,
 * memberships, invitations and role wiring. Refuses a non-local `DATABASE_URL`
 * before any write ({@link assertBulkSeedAllowed}). Idempotent — re-running upserts
 * existing rows. Does not manage the DB connection; `pnpm db:seed:full` drains the pool after it
 * resolves, so a test may call it directly.
 */
export async function runFullSeed(): Promise<void> {
  // Demo users with known or logged passwords and faker organizations: local databases only, as
  // the bulk seed (H-11). `pnpm db:seed` (the reference rows every deploy needs) never gets here.
  assertBulkSeedAllowed(process.env);
  logger.info('seed.full: starting');
  initFakerSeed();

  await seedPermissions();
  logger.info({ count: SYSTEM_PERMISSIONS.length }, 'seed.full: permissions seeded');

  await seedPlans();
  logger.info('seed.full: plans seeded');

  const demoPassword = getDemoPassword();
  const demoUser = await seedDemoUser({ email: DEMO_EMAIL, password: demoPassword });
  if (!demoUser) throw new Error('seed.full: failed to create demo user');
  logger.info({ userId: demoUser.public_id }, 'seed.full: demo user created');

  const demoOrganization = await seedOrganization({
    name: 'Demo Organization',
    slug: 'demo-org',
    owner_user_id: demoUser.id,
  });
  if (!demoOrganization) throw new Error('seed.full: failed to create demo org');
  logger.info(
    { organizationId: demoOrganization.public_id },
    'seed.full: demo organization created',
  );

  const adminRole = await seedRole({
    organization_id: demoOrganization.id,
    name: 'Admin',
    is_system: true,
    created_by_user_id: demoUser.id,
  });
  if (!adminRole) throw new Error('seed.full: failed to create admin role');

  await seedRolePermissions({
    roleId: adminRole.id,
    permissionCodes: ADMIN_PERMISSION_CODES,
    createdByUserId: demoUser.id,
  });
  logger.info('seed.full: admin role permissions assigned');

  await seedMembership({
    user_id: demoUser.id,
    organization_id: demoOrganization.id,
    role_id: adminRole.id,
    status: MEMBERSHIP_STATUS.ACTIVE,
    created_by_user_id: demoUser.id,
  });
  logger.info('seed.full: demo membership created');

  const extraUserPayload = generateUserPayload();
  const extraUser = await seedUser(extraUserPayload);
  if (extraUser) {
    const extraOrgPayload = generateOrganizationPayload();
    const extraOrg = await seedOrganization({
      ...extraOrgPayload,
      owner_user_id: demoUser.id,
    });
    if (extraOrg) {
      // The default team roles (Admin, Editor, Viewer — feat-instagram-dm-sending TN1); custom roles
      // are off (TN3), so the extra user joins as an Editor.
      await reconcileTeamOrganizationDefaultRoles({ organizationPublicId: extraOrg.public_id });
      const editorRoleId = await findSeededSystemRoleId({
        organization_id: extraOrg.id,
        name: EDITOR_ROLE_NAME,
      });
      if (editorRoleId !== null) {
        await seedMembership({
          user_id: extraUser.id,
          organization_id: extraOrg.id,
          role_id: editorRoleId,
          status: MEMBERSHIP_STATUS.ACTIVE,
          created_by_user_id: demoUser.id,
        });
        logger.info('seed.full: extra user added to extra organization (common flow)');
      }
    }
  }

  const inviteeEmail = generateInviteeEmail();
  const inviteeUser = await seedUser({
    email: inviteeEmail,
    first_name: 'Invitee',
    last_name: 'User',
  });
  if (inviteeUser) {
    const invitedMembership = await seedMembership({
      user_id: inviteeUser.id,
      organization_id: demoOrganization.id,
      role_id: adminRole.id,
      status: MEMBERSHIP_STATUS.INVITED,
      created_by_user_id: demoUser.id,
    });
    if (invitedMembership) {
      const tokenHash = createHash('sha256')
        .update(`invite-${inviteeEmail}-${Date.now()}`)
        .digest('hex');
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      await seedMembershipInvitation({
        membership_id: invitedMembership.id,
        email: inviteeEmail,
        token_hash: tokenHash,
        invited_by_user_id: demoUser.id,
        expires_at: expiresAt,
        created_by_user_id: demoUser.id,
      });
      logger.info({ email: inviteeEmail }, 'seed.full: invite created (common flow)');
    }
  }

  logger.info('seed.full: done');
}
