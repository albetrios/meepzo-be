/**
 * Policy: each provider webhook receiver registers its signature-checking ingress plugin before its
 * delivery route, and keeps the raw-body config (`captureRawBody` + its own
 * `rawBodySignatureHeader`, WH2) beside its rate-limit preset — the Stripe receiver
 * (`stripeWebhookIngressPlugin`, `WEBHOOK_RATE_LIMIT`) and the Instagram receiver
 * (`instagramWebhookIngressPlugin`, `INSTAGRAM_WEBHOOK_RATE_LIMIT`, WHC7). Widened from the
 * Stripe-only policy when the raw-body registry became shared. Nothing of a body is parsed before
 * its signature passed: the app's JSON parser leaves a raw-body route's body alone, and each plugin
 * refuses a request without its signature header before the body is read (D53).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = process.cwd();

interface WebhookReceiver {
  name: string;
  routesFile: string;
  pluginFile: string;
  plugin: string;
  /** The context variable the plugin is registered on. */
  pluginTarget: string;
  /** The delivery route's path literal. */
  deliveryPath: string;
  ratePreset: string;
  signatureHeaderConstant: string;
}

const RECEIVERS: readonly WebhookReceiver[] = [
  {
    name: 'Stripe',
    routesFile: 'src/domains/billing/sub-domains/stripe-webhook/stripe-webhook.routes.ts',
    pluginFile: 'src/domains/billing/sub-domains/stripe-webhook/stripe-webhook-ingress.plugin.ts',
    plugin: 'stripeWebhookIngressPlugin',
    pluginTarget: 'app',
    deliveryPath: '/webhook',
    ratePreset: 'WEBHOOK_RATE_LIMIT',
    signatureHeaderConstant: 'STRIPE_SIGNATURE_HEADER',
  },
  {
    name: 'Instagram',
    routesFile: 'src/domains/app/sub-domains/instagram-webhook/instagram-webhook.routes.ts',
    pluginFile: 'src/domains/app/sub-domains/instagram-webhook/instagram-webhook-ingress.plugin.ts',
    plugin: 'instagramWebhookIngressPlugin',
    pluginTarget: 'receiver',
    deliveryPath: '/social/instagram/webhook',
    ratePreset: 'INSTAGRAM_WEBHOOK_RATE_LIMIT',
    signatureHeaderConstant: 'INSTAGRAM_WEBHOOK_SIGNATURE_HEADER',
  },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

describe('Webhook ingress policy', () => {
  it.each(RECEIVERS)('$name registers its ingress plugin before the delivery route', (receiver) => {
    const source = readFileSync(join(PROJECT_ROOT, receiver.routesFile), 'utf8');

    expect(source).toContain(receiver.plugin);
    // Patterns tolerate Biome line-wrapping of `.post(` arguments.
    const ingressIndex = source.search(
      new RegExp(`await\\s+${receiver.plugin}\\s*\\(\\s*${receiver.pluginTarget}`),
    );
    const postIndex = source.search(
      new RegExp(`zodApplication\\.post\\(\\s*['"]${escapeRegExp(receiver.deliveryPath)}['"]`),
    );

    expect(ingressIndex).toBeGreaterThanOrEqual(0);
    expect(postIndex).toBeGreaterThan(ingressIndex);
  });

  it.each(RECEIVERS)('$name keeps the raw-body config beside its rate-limit preset', (receiver) => {
    const source = readFileSync(join(PROJECT_ROOT, receiver.routesFile), 'utf8');

    expect(source).toContain(`...${receiver.ratePreset}.config`);
    expect(source).toContain('captureRawBody: true');
    expect(source).toContain(`rawBodySignatureHeader: ${receiver.signatureHeaderConstant}`);
    expect(source).toContain('bodyLimit: WEBHOOK_INGRESS_BODY_LIMIT_BYTES');
  });

  it.each(RECEIVERS)(
    '$name refuses a request without its signature before its body is read (D53)',
    (receiver) => {
      const source = readFileSync(join(PROJECT_ROOT, receiver.pluginFile), 'utf8');

      expect(source).toContain("addHook('preParsing'");
    },
  );

  it('the JSON parser leaves a raw-body route’s body unparsed, by the matched route (D53)', () => {
    const applicationSource = readFileSync(join(PROJECT_ROOT, 'src/app.ts'), 'utf8');
    const parserSource = applicationSource.slice(
      applicationSource.indexOf("addContentTypeParser('application/json'"),
    );
    const rawBodyBranchIndex = parserSource.indexOf('if (rawBodySignatureHeader !== undefined)');
    const parseIndex = parserSource.indexOf('JSON.parse(');

    expect(rawBodyBranchIndex).toBeGreaterThanOrEqual(0);
    expect(parseIndex).toBeGreaterThan(rawBodyBranchIndex);
    // The matched route, never the raw URL: a percent-encoded path reaches the same route.
    expect(applicationSource).toContain('request.routeOptions.url');
    expect(applicationSource).not.toContain('request.url');
  });

  it('no routes file fills the raw-body registry itself — the app-level onRoute hook does (WH2)', () => {
    for (const receiver of RECEIVERS) {
      const source = readFileSync(join(PROJECT_ROOT, receiver.routesFile), 'utf8');
      expect(source).not.toContain('registerRawBodyRoute');
      expect(source).not.toContain("addHook('onRoute'");
    }
    const applicationSource = readFileSync(join(PROJECT_ROOT, 'src/app.ts'), 'utf8');
    expect(applicationSource).toContain("app.addHook('onRoute', registerRawBodyRouteFromConfig)");
  });
});
