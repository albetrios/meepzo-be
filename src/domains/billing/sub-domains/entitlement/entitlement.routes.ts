import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { GLOBAL_ROLES } from '@/shared/constants/index.js';
import { requireRole } from '@/shared/utils/auth/authorization.util.js';
import { MODERATE_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import type { EntitlementService } from './entitlement.service.js';
import { createEntitlementController } from './entitlement.controller.js';
import {
  SetEntitlementOverrideDto,
  entitlementOverrideIdParamsDto,
  listEntitlementOverridesQueryDto,
} from './entitlement.dto.js';

/**
 * Fastify plugin factory for the billing entitlement routes (plan-gating close, P270): the global
 * admin's per-organization plan overrides — list, set, remove — behind `requireRole(SUPER_ADMIN)`.
 * The target organization travels in the query or body (`organization_id`), never as the active
 * organization: the admin is not one of its members.
 */
export function entitlementRoutes(service: EntitlementService): FastifyPluginAsync {
  const controller = createEntitlementController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.get(
      '/entitlement-overrides',
      {
        ...MODERATE_AUTHED_RATE_LIMIT,
        onRequest: [app.authenticate],
        preHandler: [requireRole(GLOBAL_ROLES.SUPER_ADMIN)],
        schema: {
          summary: 'List an organization entitlement overrides (admin)',
          description:
            "Returns one organization's plan overrides (`organization_id` in the query): each key it changes — a plan feature switch (`value` boolean) or a limit (`message_month_limit`, `channel_accounts_max`; `value` integer) — with `expires_at`, `is_active` (false once expired) and the `reason`. Removed overrides are left out. 404 for an unknown organization. Requires the SUPER_ADMIN role.",
          tags: ['Billing'],
          querystring: listEntitlementOverridesQueryDto,
        },
      },
      controller.listOverrides,
    );
    zodApplication.post(
      '/entitlement-overrides',
      {
        ...MODERATE_AUTHED_RATE_LIMIT,
        onRequest: [app.authenticate],
        preHandler: [requireRole(GLOBAL_ROLES.SUPER_ADMIN)],
        schema: {
          summary: 'Set an organization entitlement override (admin)',
          description:
            "Sets one organization's override of one plan key — a feature switch (`value` boolean) or a limit (`message_month_limit` ≥ 0, `channel_accounts_max` 1–100; integer) — until `expires_at` (in the future; absent or null = no end), with a `reason`. Replaces the key's live override in place. The plan entitlement lays it over the plan's features at once (every gate, `GET /billing/entitlements`, `/auth/me/context`); a change the features feel is announced as a plan change, so accounts over a lowered limit stop and freed ones may restart. Audited in the organization's log (`billing.entitlement_override.set`). 400 on a value of the wrong type or out of bounds, a past `expires_at`; 404 for an unknown organization. Requires the SUPER_ADMIN role.",
          tags: ['Billing'],
          body: SetEntitlementOverrideDto,
        },
      },
      controller.setOverride,
    );
    zodApplication.delete<{ Params: { entitlement_override_id: string } }>(
      '/entitlement-overrides/:entitlement_override_id',
      {
        ...MODERATE_AUTHED_RATE_LIMIT,
        onRequest: [app.authenticate],
        preHandler: [requireRole(GLOBAL_ROLES.SUPER_ADMIN)],
        schema: {
          summary: 'Remove an organization entitlement override (admin)',
          description:
            "Removes one override: the organization falls back to its plan's value at once (announced as a plan change when the features move). Audited in the organization's log (`billing.entitlement_override.remove`). 404 entitlement_override_not_found for an unknown or already removed override. Requires the SUPER_ADMIN role.",
          tags: ['Billing'],
          params: entitlementOverrideIdParamsDto,
        },
      },
      controller.removeOverride,
    );
  };
}
