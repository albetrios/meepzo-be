import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
// The platform's custom roles are switched off in this product (feat-instagram-dm-sending TN3); this
// suite tests the role and membership rules underneath with the switch on
// (`custom-roles-off.integration.test.ts` covers it off).
vi.mock(
  '@/domains/tenancy/sub-domains/member-roles/member-role.constants.js',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    TENANCY_CUSTOM_ROLES_ENABLED: true,
  }),
);

import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { invalidatePermissions } from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';
import { loadOrganizationPermissionRoutesFromCatalog } from '@/tests/helpers/route-catalog-registry.js';
import type { FastifyInstance } from 'fastify';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { eq } from 'drizzle-orm';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';

// Keep provider responses deterministic: this suite proves permission dispatch,
// while signed webhook/provider transport contracts are exercised separately.
vi.mock('@/infrastructure/payment/stripe.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/infrastructure/payment/stripe.client.js')>();
  return {
    ...actual,
    isStripeConfigured: () => true,
    createStripeCustomer: vi.fn(async () => ({ id: 'cus_permission_matrix' })),
    createStripeSubscription: vi.fn(async () => ({
      id: 'sub_permission_matrix',
      status: 'incomplete',
    })),
  };
});
import {
  PARAM_NAME_TO_ENTITY,
  publicIdPlaceholderFor,
} from '@/shared/utils/identity/public-id.util.js';

const organizationPermissionRoutes = loadOrganizationPermissionRoutesFromCatalog();

/**
 * The codes a route checks: every code its catalog line names (a route that stacks two codes —
 * launch D83 (6) — grants both), and an export also reads the list — `<resource>:read` or the
 * member-wide `organization:read`. Deduplicated, so a route whose catalog code is the companion
 * grants it once.
 */
function grantedPermissionCodes(route: (typeof organizationPermissionRoutes)[number]): string[] {
  const codes = [...route.permissionCodes];
  if (route.permissionCode.endsWith(':export')) {
    codes.push(
      route.permissionCode.replace(/:export$/, ':read'),
      TENANCY_PERMISSIONS.ORGANIZATION_READ,
    );
  }
  return [...new Set(codes)];
}

function placeholderForParamName(paramName: string): string {
  // `{provider}` is a non-entity param whose schema takes `meta` only (feat-instagram-dm-sending MC1).
  if (paramName === 'provider') return 'meta';
  // `{payment_method_id}` is Stripe's card id, a non-entity param (feat-instagram-dm-sending P78).
  if (paramName === 'payment_method_id') return 'pm_placeholder';
  const entity = PARAM_NAME_TO_ENTITY[paramName as keyof typeof PARAM_NAME_TO_ENTITY];
  return entity ? publicIdPlaceholderFor(entity) : 'placeholder';
}

function materializeOrganizationScopedPath(
  route: (typeof organizationPermissionRoutes)[number],
  organizationPublicId: string,
): string {
  const path = route.path
    .replace(':organization_id', organizationPublicId)
    .replace(/:([a-zA-Z_]+)/g, (_, name: string) => placeholderForParamName(name));
  // A membership's or role's DELETE takes a reason query: without it the request answers 400
  // before the permission check this matrix asserts on (an invitation's DELETE takes none).
  if (
    route.method === 'DELETE' &&
    !route.path.endsWith('/invitation') &&
    /\/tenancy\/organization\/(memberships|roles)\//.test(route.path)
  ) {
    return `${path}?reason=mistake`;
  }
  // An automation's DELETE takes the same reason query (launch AU12, AQ6).
  if (route.method === 'DELETE' && route.path.includes('/app/automations/')) {
    return `${path}?reason=mistake`;
  }
  // The ad picker's ads read needs one ad account (feat-instagram-dm-sending route 15, P57).
  if (route.method === 'GET' && route.path.endsWith('/:channel_connection_id/ads')) {
    return `${path}?ad_account_id=1234567890123`;
  }
  // The contact list and the tag list name their channel account (feat-instagram-dm-sending CT2).
  if (route.method === 'GET' && /\/app\/(contacts|contact-tags|segments)$/.test(route.path)) {
    return `${path}?channel_account_id=${publicIdPlaceholderFor('channelAccount')}`;
  }
  return path;
}

