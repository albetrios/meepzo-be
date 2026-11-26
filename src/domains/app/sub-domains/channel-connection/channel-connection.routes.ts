import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import type { ChannelConnectionService } from './channel-connection.service.js';
import { createChannelConnectionController } from './channel-connection.controller.js';
import {
  channelAccountPickDto,
  channelConnectCallbackDto,
  channelConnectionIdParamsDto,
  channelConnectionProviderParamsDto,
  channelConnectStartBodyDto,
  listChannelConnectionAdAccountsQueryDto,
  listChannelConnectionAdsQueryDto,
  listChannelConnectionsQueryDto,
} from './channel-connection.dto.js';

/**
 * Returns the Fastify plugin that registers the channel connection routes (routes-final § 1.7),
 * mounted under `/api/v1/app` at `/social/channel-connections/…`: start (1), callback (2),
 * reconnect (40), pick (3), list (4), one (42), "Disconnect business" (5) and the ad picker — the
 * ad accounts (41), then one ad account's ads (15).
 *
 * @remarks
 * Gates (P59): `channel-account:manage` on 1, 2, 3, 5, 40; `channel-account:read` on 4, 15, 41, 42.
 * Routes 1 and 40 take an optional `{ with_page }` body (the Page login configuration, P358).
 * Routes 2
 * and 3 require `X-Idempotency-Key` — merged into their `config`, never a top-level preset spread,
 * which would drop the flag; 1 and 40 take none (a repeat mints another harmless state, MC4). The
 * `{provider}` and `{channel_connection_id}` parameters share the segment after
 * `channel-connections/`; the next segment always tells them apart (MCC10). The route schemas
 * validate the path, query and body first (`400`); the controller's validators then normalize them
 * (the callback code's trailing `#_`, the `{channel_connection_id}` public-id shape).
 */
