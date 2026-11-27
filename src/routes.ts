import type { FastifyInstance } from 'fastify';
import { getEnv } from '@/shared/config/env.config.js';
import { registerQueueDashboard } from '@/infrastructure/queue/queue-dashboard.js';
import {
  buildPublicApiPrefix,
  PUBLIC_API_VERSION_SEGMENT_V1,
} from '@/shared/utils/http/api-versioning.util.js';
import { domainContainersPlugin } from '@/domains/domain-containers.plugin.js';
import { auditRoutesPlugin } from '@/domains/audit/audit.routes.js';
import { authRoutesPlugin } from '@/domains/auth/auth.routes.js';
import { userRoutesPlugin } from '@/domains/user/user.routes.js';
import { tenancyRoutesPlugin } from '@/domains/tenancy/tenancy.routes.js';
import { billingRoutesPlugin } from '@/domains/billing/billing.routes.js';
import { notifyRoutesPlugin } from '@/domains/notify/notify.routes.js';
import { uploadRoutesPlugin } from '@/domains/upload/upload.routes.js';
import { appRoutesPlugin } from '@/domains/app/app.routes.js';
import {
  createPlanGuardRouteHook,
  createPlanReadOnlyGuard,
} from '@/domains/billing/sub-domains/entitlement/entitlement-plan-guard.util.js';

/**
 * Central route registration. Domain services are decorated on the Fastify instance
 * via `domainContainersPlugin`; route plugins read `application.*Domain` from containers.
 * Between the two, the one plan-guard route hook (change-plan-gates RG3): every route registered
 * after it that declares `config.planGate` `read_only` runs the entitlement module's read-only
 * guard first in its `preHandler` list.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(domainContainersPlugin);

  app.decorateRequest('entitlementSnapshot', null);
  app.addHook(
    'onRoute',
    createPlanGuardRouteHook({
      guard: createPlanReadOnlyGuard({
        entitlementService: app.billingDomain.entitlementService,
      }),
    }),
  );

  const apiV1 = buildPublicApiPrefix(PUBLIC_API_VERSION_SEGMENT_V1);

  await app.register(auditRoutesPlugin, { prefix: `${apiV1}/audit` });
  await app.register(authRoutesPlugin, { prefix: `${apiV1}/auth` });
  await app.register(userRoutesPlugin, { prefix: `${apiV1}/users` });
  await app.register(tenancyRoutesPlugin, { prefix: `${apiV1}/tenancy` });
  await app.register(billingRoutesPlugin, { prefix: `${apiV1}/billing` });
  await app.register(notifyRoutesPlugin, { prefix: `${apiV1}/notify` });
  await app.register(uploadRoutesPlugin, { prefix: `${apiV1}/uploads` });
  await app.register(appRoutesPlugin, { prefix: `${apiV1}/app` });

  if (getEnv().ENABLE_QUEUE_DASHBOARD) {
    await registerQueueDashboard({ app, deps: { auditService: app.auditDomain.auditService } });
  }
}
