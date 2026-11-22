/**
 * Live registry of the route URLs whose raw HTTP body is kept for a provider's signature check —
 * one entry per webhook receiver (the Stripe receiver's `stripe-signature`, the Instagram
 * receiver's `x-hub-signature-256`), each with the header that carries its signature (WH2).
 *
 * @remarks
 * sec-B finding #7: the content-type parser in `src/app.ts` once checked a hardcoded set of webhook
 * paths, which had to stay in lockstep with the route files or every signature check silently
 * failed. Now one app-level `onRoute` hook (in `src/app.ts`) fills this registry from each route's
 * own config (`captureRawBody: true` + `rawBodySignatureHeader`), and the parser reads it on every
 * request by the route that matched (`request.routeOptions.url`) — a webhook URL is authored once,
 * in its route declaration. The registry replaced the Stripe-only one so both receivers share it
 * (root `CLAUDE.md` › Reuse before you create).
 */
const signatureHeaderByRouteUrl = new Map<string, string>();

/** One registered raw-body route: its URL (prefix applied) and its signature header (lower case). */
export interface RawBodyRoute {
  url: string;
  signatureHeader: string;
}

/**
 * Records a raw-body route — called by the app-level `onRoute` hook for every route declared with
 * `config.captureRawBody === true`. The URL is already prefix-applied by Fastify; the header is
 * stored lower case (Node lower-cases incoming header names).
 *
 * @remarks
 * Registering the same URL again with the same header is a no-op; with another header it throws —
 * one URL is one receiver, and a second header would silently change which requests keep their raw
 * body.
 */
export function registerRawBodyRoute({ url, signatureHeader }: RawBodyRoute): void {
  const normalizedHeader = signatureHeader.toLowerCase();
  const registeredHeader = signatureHeaderByRouteUrl.get(url);
  if (registeredHeader !== undefined && registeredHeader !== normalizedHeader) {
    throw new Error(
      `raw-body route ${url} is already registered with the signature header ${registeredHeader}`,
    );
  }
  signatureHeaderByRouteUrl.set(url, normalizedHeader);
}

/**
 * The signature header of a registered raw-body route, or `undefined` for any other URL — the
 * content-type parser never parses a body on a registered route, and keeps its raw bytes only when
 * the request carries that header, so the signature is checked before anything is parsed (WH2,
 * D53). Matching is exact: a near-miss URL (trailing slash, another prefix, other case) is not a
 * raw-body route — the parser asks with the matched route's own URL, not the one the caller sent.
 */
export function findRawBodySignatureHeader(url: string): string | undefined {
  return signatureHeaderByRouteUrl.get(url);
}

/** A snapshot of every registered raw-body route — for tests and the boot-time sanity log only. */
export function listRawBodyRoutes(): readonly RawBodyRoute[] {
  return Array.from(signatureHeaderByRouteUrl, ([url, signatureHeader]) => ({
    url,
    signatureHeader,
  }));
}
