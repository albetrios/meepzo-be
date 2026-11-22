import Fastify, { type FastifyRequest } from 'fastify';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { env, getEnv } from '@/shared/config/env.config.js';
import { registerMiddleware } from '@/shared/middlewares/index.js';
import { registerMethodStatusPolicy } from '@/shared/middlewares/core/method-status-policy.middleware.js';
import { registerEventHandlers } from '@/core/events/register-event-handlers.js';
import { registerRoutes } from '@/routes.js';
import { buildFastifyServerOptions } from '@/shared/utils/http/fastify-server.util.js';
import {
  findRawBodySignatureHeader,
  registerRawBodyRoute,
} from '@/shared/utils/http/raw-body-route.registry.js';
import { API_SERVER_NAME } from '@/shared/constants/project-identity.constants.js';

const API_SERVER_VERSION = '1.0.0';

/**
 * The signature header of the raw-body route (a webhook receiver) this request matched —
 * `stripe-signature`, `x-hub-signature-256` — or `undefined` on any other route (WH2).
 *
 * @remarks
 * sec-B finding #7: the prior implementation used a hardcoded `RAW_BODY_CAPTURE_PATHS` set of
 * webhook URLs, which had to stay in lockstep with the route files by string equality — any
 * restructure silently broke every webhook signature verification for the provider's retry window.
 * The URLs now come from `raw-body-route.registry.ts`, which the app-level `onRoute` hook below
 * fills from each route's own config, so they are authored once, in the route declaration. The
 * lookup is by the route Fastify matched, never by the URL as sent (D53): a percent-encoded path
 * reaches the same route, and read as another URL its body would be parsed before the signature.
 */
function findMatchedRawBodySignatureHeader(request: FastifyRequest): string | undefined {
  const routeUrl = request.routeOptions.url;
  return routeUrl === undefined ? undefined : findRawBodySignatureHeader(routeUrl);
}

/**
 * Records every route declared with `config.captureRawBody` in the raw-body registry, with its
 * `config.rawBodySignatureHeader` — the one place the registry is filled, for every receiver (WH2).
 * A raw-body route without its signature header fails at boot, never at the first delivery.
 */
function registerRawBodyRouteFromConfig(routeOptions: { url: string; config?: unknown }): void {
  const config = routeOptions.config as
    | { captureRawBody?: boolean; rawBodySignatureHeader?: string }
    | undefined;
  if (config?.captureRawBody !== true) return;
  if (!config.rawBodySignatureHeader) {
    throw new Error(
      `route ${routeOptions.url} sets captureRawBody without its rawBodySignatureHeader`,
    );
  }
  registerRawBodyRoute({
    url: routeOptions.url,
    signatureHeader: config.rawBodySignatureHeader,
  });
}

/**
 * Shape captured by `BuildAppOptions.captureRegisteredRoutes` — one entry per
 * HTTP method / URL pair registered with Fastify.
 */
export type RegisteredRouteCapture = {
  method: string;
  url: string;
};

/**
 * One routed response reported to {@link BuildAppOptions.observeResponses}:
 * the HTTP method, the registered route pattern (e.g. `/api/v1/users/:user_id`),
 * and the final response status code. `requestBody` / `responseBody` are only
 * populated when {@link BuildAppOptions.captureBodies} is set (JSON payloads
 * only — streams and hijacked replies are skipped).
 */
export type ObservedRouteResponse = {
  method: string;
  routeUrl: string;
  statusCode: number;
  requestBody?: unknown;
  responseBody?: string;
};

/**
 * Optional knobs for {@link buildApp} consumed by tests. Production callers
 * (`src/index.ts`, the worker entry) pass nothing.
 */
export type BuildAppOptions = {
  /** When set, every registered HTTP route is appended (used by route parity tests). */
  captureRegisteredRoutes?: RegisteredRouteCapture[];
  /**
   * When set, every routed response is reported after it is sent (used by the
   * route success-status coverage gate). Registered before middleware and
   * routes so all encapsulated contexts inherit the hook.
   */
  observeResponses?: (observation: ObservedRouteResponse) => void;
  /**
   * Also report request/response bodies to {@link observeResponses} (used by
   * the OpenAPI example-capture run; see `pnpm routes:examples`).
   */
  captureBodies?: boolean;
};

/**
 * Builds a fully wired Fastify app: middleware, raw-body capture for webhook
 * signature verification, in-process event handlers, all routes, and (when
 * enabled) the Scalar API reference and MCP server. Returns the unstarted app
 * instance — the caller is responsible for `listen()` so tests can use
 * `app.inject()` without binding a port.
 */
