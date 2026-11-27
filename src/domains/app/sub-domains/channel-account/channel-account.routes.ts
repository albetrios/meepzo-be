import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import type { ChannelAccountService } from './channel-account.service.js';
import { createChannelAccountController } from './channel-account.controller.js';
import {
  activateChannelAccountDto,
  channelAccountIdParamsDto,
  emptyChannelAccountBodyDto,
  listChannelAccountsQueryDto,
} from './channel-account.dto.js';
import { PLAN_GATE_OPEN_REASON } from '@/domains/billing/sub-domains/entitlement/entitlement.constants.js';

/**
 * Returns the Fastify plugin that registers the channel account routes (routes-final § 1B.7),
 * mounted under `/api/v1/app` at `/social/channel-accounts/…`: list (6), one (7), disconnect (8),
 * pause (9), resume (10), choose active accounts (11) and what one can do (153, feat-meta-connect-flow).
 *
 * @remarks
 * Gates (P59): `channel-account:read` on 6, 7, 153; `channel-account:manage` on 8–11. Route 11 requires
 * `X-Idempotency-Key` — merged into its `config`, never a top-level preset spread, which would drop
 * the flag; 8–10 take none (a repeat lands in the same state, CA7). The route schemas validate the
 * path, query and body first (`400`); the controller's validators then check the public-id shapes.
 */