/** The contact (R10) and segment (R21) writes of feat-instagram-dm-sending: the smallest body each schema accepts. */
const CONTACT_WRITE_PAYLOADS: Readonly<Record<string, Record<string, unknown>>> = {
  'PATCH /contacts/:contact_id': { note: 'Matrix note' },
  'POST /contacts/bulk-actions': {
    channel_account_id: publicIdPlaceholderFor('channelAccount'),
    action: 'pause_automations',
    contact_ids: [publicIdPlaceholderFor('contact')],
  },
  // The segment writes (feat-instagram-dm-sending R21): a valid one-condition tree.
  'POST /segments': {
    channel_account_id: publicIdPlaceholderFor('channelAccount'),
    name: 'Matrix segment',
    conditions: { op: 'and', items: [{ field: 'details', has: 'email' }] },
  },
  'PATCH /segments/:segment_id': { name: 'Matrix segment renamed' },
  'POST /segments/audience-count': {
    channel_account_id: publicIdPlaceholderFor('channelAccount'),
    conditions: { op: 'and', items: [{ field: 'details', has: 'email' }] },
  },
};

function payloadForPermissionRoute(
  route: (typeof organizationPermissionRoutes)[number],
  planPublicId: string = publicIdPlaceholderFor('plan'),
): Record<string, unknown> | undefined {
  if (route.method === 'GET' || route.method === 'DELETE') return undefined;
  // The tenancy team writes: the smallest body each schema accepts.
  if (route.method === 'POST' && route.path.endsWith('/tenancy/organization/memberships')) {
    return {
      emails: ['matrix-member@example.test'],
      role_ids: [publicIdPlaceholderFor('memberRole')],
    };
  }
  if (route.method === 'PATCH' && route.path.endsWith('/memberships/:membership_id')) {
    return { status: 'active' };
  }
  if (route.path.endsWith('/memberships/:membership_id/invitation/resend')) {
    return { expires_in_days: 7 };
  }
  if (route.path.includes('/subscriptions/:subscription_id/change-plan')) {
    return { plan_id: planPublicId };
  }
  if (route.path.endsWith('/subscriptions')) {
    return { plan_id: planPublicId, billing_cycle: 'monthly' };
  }
  if (route.path.includes('/subscriptions/:subscription_id')) {
    return {};
  }
  if (route.path.endsWith('/api-keys')) {
    return { name: 'Matrix API key', scopes: [route.permissionCode] };
  }
  if (route.path.includes('/api-keys/:api_key_id')) {
    return { name: 'Matrix API key updated' };
  }
  if (route.path.endsWith('/logo')) {
    return { key: 'organization-logos/matrix-logo.png' };
  }
  if (route.path.endsWith('/notification-policies')) {
    // `notification_type` and `channel` must both be valid NOTIFICATION_TYPES / NOTIFICATION_CHANNELS
    // members; an invalid value makes schema validation (400) preempt the permission check (403)
    // this matrix asserts on.
    return { notification_type: 'billing.usage_threshold', channel: 'EMAIL' };
  }
  if (route.path.includes('/notification-policies/:notification_policy_id')) {
    return { default_enabled: false };
  }
  if (route.path.endsWith('/webhooks')) {
    // An event every member may read: `membership.*` / `subscription.*` would also need their read
    // permission, and the matrix grants exactly the route's own.
    return { url: 'https://example.com/webhook', events: ['organization.updated'] };
  }
  if (route.path.includes('/webhooks/:webhook_id')) {
    return { is_enabled: false };
  }
  if (route.path.endsWith('/roles')) {
    return { name: 'Matrix role' };
  }
  if (route.path.includes('/roles/:role_id/permissions')) {
    return { permission_codes: [] };
  }
  if (route.path.includes('/roles/:role_id')) {
    return { name: 'Matrix role updated' };
  }
  const contactPayload =
    CONTACT_WRITE_PAYLOADS[`${route.method} ${route.path.replace(/^.*\/app/, '')}`];
  if (contactPayload !== undefined) return contactPayload;
  if (route.path.endsWith('/app/social/instagram/accounts/:channel_account_id/settings')) {
    // A setting in range, so body validation (400) does not preempt the permission check (403).
    return { is_automation_enabled: false };
  }
  if (route.path.endsWith('/settings')) {
    return { is_email_notifications_enabled: true };
  }
  if (route.path.endsWith('/tenancy/organization')) {
    return { name: 'Matrix organization' };
  }
  if (route.method === 'POST' && route.path.endsWith('/app/automations')) {
    // The smallest complete flow, so body validation (400) does not preempt the permission check.
    return {
      name: 'Matrix automation',
      trigger_type: 'dm',
      keywords: ['price'],
      is_opening_message_enabled: false,
      final_message: { text: 'Thanks' },
    };
  }
  if (route.method === 'PATCH' && route.path.includes('/app/automations/:automation_id')) {
    return { name: 'Matrix automation renamed' };
  }
  if (route.path.endsWith('/app/social/channel-connections/:provider/callback')) {
    // A well-formed code and state, so body validation (400) does not preempt the permission check.
    return { code: 'AQB-permission-matrix-code', state: 'A'.repeat(43) };
  }
  if (route.path.endsWith('/app/social/channel-connections/:channel_connection_id/accounts')) {
    return { channel: 'instagram', provider_account_ids: ['17841400000000001'] };
  }
  return {};
}

