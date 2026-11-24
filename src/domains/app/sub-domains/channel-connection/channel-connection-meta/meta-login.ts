import {
  buildMetaGraphUrl,
  callMetaGraph,
  readAnswerText,
  readMetaAppSettings,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { buildMetaGraphMalformedAnswerError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { encryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';

/** Meta's login dialog (Unified Login, routes-final § 1 MC4). */
export const META_LOGIN_DIALOG_URL = 'https://www.facebook.com/dialog/oauth';

/**
 * The Meta Unified Login address routes 1 and 40 answer (routes-final § 1 MC4, MC17).
 *
 * @remarks
 * - **Algorithm:** `https://www.facebook.com/dialog/oauth?client_id&config_id&redirect_uri
 *   &response_type=code&state&prompt=login` — `prompt=login` always asks her to log in again.
 * - **Failure modes:** any of the four Meta settings unset → 503 `instagram_not_configured`.
 * - **Side effects:** none.
 * - **Notes:** `state` is the one-use value `channel-connection-state.ts` minted; the app secret is
 *   never in the address.
 */
export function buildMetaLoginUrl({ state }: { state: string }): string {
  const { appId, configId, redirectUri } = readMetaAppSettings();
  const url = new URL(META_LOGIN_DIALOG_URL);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('config_id', configId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'login');
  return url.toString();
}

/** The Unified Login token of {@link exchangeMetaLoginCode}, already encrypted (MC9). */
export interface MetaLoginAccessToken {
  /** The business's system-user token, encrypted with `encryptFieldSecret`. */
  encryptedAccessToken: string;
}

/**
 * Exchanges the code Meta sent to `META_REDIRECT_URI` for the connection's token (route 2,
 * routes-final § 1 MC5 step 2).
 *
 * @remarks
 * - **Algorithm:** `GET https://graph.facebook.com/v27.0/oauth/access_token?client_id&client_secret
 *   &redirect_uri&code`; the token comes back encrypted.
 * - **Failure modes:** a setting unset → 503 `instagram_not_configured`; a bad, used or expired code
 *   → `MetaGraphApiError` `refused` (the callback's 422 `provider_code_invalid`); Meta down →
 *   `outage`; an answer without `access_token` → `outage`.
 * - **Side effects:** one Meta call.
 * - **Notes:** the URL carries the app secret and the code, as Meta documents the exchange; any log
 *   or Sentry breadcrumb of it goes through `redactSensitiveUrl` (`client_secret` is redacted), and
 *   the outbound layer never logs a full URL. No `appsecret_proof` — there is no token yet.
 */
export async function exchangeMetaLoginCode({
  code,
  requestId,
}: {
  code: string;
  requestId?: string | undefined;
}): Promise<MetaLoginAccessToken> {
  const { appId, appSecret, redirectUri } = readMetaAppSettings();
  const answer = await callMetaGraph<{ access_token?: unknown }>({
    url: buildMetaGraphUrl({
      path: 'oauth/access_token',
      query: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code },
    }),
    requestId,
  });
  const accessToken = readAnswerText(answer.access_token);
  if (accessToken === null) {
    throw buildMetaGraphMalformedAnswerError({
      operation: 'the Unified Login code exchange',
      missing: 'access_token',
    });
  }
  return { encryptedAccessToken: encryptFieldSecret(accessToken) };
}
