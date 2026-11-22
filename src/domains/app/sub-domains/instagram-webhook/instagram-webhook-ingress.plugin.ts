import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { verifyMetaWebhookSignature } from '@/infrastructure/social/meta-signature.util.js';
import { getEnv } from '@/shared/config/env.config.js';
import { getRequestIdentifier } from '@/shared/utils/http/request.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { INSTAGRAM_WEBHOOK_SIGNATURE_HEADER } from './instagram-webhook.constants.js';
import {
  instagramWebhookNotConfiguredError,
  invalidWebhookSignatureError,
} from './instagram-webhook-error.util.js';

/** The app secret every delivery is signed with, or the 503 without one (D20, WH8). */
function readConfiguredAppSecret(): string {
  const appSecret = getEnv().INSTAGRAM_APP_SECRET;
  if (!appSecret) {
    throw instagramWebhookNotConfiguredError();
  }
  return appSecret;
}

/** The signature header as sent, or `null` without one. */
function readSignatureHeader(request: FastifyRequest): string | null {
  const signatureHeader = request.headers[INSTAGRAM_WEBHOOK_SIGNATURE_HEADER];
  return typeof signatureHeader === 'string' && signatureHeader.length > 0 ? signatureHeader : null;
}

/** Logs a refused delivery — which part failed, never the header, the body or the secret — as its 400. */
function refuseSignature(request: FastifyRequest): Error {
  logger.warn(
    {
      requestId: getRequestIdentifier(request),
      hasSignatureHeader: readSignatureHeader(request) !== null,
      hasRawBody: request.rawBody !== undefined,
    },
    'instagram.webhook.signature_rejected',
  );
  return invalidWebhookSignatureError();
}

/** The JSON of a delivery's verified raw bytes, or `undefined` when they are not JSON (WH10). */
function parseVerifiedBody(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Enforces Meta's `X-Hub-Signature-256` check on every route registered after this plugin in its
 * context — the Instagram webhook delivery (route 17, WH8). Mirrors `stripeWebhookIngressPlugin`.
 *
 * @remarks
 * - **Algorithm:** the app secret (sub-domain 1's one `INSTAGRAM_APP_SECRET` setting, D20) must be
 *   set. (1) A `preParsing` hook — after the rate limit, before the body is read — refuses a request
 *   that carries no signature header (D53). (2) A `preHandler` hook: the header must be `sha256=` +
 *   64 hex characters and the HMAC-SHA256 of the **raw** body (`request.rawBody`, kept unparsed
 *   through the shared raw-body registry, WH2) with that secret, compared in constant time
 *   (`verifyMetaWebhookSignature`). (3) Only then are the raw bytes parsed, onto `request.body` —
 *   `undefined` when they are not JSON, for the receiver to answer (WH10).
 * - **Failure modes:** the secret unset → `503 instagram_webhook_not_configured`; the header
 *   missing, malformed or not the raw body's HMAC — or no raw body to check — →
 *   `400 invalid_webhook_signature` (`response-codes.md` files a failed webhook proof under 400).
 * - **Side effects:** sets `request.body`; one warning log line on a refusal — the request id and
 *   which part failed, never the header, the body or the secret.
 * - **Notes:** nothing is parsed, looked up or stored before the signature passes: the route
 *   declares no `schema.body`, and the app's JSON parser leaves a raw-body route's body alone — a
 *   wrongly signed delivery costs one HMAC, an unsigned one not even the read of its body.
 */
export const instagramWebhookIngressPlugin: FastifyPluginAsync = async (application) => {
  application.addHook('preParsing', async (request, _reply, payload) => {
    readConfiguredAppSecret();
    if (readSignatureHeader(request) === null) {
      throw refuseSignature(request);
    }
    return payload;
  });

  application.addHook('preHandler', async (request) => {
    const appSecret = readConfiguredAppSecret();
    const signatureHeader = readSignatureHeader(request);
    const rawBody = request.rawBody;
    if (
      signatureHeader === null ||
      rawBody === undefined ||
      !verifyMetaWebhookSignature({ rawBody, signatureHeader, appSecret })
    ) {
      throw refuseSignature(request);
    }
    request.body = parseVerifiedBody(rawBody);
  });
};
