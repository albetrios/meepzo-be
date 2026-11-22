import { describe, expect, it } from 'vitest';
import {
  findRawBodySignatureHeader,
  listRawBodyRoutes,
  registerRawBodyRoute,
} from '@/shared/utils/http/raw-body-route.registry.js';

/**
 * The one raw-body registry both webhook receivers share (WH2) — Stripe's and Instagram's HMAC
 * checks cannot work without it. Moved from the Stripe-only registry's test and widened to the
 * signature header each route registers.
 *
 * The map is deliberately process-global (the app-level `onRoute` hook fills it at registration
 * time and the content-type parser in `src/app.ts` reads it per request), so every case uses a
 * unique sentinel URL and asserts membership rather than exact equality — a suite that also builds
 * the app sees the real webhook URLs in the same registry.
 */
describe('raw-body-route.registry', () => {
  it('returns the signature header of a registered URL', () => {
    const url = '/api/v1/billing/webhook-registry-positive';
    registerRawBodyRoute({ url, signatureHeader: 'stripe-signature' });

    expect(findRawBodySignatureHeader(url)).toBe('stripe-signature');
  });

  it('keeps each receiver on its own header', () => {
    const stripeUrl = '/api/v1/billing/webhook-registry-stripe';
    const instagramUrl = '/api/v1/app/social/instagram/webhook-registry-instagram';
    registerRawBodyRoute({ url: stripeUrl, signatureHeader: 'stripe-signature' });
    registerRawBodyRoute({ url: instagramUrl, signatureHeader: 'x-hub-signature-256' });

    expect(findRawBodySignatureHeader(stripeUrl)).toBe('stripe-signature');
    expect(findRawBodySignatureHeader(instagramUrl)).toBe('x-hub-signature-256');
  });

  it('stores the header lower case, as Node delivers incoming header names', () => {
    const url = '/api/v1/app/social/instagram/webhook-registry-case';
    registerRawBodyRoute({ url, signatureHeader: 'X-Hub-Signature-256' });

    expect(findRawBodySignatureHeader(url)).toBe('x-hub-signature-256');
  });

  it('returns undefined for a URL that was never registered', () => {
    // The whole point of the registry: anything not declared with `config.captureRawBody` must
    // NOT have its body buffered.
    expect(
      findRawBodySignatureHeader('/api/v1/billing/webhook-registry-never-registered'),
    ).toBeUndefined();
  });

  it('listRawBodyRoutes returns the registered URLs with their headers', () => {
    const url = '/api/v1/billing/webhook-registry-listed';
    registerRawBodyRoute({ url, signatureHeader: 'stripe-signature' });

    expect(listRawBodyRoutes()).toContainEqual({ url, signatureHeader: 'stripe-signature' });
  });

  it('registration is idempotent — registering twice yields a single entry', () => {
    const url = '/api/v1/billing/webhook-registry-idempotent';
    registerRawBodyRoute({ url, signatureHeader: 'stripe-signature' });
    registerRawBodyRoute({ url, signatureHeader: 'stripe-signature' });

    const occurrences = listRawBodyRoutes().filter((entry) => entry.url === url).length;
    expect(occurrences).toBe(1);
  });

  it('refuses a second header for a registered URL — one URL is one receiver', () => {
    const url = '/api/v1/billing/webhook-registry-conflict';
    registerRawBodyRoute({ url, signatureHeader: 'stripe-signature' });

    expect(() => registerRawBodyRoute({ url, signatureHeader: 'x-hub-signature-256' })).toThrow(
      /already registered/,
    );
    expect(findRawBodySignatureHeader(url)).toBe('stripe-signature');
  });

  it('does NOT match a near-miss URL (trailing slash, another prefix, other case)', () => {
    // Matching is exact, not prefix / normalizing. A near-miss fails closed: the raw body is not
    // captured, so the signature check rejects rather than verifying re-serialized bytes.
    const url = '/api/v1/billing/webhook-registry-exact';
    registerRawBodyRoute({ url, signatureHeader: 'stripe-signature' });

    expect(findRawBodySignatureHeader(`${url}/`)).toBeUndefined();
    expect(findRawBodySignatureHeader('/billing/webhook-registry-exact')).toBeUndefined();
    expect(findRawBodySignatureHeader(url.toUpperCase())).toBeUndefined();
  });
});
