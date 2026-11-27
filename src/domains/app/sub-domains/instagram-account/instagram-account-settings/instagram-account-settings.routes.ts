import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { channelAccountIdParamsDto } from '@/domains/app/sub-domains/channel-account/channel-account.dto.js';
import type { InstagramAccountSettingsService } from './instagram-account-settings.service.js';
import { createInstagramAccountSettingsController } from './instagram-account-settings.controller.js';
import { UpdateInstagramAccountSettingsDto } from './instagram-account-settings.dto.js';

/**
 * Returns the Fastify plugin that registers the Instagram account settings route
 * (feat-instagram-dm-sending routes-final § 2.B), mounted under `/api/v1/app`: change one account's
 * settings (route 12) at `/social/instagram/accounts/{channel_account_id}/settings`.
 *
 * @remarks
 * Gate `instagram-account:manage` (2.B.4). No `X-Idempotency-Key` (2.5 — a repeated PATCH lands in
 * the same state). The organization-scoped rate limit, as every organization settings write carries.
 */
export function instagramAccountSettingsRoutes(
  service: InstagramAccountSettingsService,
): FastifyPluginAsync {
  const controller = createInstagramAccountSettingsController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.patch<{ Params: { channel_account_id: string } }>(
      '/social/instagram/accounts/:channel_account_id/settings',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.INSTAGRAM_ACCOUNT_MANAGE)],
        config: {
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { gates: ['feature:extra_delay', 'feature:mark_seen'] },
        },
        schema: {
          summary: 'Change an Instagram account settings',
          description:
            "Changes one Instagram account's settings: its sending limits — opening_hour_limit (1–700 opening DMs an hour), opening_day_limit (from the hour limit to 24 times it; read only while the day limit is on), fast_hour_limit (1–20,000), person_hour_limit (5–100), broadcast_hour_limit (1–2,000), each null to go back to the default — the automatic-message notice, extra_stop_words (up to 50, each 1–50 characters, stored lower case, no repeats), replies under comments, once per person per post, mark as seen after a reply, the extra delay before each message (extra_delay_seconds_min and _max, 1–20 seconds, both or neither, min not above max) and the account's automation switch (is_automation_enabled). Send at least one field; the others keep their saved values. Turning on the extra delay needs a plan with it (403 plan_lacks_feature); turning on mark as seen while it is not offered yet is refused (422 feature_not_offered); a feature whose permission the connection lacks answers 409 permission_not_granted. An optional expected_updated_at refuses a save based on older settings with 409 record_changed. A limit change gives the account's sending a new turn; the other settings count for new events. Works while the account is in error. Answers the settings with effective_limits — what sending uses now. 404 channel_account_not_found when it is not this organization's Instagram account or is revoked. Team organizations only. Requires INSTAGRAM_ACCOUNT_MANAGE permission.",
          tags: ['Instagram account'],
          params: channelAccountIdParamsDto,
          body: UpdateInstagramAccountSettingsDto,
        },
      },
      controller.updateInstagramAccountSettings,
    );
  };
}