function routeNeedsExistingPlan(route: (typeof organizationPermissionRoutes)[number]): boolean {
  return (
    route.path.endsWith('/subscriptions') ||
    route.path.includes('/subscriptions/:subscription_id/change-plan')
  );
}

async function createPermissionMatrixPlan() {
  const plan = await createTestPlan();
  // The authorized half needs a configured billing fixture; missing prices now fail closed.
  await getOperatorDatabase()
    .update(plans)
    .set({
      stripe_price_monthly_id: 'price_permission_matrix',
      stripe_price_yearly_id: 'price_permission_matrix_yearly',
    })
    .where(eq(plans.id, plan.id));
  return plan;
}

function idempotencyHeadersForPermissionRoute(
  route: (typeof organizationPermissionRoutes)[number],
): Record<string, string> | undefined {
  if (route.method === 'GET' || route.method === 'DELETE') return undefined;
  return { 'x-idempotency-key': `permission-matrix-${randomUUID()}` };
}

/**
 * Authorization matrix — every organization-permission route from docs/routes.txt returns 403 without permission.
 */
describe('Security: Permission route matrix', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
    expect(organizationPermissionRoutes.length).toBeGreaterThan(20);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  for (const route of organizationPermissionRoutes) {
    it(`${route.method} ${route.path} returns 403 without ${route.permissionCodes.join(' + ')}`, async () => {
      await seedPermissions(route.permissionCodes);

      const user = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: user.id });
      const role = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [],
        createdByUserId: user.id,
      });
      await createMembership({
        userId: user.id,
        organizationId: organization.id,
        roleId: role.id,
      });
      const token = await generateTestToken({
        userId: user.public_id,
        organizationPublicId: organization.public_id,
      });
      const materializedPath = materializeOrganizationScopedPath(route, organization.public_id);
      const plan = routeNeedsExistingPlan(route) ? await createPermissionMatrixPlan() : undefined;
      const headers = idempotencyHeadersForPermissionRoute(route);
      const payload = payloadForPermissionRoute(route, plan?.public_id);

      const response = await injectAuthenticated(app, {
        method: route.method,
        url: materializedPath,
        token,
        ...(headers ? { headers } : {}),
        ...(payload !== undefined ? { payload } : {}),
      });

      expect(response.statusCode, response.body).toBe(403);
      // Launch D83 (6): the route gate names the cause like the service-level checks do.
      expect((response.json() as { error: { reason?: string } }).error.reason, response.body).toBe(
        'missing_permission',
      );
    });

    it(`${route.method} ${route.path} reaches its documented authorized outcome with ${route.permissionCodes.join(' + ')}`, async () => {
      const grantedCodes = grantedPermissionCodes(route);
      await seedPermissions(grantedCodes);

      const user = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: user.id });
      const role = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: grantedCodes,
        createdByUserId: user.id,
      });
      await createMembership({
        userId: user.id,
        organizationId: organization.id,
        roleId: role.id,
      });
      await invalidatePermissions({
        userId: user.public_id,
        organizationId: organization.public_id,
      });
      // A recent step-up too: some permission routes also sit behind the step-up gate
      // (organization deletion), and the matrix asserts the permission outcome.
      const token = await generateTestToken({
        userId: user.public_id,
        organizationPublicId: organization.public_id,
        stepUp: true,
      });
      const materializedPath = materializeOrganizationScopedPath(route, organization.public_id);
      const plan = routeNeedsExistingPlan(route) ? await createPermissionMatrixPlan() : undefined;
      const headers = idempotencyHeadersForPermissionRoute(route);
      const payload = payloadForPermissionRoute(route, plan?.public_id);

      const response = await injectAuthenticated(app, {
        method: route.method,
        url: materializedPath,
        token,
        ...(headers ? { headers } : {}),
        ...(payload !== undefined ? { payload } : {}),
      });

      expect(response.statusCode, response.body).not.toBe(403);
    });
  }
});