export function channelAccountRoutes(service: ChannelAccountService): FastifyPluginAsync {
  const controller = createChannelAccountController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.get(
      '/social/channel-accounts',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CHANNEL_ACCOUNT_READ)],
        schema: {
          summary: 'List channel accounts',
          description:
            "Returns the organization's connected accounts that are not revoked — the account menu — oldest connected first, at most the plan's limit: each with its channel, display name, picture, status, connection, whether it is paused, suspended or in the plan, the automation switch and whether anything stops its sending. Filter with channel (comma-separated: instagram; default every channel). No paging. Reads the database only. 400 channel for an unknown channel. Team organizations only (404 team_organization_required). Requires CHANNEL_ACCOUNT_READ permission.",
          tags: ['Channel account'],
          querystring: listChannelAccountsQueryDto,
        },
      },
      controller.listChannelAccounts,
    );
    zodApplication.get<{ Params: { channel_account_id: string } }>(
      '/social/channel-accounts/:channel_account_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CHANNEL_ACCOUNT_READ)],
        schema: {
          summary: 'Get a channel account',
          description:
            "Returns one account — connected or in error (a reconnect is needed) — with its connection, its pause, suspend and plan stop, the automation switch, the new-account limit's end, and its Instagram part with the settings. Never a token. Reads the database only. 404 channel_account_not_found when it is not this organization's or is revoked. Team organizations only (404 team_organization_required). Requires CHANNEL_ACCOUNT_READ permission.",
          tags: ['Channel account'],
          params: channelAccountIdParamsDto,
        },
      },
      controller.getChannelAccount,
    );
    zodApplication.get<{ Params: { channel_account_id: string } }>(
      '/social/channel-accounts/:channel_account_id/capabilities',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CHANNEL_ACCOUNT_READ)],
        schema: {
          summary: 'List what a channel account can do',
          description:
            "Returns what this account can do and why not: every feature of its channel through the same feature check every feature use runs — is_allowed, else the first refusal (channel_lacks_feature, permission_not_granted with the Meta permission, plan_lacks_feature with the plan switch, feature_not_offered) and its fix (reconnect, upgrade, none) — and the blockers that stop its sending whatever the feature, read from what is stored: connection_error, the lane stop (login_expired, account_not_shared, wrong_permission, access_off, …), the plan stop, messages_webhook_missing, paused — each with since and its fix (reconnect, reconnect_with_page, turn_on_message_access, share_account_in_meta, upgrade, resume, none). scopes_source says whether the account's own Meta permissions or its connection's stand. Reads the database only, never Meta. 404 channel_account_not_found when it is not this organization's or is revoked. Team organizations only (404 team_organization_required). Requires CHANNEL_ACCOUNT_READ permission.",
          tags: ['Channel account'],
          params: channelAccountIdParamsDto,
        },
      },
      controller.listChannelAccountCapabilities,
    );
    zodApplication.delete<{ Params: { channel_account_id: string } }>(
      '/social/channel-accounts/:channel_account_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CHANNEL_ACCOUNT_MANAGE)],
        config: {
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { open: PLAN_GATE_OPEN_REASON.ACCOUNT },
        },
        schema: {
          summary: 'Disconnect a channel account',
          description:
            "Disconnects one account: removes its starter questions and unsubscribes it from its webhook events at Instagram (each best effort), then marks it revoked and stops its sending in one commit. The connection's token is erased only with the connection's last account. Automations stay live, contacts and history stay, and the plan frees one place. 404 channel_account_not_found when it is not this organization's or already revoked. Team organizations only. Requires CHANNEL_ACCOUNT_MANAGE permission.",
          tags: ['Channel account'],
          params: channelAccountIdParamsDto,
        },
      },
      controller.disconnectChannelAccount,
    );
    zodApplication.post<{ Params: { channel_account_id: string } }>(
      '/social/channel-accounts/:channel_account_id/pause',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CHANNEL_ACCOUNT_MANAGE)],
        config: {
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { open: PLAN_GATE_OPEN_REASON.ACCOUNT },
        },
        schema: {
          summary: 'Pause a channel account',
          description:
            "Pauses the account's sending: comments and taps are still saved, nothing is sent. An already paused account answers the same, so no X-Idempotency-Key. An account in error may be paused. Answers the account. 404 channel_account_not_found when it is not this organization's or is revoked. Team organizations only. Requires CHANNEL_ACCOUNT_MANAGE permission.",
          tags: ['Channel account'],
          params: channelAccountIdParamsDto,
          body: emptyChannelAccountBodyDto,
        },
      },
      controller.pauseChannelAccount,
    );
    zodApplication.post<{ Params: { channel_account_id: string } }>(
      '/social/channel-accounts/:channel_account_id/resume',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CHANNEL_ACCOUNT_MANAGE)],
        config: {
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: {
            open: 'lifts the owner pause only — the account is already in the plan (CA9)',
          },
        },
        schema: {
          summary: 'Resume a channel account',
          description:
            "Clears only the owner's pause — a team suspend, a plan stop and the sending error stops stay. A repeat answers the same, so no X-Idempotency-Key. Answers the account. 404 channel_account_not_found when it is not this organization's or is revoked. Team organizations only. Requires CHANNEL_ACCOUNT_MANAGE permission.",
          tags: ['Channel account'],
          params: channelAccountIdParamsDto,
          body: emptyChannelAccountBodyDto,
        },
      },
      controller.resumeChannelAccount,
    );
    zodApplication.post<{ Params: { channel_account_id: string } }>(
      '/social/channel-accounts/:channel_account_id/activate',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CHANNEL_ACCOUNT_MANAGE)],
        config: {
          idempotencyRequired: true,
          ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config,
          planGate: { gates: ['limit:channel_accounts_max'] },
        },
        schema: {
          summary: 'Choose an active channel account',
          description:
            "Makes an account that is not in the plan active again. Under the organization's lock it counts the active accounts; at the plan's channel_accounts_max the body must name stop_channel_account_id — another active account of this organization — which leaves the plan in the same commit. 409 channel_account_already_active when the account is already in the plan; 409 plan_account_limit at the limit with no account named; 400 stop_channel_account_id when the named account is malformed, the same, not active or not this organization's. 404 channel_account_not_found when it is not this organization's or is revoked. Answers the account. Team organizations only. Requires X-Idempotency-Key and CHANNEL_ACCOUNT_MANAGE permission.",
          tags: ['Channel account'],
          params: channelAccountIdParamsDto,
          body: activateChannelAccountDto,
        },
      },
      controller.activateChannelAccount,
    );
  };
}