export async function buildApp(options?: BuildAppOptions) {
  const app = Fastify(buildFastifyServerOptions());

  if (options?.captureRegisteredRoutes) {
    const captures = options.captureRegisteredRoutes;
    app.addHook('onRoute', (routeOptions) => {
      const methods = Array.isArray(routeOptions.method)
        ? routeOptions.method
        : [routeOptions.method];
      for (const method of methods) {
        if (method === 'HEAD') continue;
        captures.push({ method: method.toUpperCase(), url: routeOptions.url });
      }
    });
  }

  if (options?.observeResponses) {
    const observeResponses = options.observeResponses;
    const captureBodies = options.captureBodies === true;
    const capturedResponseBody = Symbol('observedResponseBody');

    if (captureBodies) {
      app.addHook('onSend', async (request, _reply, payload) => {
        if (typeof payload === 'string') {
          (request as unknown as Record<symbol, string>)[capturedResponseBody] = payload;
        }
        return payload;
      });
    }

    app.addHook('onResponse', async (request, reply) => {
      const routeUrl = request.routeOptions.url;
      if (!routeUrl) {
        return;
      }
      const responseBody = captureBodies
        ? (request as unknown as Record<symbol, string | undefined>)[capturedResponseBody]
        : undefined;
      observeResponses({
        method: request.method.toUpperCase(),
        routeUrl,
        statusCode: reply.statusCode,
        ...(captureBodies && request.body !== undefined ? { requestBody: request.body } : {}),
        ...(responseBody !== undefined ? { responseBody } : {}),
      });
    });
  }

  registerMethodStatusPolicy(app);

  // WH2: every webhook receiver's raw-body route lands in the one registry the parser reads.
  app.addHook('onRoute', registerRawBodyRouteFromConfig);

  const keepAliveTimeoutMs = env.FASTIFY_KEEP_ALIVE_TIMEOUT_MS ?? 65_000;
  const headersTimeoutMs = env.FASTIFY_HEADERS_TIMEOUT_MS ?? 66_000;
  app.server.keepAliveTimeout = keepAliveTimeoutMs;
  app.server.headersTimeout = headersTimeoutMs;

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const buffer = typeof body === 'string' ? Buffer.from(body) : body;
    // WH2, D53: on a webhook receiver's route the body is never parsed here — anybody can post one,
    // and parsing megabytes of crafted JSON costs far more than checking its signature. The raw
    // bytes are kept for a request that carries the route's own signature header; the receiver's
    // ingress plugin checks the signature over them and only then parses them — the Stripe plugin
    // answers 400 for a signed body that is not JSON, the Instagram receiver 200 OK, storing
    // nothing (WH10).
    const rawBodySignatureHeader = findMatchedRawBodySignatureHeader(request);
    if (rawBodySignatureHeader !== undefined) {
      if (request.headers[rawBodySignatureHeader] !== undefined) request.rawBody = buffer;
      done(null, undefined);
      return;
    }
    // sec-r5-runtime: clients (curl, browsers, SDKs) commonly send POST/DELETE
    // requests with `Content-Type: application/json` and no body — e.g.
    // /auth/logout, /me/sessions DELETE, etc. JSON.parse('') throws
    // `SyntaxError: Unexpected end of JSON input`, which Fastify surfaces as
    // a 500 instead of routing the request to its handler. Treat an empty
    // buffer as `undefined` so the route validator (Zod) sees no body and
    // either accepts or rejects per its declared schema.
    const text = buffer.toString();
    if (text.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      const json = JSON.parse(text) as unknown;
      done(null, json);
    } catch {
      // A malformed JSON body is a CLIENT error. Fastify's built-in JSON parser raises
      // FST_ERR_CTP_INVALID_JSON_SYNTAX (statusCode 400); this custom parser (added for raw-body
      // capture) must mirror that. Passing the raw SyntaxError — which carries no `statusCode` —
      // let the error handler mask it as a 500: the wrong status (the contract is 400 on bad
      // input) and a needless 5xx that captures to Sentry and burns the error budget on
      // attacker-controllable input. The 400-tagged error routes through the error handler's
      // `getFastifyClientErrorStatus` path (logged at warn, not captured).
      done(
        Object.assign(new SyntaxError('Invalid JSON body'), {
          statusCode: 400,
          code: 'FST_ERR_CTP_INVALID_JSON_SYNTAX',
        }),
        undefined,
      );
    }
  });

  await registerMiddleware(app);
  registerEventHandlers();
  await registerRoutes(app);

  if (getEnv().ENABLE_API_REFERENCE) {
    const { registerScalarApiReference } = await import(
      '@/infrastructure/api-reference/scalar-api-reference.js'
    );
    await registerScalarApiReference(app);
  }

  if (getEnv().ENABLE_MCP_SERVER) {
    try {
      const { registerMcpRoute } = await import('@/infrastructure/mcp/mcp-server.js');
      await registerMcpRoute({
        app,
        options: {
          name: API_SERVER_NAME,
          version: API_SERVER_VERSION,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to load MCP server module');
      throw new Error(
        'ENABLE_MCP_SERVER is true but the MCP server could not be loaded. Install optional dependency @modelcontextprotocol/sdk (e.g. pnpm install without --no-optional, or Docker build-arg INSTALL_MCP_OPTIONAL=true).',
        { cause: error },
      );
    }
  }

  return app;
}
