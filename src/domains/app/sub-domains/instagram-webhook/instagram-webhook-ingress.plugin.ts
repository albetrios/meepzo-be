import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  readMetaWebhookSettings,
  verifyMetaWebhookSignature,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-signature.js';
import {
  refuseRateLimitedRequest,
  type StandaloneRateLimit,
} from '@/shared/middlewares/rate-limit/rate-limit-refusal.js';
import { getRequestIdentifier } from '@/shared/utils/http/request.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { INSTAGRAM_WEBHOOK_SIGNATURE_HEADER } from './instagram-webhook.constants.js';
import {
  instagramWebhookNotConfiguredError,
  invalidWebhookSignatureError,
} from './instagram-webhook-error.util.js';

/** The Meta app secret every delivery is signed with, or the 503 without one (WH4, WHC3). */
function readConfiguredAppSecret(): string {
  const appSecret = readMetaWebhookSettings().appSecret;
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

/**
 * Counts one unsigned or wrongly signed delivery against the client address (S9, P97): over
 * `INSTAGRAM_WEBHOOK_UNSIGNED_RATE_LIMIT_OPTIONS`' cap → `429`; otherwise the caller throws
 * its `400`. Without a limiter (a harness without the rate-limit middleware) nothing is counted.
 */
async function countUnsignedDelivery({
  request,
  reply,
  rateLimit,
}: {
  request: FastifyRequest;
  reply: FastifyReply;
  rateLimit: StandaloneRateLimit | undefined;
}): Promise<void> {
  if (rateLimit === undefined) return;
  const state = await rateLimit(request);
  if (!state.isAllowed && state.isExceeded) refuseRateLimitedRequest({ request, reply, state });
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

/** The JSON of a delivery's verified raw bytes, or `undefined` when they are not JSON (WH9). */
function parseVerifiedBody(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Enforces Meta's `X-Hub-Signature-256` check on every route registered after this plugin in its
 * context — the Instagram webhook delivery (route 61, WH4) — and the per-IP cap on unsigned
 * traffic only (S9, P97). Mirrors `stripeWebhookIngressPlugin`.
 *
 * @remarks
 * - **Algorithm:** the Meta app secret (channel-connection's `readMetaWebhookSettings`, WHC3) must
 *   be set. (1) A `preParsing` hook — before the body is read — refuses a request that carries no
 *   signature header (D53), counting it against the client address first. (2) A `preHandler` hook:
 *   the header must be `sha256=` + 64 hex characters and the HMAC-SHA256 of the **raw** body
 *   (`request.rawBody`, kept unparsed through the shared raw-body registry, WH2) with that secret,
 *   compared in constant time (`verifyMetaWebhookSignature`); a failure is counted too. (3) Only
 *   then are the raw bytes parsed, onto `request.body` — `undefined` when they are not JSON (WH9).
 *   A validly signed delivery is never counted, so a burst from Meta is never refused by the cap
 *   (AC-16.6); the route opts out of the global per-IP limiter (`INSTAGRAM_WEBHOOK_RATE_LIMIT`).
 * - **Failure modes:** the secret unset → `503 instagram_webhook_not_configured`; the header
 *   missing, malformed or not the raw body's HMAC — or no raw body to check — →
 *   `400 invalid_webhook_signature` (`response-codes.md` files a failed webhook proof under 400),
 *   or `429` once the address sent more such requests than the cap (1,200 a minute) allows.
 * - **Side effects:** sets `request.body`; one counter increment per refused request (the shared
 *   rate-limit store); one warning log line on a refusal — the request id and which part failed,
 *   never the header, the body or the secret.
 * - **Notes:** nothing is parsed, looked up or stored before the signature passes: the route
 *   declares no `schema.body`, and the app's JSON parser leaves a raw-body route's body alone — a
 *   wrongly signed delivery costs one HMAC, an unsigned one not even the read of its body. The
 *   limiter is the rate-limit middleware's `instagramWebhookUnsignedRateLimit` decorator, so it
 *   shares its Redis store (and its in-process fall-over); without it nothing is counted.
 */
export const instagramWebhookIngressPlugin: FastifyPluginAsync = async (application) => {
  // The rate-limit middleware's limiter (`INSTAGRAM_WEBHOOK_UNSIGNED_RATE_LIMIT_OPTIONS`); a
  // harness without that middleware has none and counts nothing.
  const unsignedRateLimit = application.instagramWebhookUnsignedRateLimit;

  application.addHook('preParsing', async (request, reply, payload) => {
    readConfiguredAppSecret();
    if (readSignatureHeader(request) === null) {
      await countUnsignedDelivery({ request, reply, rateLimit: unsignedRateLimit });
      throw refuseSignature(request);
    }
    return payload;
  });

  application.addHook('preHandler', async (request, reply) => {
    const appSecret = readConfiguredAppSecret();
    const signatureHeader = readSignatureHeader(request);
    const rawBody = request.rawBody;
    if (
      signatureHeader === null ||
      rawBody === undefined ||
      !verifyMetaWebhookSignature({ rawBody, signatureHeader, appSecret })
    ) {
      await countUnsignedDelivery({ request, reply, rateLimit: unsignedRateLimit });
      throw refuseSignature(request);
    }
    request.body = parseVerifiedBody(rawBody);
  });
};
