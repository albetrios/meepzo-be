import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCacheForTests } from '@/shared/config/env.config.js';
import { resetMetricsRegistryForTests } from '@/infrastructure/observability/metrics/metrics-registry.js';

/**
 * `instagram_webhook_unknown_account_entries_total` (routes-final WH4, WQ1): one per Instagram
 * webhook entry whose account no organization holds — the receiver's only trace of events it never
 * stores, beside its log line.
 */
describe('instagram_webhook_unknown_account_entries_total', () => {
  const originalMetricsEnabled = process.env.METRICS_ENABLED;

  beforeEach(() => {
    vi.resetModules();
    resetEnvCacheForTests();
  });

  afterEach(() => {
    vi.resetModules();
    if (originalMetricsEnabled === undefined) {
      delete process.env.METRICS_ENABLED;
    } else {
      process.env.METRICS_ENABLED = originalMetricsEnabled;
    }
    resetEnvCacheForTests();
    resetMetricsRegistryForTests();
  });

  it('counts each unknown-account entry', async () => {
    process.env.METRICS_ENABLED = 'true';
    resetEnvCacheForTests();

    const { getMetricsRegistry } = await import(
      '@/infrastructure/observability/metrics/metrics-registry.js'
    );
    const { ensurePrometheusMetricsRegistered, recordInstagramWebhookUnknownAccountEntry } =
      await import('@/infrastructure/observability/metrics/prometheus-metrics.js');
    const { renderMetrics } = await import('@/infrastructure/observability/metrics/metrics.js');

    ensurePrometheusMetricsRegistered(getMetricsRegistry());
    recordInstagramWebhookUnknownAccountEntry();
    recordInstagramWebhookUnknownAccountEntry();

    expect(await renderMetrics()).toMatch(
      /instagram_webhook_unknown_account_entries_total(\{[^}]*\})? 2/,
    );
  });

  it('is a no-op when metrics are disabled', async () => {
    process.env.METRICS_ENABLED = 'false';
    resetEnvCacheForTests();

    const { recordInstagramWebhookUnknownAccountEntry } = await import(
      '@/infrastructure/observability/metrics/prometheus-metrics.js'
    );

    expect(() => recordInstagramWebhookUnknownAccountEntry()).not.toThrow();
  });
});
