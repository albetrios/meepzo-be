import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import type { InstagramAccountSettingsService } from './instagram-account-settings.service.js';
import { createInstagramAccountSettingsController } from './instagram-account-settings.controller.js';
import { UpdateInstagramAccountSettingsDto } from './instagram-account-settings.dto.js';

/**
 * Returns the Fastify plugin that registers the Instagram account settings route (routes-final
 * § 1.B), mounted under `/api/v1/app`: change the settings (route 3) at
 * `/social/instagram/account/settings`. The account is one per organization, so the path carries
 * no id.
 *
 * @remarks
 * Gate `instagram-account:manage` (1.B.4). No `X-Idempotency-Key` required (K3 — only the
 * signed-in POSTs require one; a repeated PATCH sets the same values). The organization-scoped
 * rate limit, as every organization settings write carries.
 */
export function instagramAccountSettingsRoutes(
  service: InstagramAccountSettingsService,
): FastifyPluginAsync {
  const controller = createInstagramAccountSettingsController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.patch(
      '/social/instagram/account/settings',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.INSTAGRAM_ACCOUNT_MANAGE)],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Change the Instagram account settings',
          description:
            "Changes the connected Instagram account's settings: the automation switch (is_automation_enabled) and the public reply safety — is_public_reply_safety_enabled, public_reply_chance_percent (0–100), public_reply_hour_limit (1–1000), public_reply_gap_min_seconds and public_reply_gap_max_seconds (5–3600 seconds each). Send at least one setting, whole numbers only; the others keep their saved values. The minimum gap may not be above the maximum once the change is merged with the saved settings (400 on public_reply_gap_max_seconds). An optional expected_updated_at (the settings' updated_at as read) refuses a save based on older settings with 409 record_changed. Works while the account is expired or error, so automation can be turned off before a reconnect. Records who changed it and answers the settings as saved. 404 instagram_not_connected when no account is connected. Team organizations only. Requires INSTAGRAM_ACCOUNT_MANAGE permission.",
          tags: ['Instagram account'],
          body: UpdateInstagramAccountSettingsDto,
        },
      },
      controller.updateInstagramAccountSettings,
    );
  };
}