export function channelConnectionRoutes(service: ChannelConnectionService): FastifyPluginAsync {
  const controller = createChannelConnectionController(service);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.post<{ Params: { provider: string } }>(
      '/social/channel-connections/:provider/start',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CHANNEL_ACCOUNT_MANAGE)],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Start a channel connection',
          description:
            "Starts the provider's login — for meta, Meta's Unified Login for one business portfolio (Instagram now; Facebook Pages and ads later). Mints a one-use state for this person and organization, kept for 10 minutes, and answers the login address (which always asks to log in again) and when the state ends. Optional body { with_page: true } uses the second login configuration (META_PAGE_CONFIG_ID), which also asks for the account's linked Facebook Page and pages_show_list — for an account whose messages webhooks do not arrive because it was shared without its Page; otherwise the default configuration. No X-Idempotency-Key: a repeat mints another state. 400 provider for any provider but meta; 400 instagram_page_login_not_configured when with_page is true and META_PAGE_CONFIG_ID is unset; 503 instagram_not_configured when a META_* setting is unset. Team organizations only. Requires CHANNEL_ACCOUNT_MANAGE permission.",
          tags: ['Channel connection'],
          params: channelConnectionProviderParamsDto,
          body: channelConnectStartBodyDto,
        },
      },
      controller.startChannelConnection,
    );
    zodApplication.post<{ Params: { provider: string } }>(
      '/social/channel-connections/:provider/callback',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CHANNEL_ACCOUNT_MANAGE)],
        config: { idempotencyRequired: true, ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config },
        schema: {
          summary: 'Finish a channel connection',
          description:
            "Finishes the login started by start or reconnect: spends the one-use state (400 channel_connect_state_invalid when it is missing, used, expired, or another person's, organization's or provider's), exchanges the code on the server, reads the business portfolio, its assigned Instagram accounts and the granted permissions, then stores one connection per business — connected, with its permissions and its encrypted token (never returned) — and reconnects every account of this organization the business still assigns (a moved account moves to this connection). Answers the connection, each assigned account marked free, connected here or connected elsewhere, the reconnected accounts and the plan's room. 422 provider_code_invalid when Meta refuses the code; 422 provider_permissions_missing without instagram_basic, instagram_manage_messages or instagram_manage_comments; 409 channel_connection_business_mismatch when a reconnect came back from another business; 409 instagram_connect_restart_required when Meta failed after the code was spent; 503 instagram_unavailable (Retry-After) before. Nothing is saved on a refusal. Team organizations only. Requires X-Idempotency-Key (the frontend sends channel-connect:<state>) and CHANNEL_ACCOUNT_MANAGE permission.",
          tags: ['Channel connection'],
          params: channelConnectionProviderParamsDto,
          body: channelConnectCallbackDto,
        },
      },
      controller.finishChannelConnection,
    );
    zodApplication.post<{ Params: { channel_connection_id: string } }>(
      '/social/channel-connections/:channel_connection_id/reconnect',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CHANNEL_ACCOUNT_MANAGE)],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Start a reconnect of a channel connection',
          description:
            "Starts a login bound to this connection — the connections screen's Reconnect: the same one-use state and login address as start; the callback then refuses a login into another business. Allowed on a connected connection (to grant more permissions, e.g. ads_read, or to share the linked Facebook Page) or one in error. Optional body { with_page: true } uses the second login configuration (META_PAGE_CONFIG_ID), which also asks for the linked Facebook Page and pages_show_list — the reconnect an account flagged is_messages_webhook_missing needs. No X-Idempotency-Key. 400 instagram_page_login_not_configured when with_page is true and META_PAGE_CONFIG_ID is unset; 404 channel_connection_not_found when it is not this organization's or is revoked. Team organizations only. Requires CHANNEL_ACCOUNT_MANAGE permission.",
          tags: ['Channel connection'],
          params: channelConnectionIdParamsDto,
          body: channelConnectStartBodyDto,
        },
      },
      controller.startChannelReconnect,
    );
    zodApplication.post<{ Params: { channel_connection_id: string } }>(
      '/social/channel-connections/:channel_connection_id/accounts',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CHANNEL_ACCOUNT_MANAGE)],
        config: { idempotencyRequired: true, ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config },
        schema: {
          summary: 'Connect picked channel accounts',
          description:
            "Connects the picked accounts of this connection under the plan's account limit: re-reads the business's assigned accounts from Meta, then, under the organization's lock, counts its accounts that are not revoked — over the plan's channel_accounts_max is 409 plan_account_limit and nothing is saved. Each pick becomes a connected account with default settings (a revoked account of this organization comes back with its settings); a pick not assigned any more is not_assigned, one live in another organization connected_elsewhere and one live here already_connected — the others still connect. After the commit each new account is subscribed to its webhook events (a failure leaves it connected and shown as not subscribed). Answers one result per pick and the plan's room. 409 channel_connection_not_connected when the connection is in error or revoked; 503 instagram_unavailable (Retry-After) when Meta is down. Team organizations only. Requires X-Idempotency-Key and CHANNEL_ACCOUNT_MANAGE permission.",
          tags: ['Channel connection'],
          params: channelConnectionIdParamsDto,
          body: channelAccountPickDto,
        },
      },
      controller.pickChannelAccounts,
    );
    zodApplication.get(
      '/social/channel-connections',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CHANNEL_ACCOUNT_READ)],
        schema: {
          summary: 'List channel connections',
          description:
            "Returns the organization's channel connections for the connections screen — provider, business id, status, granted permissions, whether ads can be read, who connected and when, the last daily check and its error codes (never Meta's text) — each with its accounts that are not revoked. Revoked connections only with include_revoked=true. Never a token. No paging. Team organizations only (404 team_organization_required). Requires CHANNEL_ACCOUNT_READ permission.",
          tags: ['Channel connection'],
          querystring: listChannelConnectionsQueryDto,
        },
      },
      controller.listChannelConnections,
    );
    zodApplication.get<{ Params: { channel_connection_id: string } }>(
      '/social/channel-connections/:channel_connection_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CHANNEL_ACCOUNT_READ)],
        schema: {
          summary: 'Get a channel connection',
          description:
            "Returns one channel connection as the list shows it, a revoked one included. Never the token. 404 channel_connection_not_found when it is not this organization's. Team organizations only (404 team_organization_required). Requires CHANNEL_ACCOUNT_READ permission.",
          tags: ['Channel connection'],
          params: channelConnectionIdParamsDto,
        },
      },
      controller.getChannelConnection,
    );
    zodApplication.get<{ Params: { channel_connection_id: string } }>(
      '/social/channel-connections/:channel_connection_id/ad-accounts',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CHANNEL_ACCOUNT_READ)],
        schema: {
          summary: "List a channel connection's ad accounts",
          description:
            "Returns the ad accounts the connection's login reaches, for the ad picker — ad account id, name and Meta's account status — read live from Meta (its first 100, no paging), never stored. The ads are then read one ad account at a time. Without the optional ads_read permission the list is empty and meta.ad_access is missing (the screen offers Connect an ad account, a new login); with it, meta.ad_access is granted. 404 channel_connection_not_found when it is not this organization's; 404 instagram_reconnect_required when the connection is not connected, or Meta refuses its token (the connection and its accounts then move to error, each account with one reconnect notice); 503 instagram_unavailable (with Retry-After) when Meta is down or throttling. Team organizations only (404 team_organization_required). Requires CHANNEL_ACCOUNT_READ permission.",
          tags: ['Channel connection'],
          params: channelConnectionIdParamsDto,
          querystring: listChannelConnectionAdAccountsQueryDto,
        },
      },
      controller.listChannelConnectionAdAccounts,
    );
    zodApplication.get<{ Params: { channel_connection_id: string } }>(
      '/social/channel-connections/:channel_connection_id/ads',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CHANNEL_ACCOUNT_READ)],
        schema: {
          summary: "List one ad account's ads",
          description:
            "Returns one page of the ads of one of the connection's ad accounts (ad_account_id required, from the ad accounts list), for ad-comment and ad Send message automations — ad id, name, status, the Instagram post it runs (instagram_media_id, or null), the organization's channel account it runs as (channel_account_id, or null), thumbnail and Meta's creation time — read live from Meta, never stored. Paging is Meta's own cursor: limit 1–50 (default 25), after = the previous page's meta.pagination.next; no total. Without the optional ads_read permission the page is empty and meta.ad_access is missing. 404 ad_account_not_found when ad_account_id is not one of the connection's; 404 channel_connection_not_found; 404 instagram_reconnect_required when the connection is not connected, or Meta refuses its token (the connection and its accounts then move to error); 503 instagram_unavailable (with Retry-After). Team organizations only (404 team_organization_required). Requires CHANNEL_ACCOUNT_READ permission.",
          tags: ['Channel connection'],
          params: channelConnectionIdParamsDto,
          querystring: listChannelConnectionAdsQueryDto,
        },
      },
      controller.listChannelConnectionAds,
    );
    zodApplication.delete<{ Params: { channel_connection_id: string } }>(
      '/social/channel-connections/:channel_connection_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(APP_PERMISSIONS.CHANNEL_ACCOUNT_MANAGE)],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Disconnect a business',
          description:
            "Disconnect business: unsubscribes each of the connection's accounts from its webhook events (best effort), then revokes every account, revokes the connection and erases its token in one commit. Automations, contacts and history stay. 404 channel_connection_not_found when it is not this organization's or already revoked. Team organizations only. Requires CHANNEL_ACCOUNT_MANAGE permission.",
          tags: ['Channel connection'],
          params: channelConnectionIdParamsDto,
        },
      },
      controller.disconnectChannelConnection,
    );
  };
}
