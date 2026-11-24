import 'fastify';
import type { TFunction } from 'i18next';
import type { AppContainer } from '@/domains/app/app.container.js';
import type { AuditContainer } from '@/domains/audit/audit.container.js';
import type { AuthContainer } from '@/domains/auth/auth.container.js';
import type { BillingContainer } from '@/domains/billing/billing.container.js';
import type { NotifyContainer } from '@/domains/notify/notify.container.js';
import type { TenancyContainer } from '@/domains/tenancy/tenancy.container.js';
import type { UploadContainer } from '@/domains/upload/upload.container.js';
import type { UserContainer } from '@/domains/user/user.container.js';
import type { AuthContext } from '@/shared/types/index.js';
import type { PrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { MetaSignedRequestPayload } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-signature.js';
import type { FailedAuthenticationRateLimit } from '@/shared/middlewares/rate-limit/failed-authentication-rate-limit.js';
import type { FastifyReply } from 'fastify';
import type Stripe from 'stripe';

declare module 'fastify' {
  interface FastifyContextConfig {
    idempotencyRequired?: boolean;
    /**
     * sec-B finding #7: routes set this flag to request that the global
     * content-type parser capture the raw body buffer onto `request.rawBody`
     * for HMAC signature verification, and leave the body unparsed — the route's ingress
     * plugin parses the raw bytes once their signature passed (D53). The app-level `onRoute`
     * hook in `src/app.ts` reads it (with {@link FastifyContextConfig.rawBodySignatureHeader})
     * and fills the raw-body route registry the parser reads at request time (WH2).
     */
    captureRawBody?: boolean;
    /**
     * The header that carries the provider's signature on a `captureRawBody` route
     * (`stripe-signature`, `x-hub-signature-256`): the raw body is kept only when the
     * request carries it. Required whenever `captureRawBody` is set — boot fails without it.
     */
    rawBodySignatureHeader?: string;
    /**
     * Opts a route out of the `{ data, meta }` response envelope and of response encryption
     * (`response-format.middleware.ts`, `encryption.middleware.ts`) — a body the caller reads as
     * it is, such as the Instagram webhook's `text/plain` answers.
     */
    raw_response?: boolean;
  }

  interface FastifyRequest {
    auth: AuthContext | null;
    /**
     * The request-minted principal scope — eagerly assigned by the auth
     * middleware after authentication (JWT or API key), carrying whatever
     * verified ids the token holds. Undefined at runtime only on
     * public/unauthenticated routes, which must not read it.
     */
    principalScope: PrincipalDatabaseScope;
    organizationId: string | null;
    rawBody: Buffer | undefined;
    /** Set by stripe webhook ingress plugin after signature verification. */
    stripeWebhookEvent?: Stripe.Event;
    /**
     * Set by the Meta callback ingress plugin (`channel-connection-meta-callback-ingress.plugin.ts`)
     * once Meta's `signed_request` verified — routes 7–8 (IA18).
     */
    metaSignedRequest?: MetaSignedRequestPayload;
    metricsStartTimeNanoseconds?: bigint;
    /** i18n translate function fixed to `language` (set by the i18n middleware on every request). */
    t?: TFunction;
    /** The request's supported language code (`SUPPORTED_LANGUAGES`: "en", "es"). */
    language?: string;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Per-address failed-authentication limiter (`rate-limit.middleware.ts`); absent on minimal
     * harnesses that do not register the rate-limit middleware.
     */
    failedAuthenticationRateLimit?: FailedAuthenticationRateLimit;
    /** Wired by domain `register*Container` functions via `domainContainersPlugin`. */
    userDomain: UserContainer;
    tenancyDomain: TenancyContainer;
    auditDomain: AuditContainer;
    authDomain: AuthContainer;
    billingDomain: BillingContainer;
    notifyDomain: NotifyContainer;
    uploadDomain: UploadContainer;
    appDomain: AppContainer;
  }
}
