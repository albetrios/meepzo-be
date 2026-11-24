import { getLatestMigrationVersion } from '@/infrastructure/database/migration/migration-version.js';
import { getTotalDeadLetterJobCount } from '@/infrastructure/observability/dlq-depth/dlq-depth.service.js';
import { countPendingMailOutbox } from '@/infrastructure/mail/mail-outbox.repository.js';
import {
  getQueueDepths,
  type QueueDepth,
} from '@/infrastructure/observability/metrics/bullmq-metrics.js';
import {
  WORKER_QUEUE_NAMES,
  WORKER_THROUGHPUT_QUEUE_NAMES,
} from '@/infrastructure/queue/queue-catalog.js';
import {
  getWorkerQueueOperationalManifest,
  type WorkerQueueOperationalManifestEntry,
} from '@/infrastructure/queue/worker-runtime/worker-registration.registry.js';
import {
  readWorkerQueueHeartbeats,
  type WorkerQueueHeartbeat,
} from '@/infrastructure/queue/worker-runtime/worker-queue-heartbeat.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/index.js';
import { isApplicationDraining } from '@/shared/utils/infrastructure/application-lifecycle.util.js';
import {
  snapshotManagedCircuitBreakers,
  type ManagedCircuitBreakerSnapshot,
} from '@/infrastructure/resilience/circuit-breaker.js';

const OPERATIONAL_METRICS_CACHE_TTL_MILLISECONDS = MILLISECONDS_PER_MINUTE;

/**
 * Whether this deployment may send Instagram messages, for the verbose readiness body
 * (feat-instagram-dm-sending § 6 SNC9): the switch, the reason when not, and the settings versions.
 */
export type HealthSendingSnapshot = {
  may_send: boolean;
  reason: string | null;
  settings_version: string | null;
  minimum_compatible_settings_version: string | null;
  server_settings_version: string;
};

/** The registered sending check — the app domain's, set when its container is built. */
let sendingHealthProbe: (() => Promise<HealthSendingSnapshot>) | null = null;

/**
 * Registers the sending check the readiness body reports (SNC9). The app container registers the
 * global sending row's check (`SendingStateService.checkSending`); a later call replaces it.
 *
 * @remarks
 * Shared code cannot import a domain, so the domain hands its check in. Informational only — it
 * never fails `/readyz` (the API does not send; the send workers refuse tickets themselves).
 */
export function registerHealthSendingProbe(probe: () => Promise<HealthSendingSnapshot>): void {
  sendingHealthProbe = probe;
}

/** The sending check's answer, or `null` with none registered or when it fails. */
async function readHealthSendingSnapshot(): Promise<HealthSendingSnapshot | null> {
  if (sendingHealthProbe === null) return null;
  try {
    return await sendingHealthProbe();
  } catch {
    return null;
  }
}

/** Operational health snapshot returned by {@link getCachedHealthOperationalMetrics} and surfaced on `/readyz`. */
export type HealthOperationalMetrics = {
  migration_version: string | null;
  mail_outbox_pending: number;
  dlq_depth: number;
  draining: boolean;
  worker_queues: WorkerQueueHeartbeat[];
  worker_queue_manifest: readonly WorkerQueueOperationalManifestEntry[];
  /** External-dependency circuit breaker states (Stripe/S3/Resend/Turnstile/Instagram) — visibility only. */
  circuit_breakers: ManagedCircuitBreakerSnapshot[];
  /** Waiting/delayed depth of the throughput queues (mail, webhook-delivery, notification, stripe-webhook). */
  queue_depths: QueueDepth[];
  /** True when any external circuit breaker is OPEN. Informational — does not by itself fail `/readyz`. */
  degraded: boolean;
  /** Whether this deployment may send Instagram messages (SNC9); `null` when not known. Informational. */
  sending: HealthSendingSnapshot | null;
};

let cachedOperationalMetrics: {
  value: HealthOperationalMetrics;
  expiresAt: number;
} | null = null;

/**
 * Operational signals for `/readyz` (cached 60s to limit DB/Redis load).
 */
export async function getCachedHealthOperationalMetrics(): Promise<HealthOperationalMetrics> {
  const now = Date.now();
  if (cachedOperationalMetrics && cachedOperationalMetrics.expiresAt > now) {
    return cachedOperationalMetrics.value;
  }

  const [
    migration_version,
    mail_outbox_pending,
    dlq_depth,
    worker_queues,
    circuit_breakers,
    queue_depths,
    sending,
  ] = await Promise.all([
    getLatestMigrationVersion(),
    countPendingMailOutbox(),
    getTotalDeadLetterJobCount(),
    readWorkerQueueHeartbeats(WORKER_QUEUE_NAMES),
    snapshotManagedCircuitBreakers(),
    getQueueDepths(WORKER_THROUGHPUT_QUEUE_NAMES),
    readHealthSendingSnapshot(),
  ]);

  const value: HealthOperationalMetrics = {
    migration_version,
    mail_outbox_pending,
    dlq_depth,
    draining: isApplicationDraining(),
    worker_queues,
    worker_queue_manifest: getWorkerQueueOperationalManifest(),
    circuit_breakers,
    queue_depths,
    degraded: circuit_breakers.some((breaker) => breaker.state === 'OPEN'),
    sending,
  };
  cachedOperationalMetrics = {
    value,
    expiresAt: now + OPERATIONAL_METRICS_CACHE_TTL_MILLISECONDS,
  };
  return value;
}

/** Test-only: clear operational metrics cache between tests. */
export function resetHealthOperationalMetricsCacheForTests(): void {
  cachedOperationalMetrics = null;
}
