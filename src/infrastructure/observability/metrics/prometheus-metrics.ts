import { Counter, Gauge, Histogram, type Registry } from '@prometheus-io/client';
import type { OrganizationRlsCheckoutPath } from '@/infrastructure/database/pool/organization-rls-checkout-counter.js';
import type { DatabasePoolStatistics } from '@/infrastructure/database/connection.js';
import {
  getMetricsRegistry,
  isMetricsEnabled,
} from '@/infrastructure/observability/metrics/metrics-registry.js';

/** Default latency histogram buckets (seconds) for fast HTTP / DB-checkout operations. */
const DEFAULT_LATENCY_BUCKETS_SECONDS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
/** Coarser histogram buckets (seconds) for slower BullMQ job durations. */
const JOB_DURATION_BUCKETS_SECONDS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

let registeredMetricsRegistry: Registry | null = null;

type HttpRequestMetricLabel = 'method' | 'route' | 'status_code';
let httpRequestsTotal: Counter<HttpRequestMetricLabel> | null = null;
let httpRequestDurationSeconds: Histogram<HttpRequestMetricLabel> | null = null;
let bullmqQueueWaiting: Gauge<'queue'> | null = null;
let bullmqQueueActive: Gauge<'queue'> | null = null;
let bullmqQueueDelayed: Gauge<'queue'> | null = null;
let bullmqQueueFailed: Gauge<'queue'> | null = null;
let bullmqJobDurationSeconds: Histogram<'queue' | 'job_name'> | null = null;
let postgresPoolMaxConnections: Gauge<'pool'> | null = null;
let postgresPoolMetricsAvailable: Gauge | null = null;
let postgresPoolConnections: Gauge<'pool' | 'state'> | null = null;
let postgresPoolWaiting: Gauge<'pool'> | null = null;
let dbPoolConnections: Gauge<'state'> | null = null;
let eventLoopLagMilliseconds: Gauge | null = null;
let stripeWebhookEventsFailed: Gauge | null = null;
let mailOutboxPending: Gauge | null = null;
let dlqDepthTotal: Gauge | null = null;
let databaseRlsActiveCheckouts: Gauge | null = null;
let databaseRlsCheckoutHoldSeconds: Histogram<'path'> | null = null;
let processUnhandledRejectionsTotal: Counter<'process'> | null = null;
let eventBusHandlerFailuresTotal: Counter<'event_type'> | null = null;
let commitDispatchDurabilityFallbacksTotal: Counter | null = null;
let readCacheRequestsTotal: Counter<'cache' | 'result'> | null = null;
let databaseUnscopedQueriesTotal: Counter | null = null;
let bullmqProviderOutageParkedJobsTotal: Counter<'queue' | 'provider' | 'reason'> | null = null;
let instagramWebhookUnknownAccountEntriesTotal: Counter | null = null;
let repairDutyRoundSeconds: Histogram<'duty'> | null = null;
let repairDutyBacklog: Gauge<'duty'> | null = null;
let appPartitionReadyDays: Gauge<'table'> | null = null;
let appPartitionDefaultRows: Gauge<'table'> | null = null;
let appPartitionOldestOverdueSeconds: Gauge<'table'> | null = null;
let retentionCleanupOldestOverdueSeconds: Gauge<'table'> | null = null;
let retentionCleanupDeletedRows: Gauge<'table'> | null = null;

/** The partition upkeep's three gauges (WC-55, P92, S17) — split out of {@link registerOn}. */
function registerPartitionUpkeepMetrics(registry: Registry): void {
  appPartitionReadyDays = new Gauge({
    name: 'app_partition_ready_days',
    help: 'Days ahead, from today (UTC), whose parts exist for each time-split app table (feat-instagram-dm-sending WC-55, S17). Made at least 14 days ahead; below 7 the upkeep alerts — rows of a day without a part land in the DEFAULT part',
    labelNames: ['table'],
    registers: [registry],
  });
  appPartitionDefaultRows = new Gauge({
    name: 'app_partition_default_rows',
    help: 'Rows in the DEFAULT part of each time-split app table (capped at 1000). Any row alerts: its day had no part, and that day cannot get one until the upkeep moves the rows (S17)',
    labelNames: ['table'],
    registers: [registry],
  });
  appPartitionOldestOverdueSeconds = new Gauge({
    name: 'app_partition_oldest_overdue_seconds',
    help: 'Seconds the oldest kept part holding rows is past its drop time, per time-split app table — the "oldest row past its keep time" gauge at part granularity (P92). Alerts after 1 day',
    labelNames: ['table'],
    registers: [registry],
  });
}

/** The hourly batch clean-ups' two gauges (feat-instagram-dm-sending P92) — split out of {@link registerOn}. */
function registerRetentionCleanupMetrics(registry: Registry): void {
  retentionCleanupOldestOverdueSeconds = new Gauge({
    name: 'retention_cleanup_oldest_overdue_seconds',
    help: 'Seconds the oldest row past its keep time still waits, per plain table an hourly batch clean-up empties — the "oldest row past its keep time" gauge (P92). Alerts after 1 day',
    labelNames: ['table'],
    registers: [registry],
  });
  retentionCleanupDeletedRows = new Gauge({
    name: 'retention_cleanup_deleted_rows',
    help: 'Rows the last run of an hourly batch clean-up deleted, per table (P92) — each run stops at its time budget or the table cap',
    labelNames: ['table'],
    registers: [registry],
  });
}

/** The BullMQ queue and job metrics — split out of {@link registerOn} to keep each short. */
function registerQueueMetrics(registry: Registry): void {
  bullmqQueueWaiting = new Gauge({
    name: 'bullmq_queue_waiting',
    help: 'BullMQ jobs waiting in queue',
    labelNames: ['queue'],
    registers: [registry],
  });

  bullmqQueueActive = new Gauge({
    name: 'bullmq_queue_active',
    help: 'BullMQ jobs currently active',
    labelNames: ['queue'],
    registers: [registry],
  });

  bullmqQueueDelayed = new Gauge({
    name: 'bullmq_queue_delayed',
    help: 'BullMQ jobs delayed',
    labelNames: ['queue'],
    registers: [registry],
  });

  bullmqQueueFailed = new Gauge({
    name: 'bullmq_queue_failed',
    help: 'BullMQ jobs in failed state',
    labelNames: ['queue'],
    registers: [registry],
  });

  bullmqJobDurationSeconds = new Histogram({
    name: 'bullmq_job_duration_seconds',
    help: 'BullMQ job processing duration in seconds',
    labelNames: ['queue', 'job_name'],
    buckets: JOB_DURATION_BUCKETS_SECONDS,
    registers: [registry],
  });

  repairDutyRoundSeconds = new Histogram({
    name: 'repair_duty_round_seconds',
    help: 'How long one round of a scheduled repair duty took, by duty (feat-instagram-dm-sending P94: each duty works until its 40 s budget is spent). Rounds that keep hitting 40 s mean the duty cannot keep up — read repair_duty_backlog beside it',
    labelNames: ['duty'],
    buckets: JOB_DURATION_BUCKETS_SECONDS,
    registers: [registry],
  });

  repairDutyBacklog = new Gauge({
    name: 'repair_duty_backlog',
    help: 'Rows a scheduled repair duty left due at the end of its last round, by duty (0 = it caught up; otherwise at least this many, its last piece). A backlog that stays above 0 for several minutes is the alert (P94)',
    labelNames: ['duty'],
    registers: [registry],
  });

  bullmqProviderOutageParkedJobsTotal = new Counter({
    name: 'bullmq_provider_outage_parked_jobs_total',
    help: "Jobs parked because their third-party provider was down (reason=outage — each one re-arms the queue's five-minute pause) or throttling us (reason=throttle — paused for the provider's Retry-After), by queue and provider (resend | stripe | s3 | instagram). An outage rate that keeps rising is an outage still in progress: the queue is waiting for the provider, not losing jobs",
    labelNames: ['queue', 'provider', 'reason'],
    registers: [registry],
  });
}

function registerOn(registry: Registry): void {
  httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });

  httpRequestDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: DEFAULT_LATENCY_BUCKETS_SECONDS,
    registers: [registry],
  });

  registerQueueMetrics(registry);

  postgresPoolMaxConnections = new Gauge({
    name: 'postgres_pool_max_connections',
    help: "Configured size of each of this process's pools (DATABASE_POOL_MAX, DATABASE_MAINTENANCE_POOL_MAX)",
    labelNames: ['pool'],
    registers: [registry],
  });

  postgresPoolMetricsAvailable = new Gauge({
    name: 'postgres_pool_metrics_available',
    help: '1 when this process exports its live pool counts (postgres_pool_connections, postgres_pool_waiting)',
    registers: [registry],
  });

  postgresPoolConnections = new Gauge({
    name: 'postgres_pool_connections',
    help: "This process's pooled Postgres connections by pool and state (in_use, idle), counted by node-postgres",
    labelNames: ['pool', 'state'],
    registers: [registry],
  });

  postgresPoolWaiting = new Gauge({
    name: 'postgres_pool_waiting',
    help: 'Units of work in this process queued for a pooled Postgres connection, by pool',
    labelNames: ['pool'],
    registers: [registry],
  });

  dbPoolConnections = new Gauge({
    name: 'db_pool_connections',
    help: 'Server-side connections of the current database role across every process, sampled from pg_stat_activity',
    labelNames: ['state'],
    registers: [registry],
  });

  eventLoopLagMilliseconds = new Gauge({
    name: 'event_loop_lag_ms',
    help: 'Node.js event loop delay p99 in milliseconds (perf_hooks.monitorEventLoopDelay)',
    registers: [registry],
  });

  stripeWebhookEventsFailed = new Gauge({
    name: 'stripe_webhook_events_failed',
    help: 'Stripe webhook ledger rows in failed processing_status (alert when >0 for >10m)',
    registers: [registry],
  });

  mailOutboxPending = new Gauge({
    name: 'mail_outbox_pending',
    help: 'Pending rows in auth.mail_outbox awaiting BullMQ dispatch',
    registers: [registry],
  });

  dlqDepthTotal = new Gauge({
    name: 'dlq_depth',
    help: 'Total BullMQ dead-letter jobs (waiting + failed) across monitored source queues',
    registers: [registry],
  });

  databaseRlsActiveCheckouts = new Gauge({
    name: 'database_rls_active_checkouts',
    help: 'In-process organization-scoped RLS transaction checkouts currently held (early pool-saturation signal; alert near DATABASE_POOL_MAX)',
    registers: [registry],
  });

  databaseRlsCheckoutHoldSeconds = new Histogram({
    name: 'database_rls_checkout_hold_seconds',
    help: 'Wall-clock seconds an RLS transaction held a pooled connection, by path (scoped_context | session_context | maintenance_context)',
    labelNames: ['path'],
    buckets: DEFAULT_LATENCY_BUCKETS_SECONDS,
    registers: [registry],
  });

  databaseUnscopedQueriesTotal = new Counter({
    name: 'database_unscoped_query_total',
    help: 'Queries issued on the bare pool with no database context active (possible RLS bypass)',
    registers: [registry],
  });

  processUnhandledRejectionsTotal = new Counter({
    name: 'process_unhandled_rejections_total',
    help: 'Non-fatal unhandledRejection events tolerated by the burst handler, by process (api | worker). Alert on a sustained sub-threshold rate — it hides a persistent failing path that never trips the fatal burst exit',
    labelNames: ['process'],
    registers: [registry],
  });

  eventBusHandlerFailuresTotal = new Counter({
    name: 'event_bus_handler_failures_total',
    help: 'Domain-event handler failures swallowed by eventBus.emit (best-effort side effects), by event_type. A sustained rate hides a persistently failing handler (email/webhook/audit enqueue) that never fails the originating request',
    labelNames: ['event_type'],
    registers: [registry],
  });

  commitDispatchDurabilityFallbacksTotal = new Counter({
    name: 'commit_dispatch_durability_fallbacks_total',
    help: 'Post-commit dispatch tasks that fell back from durable Redis persistence to the lossy in-memory onCommit path because the Redis RPUSH failed. Any non-zero value is a durability-degradation signal — the side effect is lost if the process dies before flush',
    registers: [registry],
  });

  instagramWebhookUnknownAccountEntriesTotal = new Counter({
    name: 'instagram_webhook_unknown_account_entries_total',
    help: 'Instagram webhook delivery entries for an Instagram account no organization holds (never connected, or revoked) — answered 200 and stored nowhere (WH4). A steady trickle is normal after a disconnect while Meta still delivers; a jump means a live account stopped resolving',
    registers: [registry],
  });

  registerPartitionUpkeepMetrics(registry);
  registerRetentionCleanupMetrics(registry);

  readCacheRequestsTotal = new Counter({
    name: 'read_cache_requests_total',
    help: 'Read-through cache lookups by cache name and result (hit | miss). A cache whose hit ratio sits near zero is pure overhead — it is paying a Redis round trip to still ask Postgres — and one whose ratio collapses after a deploy usually means an invalidation became too broad. Alert on a sustained drop, not on an absolute value: the right ratio differs per cache',
    labelNames: ['cache', 'result'],
    registers: [registry],
  });
}

function bindMetricHandlesFromRegistry(registry: Registry): void {
  httpRequestsTotal = registry.getSingleMetric('http_requests_total') as Counter<
    'method' | 'route' | 'status_code'
  >;
  httpRequestDurationSeconds = registry.getSingleMetric(
    'http_request_duration_seconds',
  ) as Histogram<'method' | 'route' | 'status_code'>;
  bullmqQueueWaiting = registry.getSingleMetric('bullmq_queue_waiting') as Gauge<'queue'>;
  bullmqQueueActive = registry.getSingleMetric('bullmq_queue_active') as Gauge<'queue'>;
  bullmqQueueDelayed = registry.getSingleMetric('bullmq_queue_delayed') as Gauge<'queue'>;
  bullmqQueueFailed = registry.getSingleMetric('bullmq_queue_failed') as Gauge<'queue'>;
  bullmqJobDurationSeconds = registry.getSingleMetric('bullmq_job_duration_seconds') as Histogram<
    'queue' | 'job_name'
  >;
  postgresPoolMaxConnections = registry.getSingleMetric(
    'postgres_pool_max_connections',
  ) as Gauge<'pool'>;
  postgresPoolConnections = registry.getSingleMetric('postgres_pool_connections') as Gauge<
    'pool' | 'state'
  >;
  postgresPoolWaiting = registry.getSingleMetric('postgres_pool_waiting') as Gauge<'pool'>;
  postgresPoolMetricsAvailable = registry.getSingleMetric(
    'postgres_pool_metrics_available',
  ) as Gauge;
  dbPoolConnections = registry.getSingleMetric('db_pool_connections') as Gauge<'state'>;
  eventLoopLagMilliseconds = registry.getSingleMetric('event_loop_lag_ms') as Gauge;
  stripeWebhookEventsFailed = registry.getSingleMetric('stripe_webhook_events_failed') as Gauge;
  mailOutboxPending = registry.getSingleMetric('mail_outbox_pending') as Gauge;
  dlqDepthTotal = registry.getSingleMetric('dlq_depth') as Gauge;
  databaseRlsActiveCheckouts = registry.getSingleMetric('database_rls_active_checkouts') as Gauge;
  databaseRlsCheckoutHoldSeconds = registry.getSingleMetric(
    'database_rls_checkout_hold_seconds',
  ) as Histogram<'path'>;
  processUnhandledRejectionsTotal = registry.getSingleMetric(
    'process_unhandled_rejections_total',
  ) as Counter<'process'>;
  eventBusHandlerFailuresTotal = registry.getSingleMetric(
    'event_bus_handler_failures_total',
  ) as Counter<'event_type'>;
  commitDispatchDurabilityFallbacksTotal = registry.getSingleMetric(
    'commit_dispatch_durability_fallbacks_total',
  ) as Counter;
  bullmqProviderOutageParkedJobsTotal = registry.getSingleMetric(
    'bullmq_provider_outage_parked_jobs_total',
  ) as Counter<'queue' | 'provider' | 'reason'>;
  repairDutyRoundSeconds = registry.getSingleMetric(
    'repair_duty_round_seconds',
  ) as Histogram<'duty'>;
  repairDutyBacklog = registry.getSingleMetric('repair_duty_backlog') as Gauge<'duty'>;
  readCacheRequestsTotal = registry.getSingleMetric('read_cache_requests_total') as Counter<
    'cache' | 'result'
  >;
  instagramWebhookUnknownAccountEntriesTotal = registry.getSingleMetric(
    'instagram_webhook_unknown_account_entries_total',
  ) as Counter;
  appPartitionReadyDays = registry.getSingleMetric('app_partition_ready_days') as Gauge<'table'>;
  retentionCleanupOldestOverdueSeconds = registry.getSingleMetric(
    'retention_cleanup_oldest_overdue_seconds',
  ) as Gauge<'table'>;
  retentionCleanupDeletedRows = registry.getSingleMetric(
    'retention_cleanup_deleted_rows',
  ) as Gauge<'table'>;
  appPartitionDefaultRows = registry.getSingleMetric(
    'app_partition_default_rows',
  ) as Gauge<'table'>;
  appPartitionOldestOverdueSeconds = registry.getSingleMetric(
    'app_partition_oldest_overdue_seconds',
  ) as Gauge<'table'>;
  registeredMetricsRegistry = registry;
}

/**
 * Registers custom Prometheus metrics on the given registry.
 * Safe to call from scrape refresh and per-request recording (no circular import with metrics.ts).
 */
export function ensurePrometheusMetricsRegistered(registry: Registry): void {
  if (!isMetricsEnabled()) {
    return;
  }
  if (httpRequestsTotal && httpRequestDurationSeconds) {
    return;
  }
  if (registry.getSingleMetric('http_requests_total')) {
    bindMetricHandlesFromRegistry(registry);
    return;
  }
  registerOn(registry);
  registeredMetricsRegistry = registry;
}

/**
 * Records one HTTP request into `http_requests_total` (counter) and
 * `http_request_duration_seconds` (histogram) keyed by method/route/status.
 * No-op when metrics are disabled or registration has not yet happened.
 */
export function recordHttpRequest({
  method,
  route,
  statusCode,
  durationSeconds,
}: {
  method: string;
  route: string;
  statusCode: number;
  durationSeconds: number;
}): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  if (!(httpRequestsTotal && httpRequestDurationSeconds)) return;

  const labels = {
    method: method.toUpperCase(),
    route,
    status_code: String(statusCode),
  };
  httpRequestsTotal.inc(labels);
  httpRequestDurationSeconds.observe(labels, durationSeconds);
}

/**
 * Updates the `bullmq_queue_{waiting,active,delayed,failed}` gauges for a single
 * queue from a freshly read `getJobCounts` payload. Called by
 * {@link refreshBullMQQueueGauges}.
 */
export function setBullMQQueueCounts({
  queueName,
  counts,
}: {
  queueName: string;
  counts: { waiting: number; active: number; delayed: number; failed: number };
}): void {
  if (!isMetricsEnabled()) return;
  if (!(bullmqQueueWaiting && bullmqQueueActive && bullmqQueueDelayed && bullmqQueueFailed)) {
    return;
  }
  const label = { queue: queueName };
  bullmqQueueWaiting.set(label, counts.waiting);
  bullmqQueueActive.set(label, counts.active);
  bullmqQueueDelayed.set(label, counts.delayed);
  bullmqQueueFailed.set(label, counts.failed);
}

/**
 * Observes one BullMQ job's processing duration on the
 * `bullmq_job_duration_seconds` histogram, labelled by queue + job name. Wired
 * to worker `completed` events via `attachBullMQJobMetrics`.
 */
export function recordBullMQJobDuration({
  queueName,
  jobName,
  durationSeconds,
}: {
  queueName: string;
  jobName: string;
  durationSeconds: number;
}): void {
  if (!isMetricsEnabled()) return;
  const histogram =
    bullmqJobDurationSeconds ??
    (registeredMetricsRegistry?.getSingleMetric('bullmq_job_duration_seconds') as
      | Histogram<'queue' | 'job_name'>
      | undefined);
  if (!histogram) return;
  histogram.observe({ queue: queueName, job_name: jobName }, durationSeconds);
}

/**
 * Sets the live pool gauges from node-postgres's own counts, one label set per pool:
 * `postgres_pool_max_connections{pool}`, `postgres_pool_connections{pool,state}` (`in_use`,
 * `idle`) and `postgres_pool_waiting{pool}`, plus `postgres_pool_metrics_available` 1.
 *
 * @remarks
 * A pool that is not open yet (the lazy maintenance pool) has no label set rather than zeros, so a
 * dashboard never reads a pool that does not exist as an idle one.
 */
export function setPostgresPoolStatistics(statistics: ReadonlyArray<DatabasePoolStatistics>): void {
  if (!isMetricsEnabled()) return;
  if (
    !(
      postgresPoolMaxConnections &&
      postgresPoolMetricsAvailable &&
      postgresPoolConnections &&
      postgresPoolWaiting
    )
  ) {
    return;
  }
  for (const { pool, maxConnections, inUse, idle, waiting } of statistics) {
    postgresPoolMaxConnections.set({ pool }, maxConnections);
    postgresPoolConnections.set({ pool, state: 'in_use' }, inUse);
    postgresPoolConnections.set({ pool, state: 'idle' }, idle);
    postgresPoolWaiting.set({ pool }, waiting);
  }
  postgresPoolMetricsAvailable.set(1);
}

/**
 * Sets the `db_pool_connections{state=...}` gauge from a fresh `pg_stat_activity` sample.
 * Every state is written on each sample — a state missing from it reads 0 — so a drained
 * state never keeps a stale value and dashboards see a stable schema.
 */
export function setPostgresPoolConnectionCounts(
  samples: ReadonlyArray<{ state: 'active' | 'idle' | 'waiting'; count: number }>,
): void {
  if (!isMetricsEnabled()) return;
  if (!dbPoolConnections) return;

  const countsByState: Record<'active' | 'idle' | 'waiting', number> = {
    active: 0,
    idle: 0,
    waiting: 0,
  };

  for (const sample of samples) {
    countsByState[sample.state] = sample.count;
  }
  for (const [state, count] of Object.entries(countsByState)) {
    dbPoolConnections.set({ state }, count);
  }
}

/**
 * Updates the `event_loop_lag_ms` gauge from the perf-hooks p99 sample.
 * Lazily registers metrics so the event-loop refresh path can run before the
 * scrape endpoint has been hit.
 */
export function setEventLoopLagMilliseconds(lagMilliseconds: number): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  if (!eventLoopLagMilliseconds) return;
  eventLoopLagMilliseconds.set(lagMilliseconds);
}

/**
 * Sets the `stripe_webhook_events_failed` gauge — fed by the Stripe ledger
 * reclaim worker so dashboards alert when failed rows linger more than 10
 * minutes (Sentry rule, see help text on the metric).
 */
export function setStripeWebhookEventsFailedCount(count: number): void {
  if (!isMetricsEnabled()) return;
  if (!stripeWebhookEventsFailed) return;
  stripeWebhookEventsFailed.set(count);
}

/**
 * Sets business-level backlog gauges refreshed on each Prometheus scrape.
 */
export function setBusinessMetricCounts(options: {
  mailOutboxPending: number;
  dlqDepth: number;
}): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  mailOutboxPending?.set(options.mailOutboxPending);
  dlqDepthTotal?.set(options.dlqDepth);
}

/**
 * Sets the `database_rls_active_checkouts` gauge from the in-process organization-RLS checkout
 * counter. Fed by the pool-metrics scrape refresh so dashboards see how many organization-scoped
 * RLS checkouts are held against `DATABASE_POOL_MAX` before the pool starts queuing.
 */
export function setOrganizationRlsActiveCheckouts(count: number): void {
  if (!isMetricsEnabled()) return;
  if (!databaseRlsActiveCheckouts) return;
  databaseRlsActiveCheckouts.set(count);
}

/**
 * Observes one completed RLS checkout hold on the `database_rls_checkout_hold_seconds` histogram,
 * labelled by `path` (`scoped_context` | `session_context` | `maintenance_context`). Wired via
 * `registerOrganizationRlsCheckoutHoldObserver` so the hot database-checkout paths stay free of a
 * `@prometheus-io/client` import. No-op when metrics are disabled.
 */
export function recordOrganizationRlsCheckoutHold(options: {
  path: OrganizationRlsCheckoutPath;
  durationSeconds: number;
}): void {
  if (!isMetricsEnabled()) return;
  if (!databaseRlsCheckoutHoldSeconds) return;
  databaseRlsCheckoutHoldSeconds.observe({ path: options.path }, options.durationSeconds);
}

/** Process whose `unhandledRejection` handler fired — distinguishes API from worker series. */
export type UnhandledRejectionProcess = 'api' | 'worker';

/**
 * Increments `process_unhandled_rejections_total{process}` for one non-fatal
 * `unhandledRejection`. Lazily registers metrics so the very first rejection (which can occur
 * before any scrape) is still counted. No-op when metrics are disabled — the rejection is still
 * logged + captured by the caller, so observability never depends on `METRICS_ENABLED`.
 */
export function recordUnhandledRejection(process: UnhandledRejectionProcess): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  if (!processUnhandledRejectionsTotal) return;
  processUnhandledRejectionsTotal.inc({ process });
}

/**
 * Increments `event_bus_handler_failures_total{event_type}` for one best-effort domain-event
 * handler that threw inside {@link eventBus.emit}. No-op when metrics are disabled — the failure is
 * still logged and captured by the caller, so observability never depends on `METRICS_ENABLED`.
 */
export function recordEventBusHandlerFailure(eventType: string): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  if (!eventBusHandlerFailuresTotal) return;
  eventBusHandlerFailuresTotal.inc({ event_type: eventType });
}

/**
 * Increments `instagram_webhook_unknown_account_entries_total` for one Instagram webhook delivery
 * entry whose account no organization holds (never connected, or revoked) — WH4, WQ1. No-op when
 * metrics are disabled; the receiver still logs `instagram.webhook.unknown_account` for it.
 */
export function recordInstagramWebhookUnknownAccountEntry(): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  if (!instagramWebhookUnknownAccountEntriesTotal) return;
  instagramWebhookUnknownAccountEntriesTotal.inc();
}

/**
 * Sets the partition upkeep's three gauges for one time-split table (feat-instagram-dm-sending WC-55,
 * P92, S17): the ready days ahead, the DEFAULT part's rows and the oldest kept part's overdue
 * seconds. No-op when metrics are disabled — the upkeep still logs and alerts.
 */
export function setAppPartitionUpkeepGauges({
  table,
  readyDays,
  defaultRows,
  oldestOverdueSeconds,
}: {
  table: string;
  readyDays: number;
  defaultRows: number;
  oldestOverdueSeconds: number;
}): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  appPartitionReadyDays?.set({ table }, readyDays);
  appPartitionDefaultRows?.set({ table }, defaultRows);
  appPartitionOldestOverdueSeconds?.set({ table }, oldestOverdueSeconds);
}

/**
 * Records one round of a scheduled repair duty (feat-instagram-dm-sending P94): its time on
 * `repair_duty_round_seconds{duty}` and what it left due on `repair_duty_backlog{duty}`. No-op when
 * metrics are disabled; the duty still logs its counts.
 */
export function recordRepairDutyRound({
  duty,
  roundSeconds,
  backlog,
}: {
  duty: string;
  roundSeconds: number;
  backlog: number;
}): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  repairDutyRoundSeconds?.observe({ duty }, roundSeconds);
  repairDutyBacklog?.set({ duty }, backlog);
}

/**
 * Sets an hourly batch clean-up's two gauges for one plain table (feat-instagram-dm-sending P92):
 * the oldest due row's overdue seconds and the rows the run deleted. No-op when metrics are
 * disabled — the clean-up still logs and alerts.
 */
export function setRetentionCleanupGauges({
  table,
  oldestOverdueSeconds,
  deletedRows,
}: {
  table: string;
  oldestOverdueSeconds: number;
  deletedRows: number;
}): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  retentionCleanupOldestOverdueSeconds?.set({ table }, oldestOverdueSeconds);
  retentionCleanupDeletedRows?.set({ table }, deletedRows);
}

/**
 * Increments `commit_dispatch_durability_fallbacks_total` when a post-commit dispatch task could not
 * be persisted to Redis and fell back to the lossy in-memory path. No-op when metrics are disabled —
 * the fallback is still logged and captured to Sentry by the caller.
 */
export function recordCommitDispatchDurabilityFallback(): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  if (!commitDispatchDurabilityFallbacksTotal) return;
  commitDispatchDurabilityFallbacksTotal.inc();
}

/**
 * Records one read-through cache lookup.
 *
 * @remarks
 * - **Algorithm:** increments `read_cache_requests_total{cache,result}`; a no-op when metrics are
 *   disabled or the registry has not been built.
 * - **Failure modes:** none — never throws into a read path.
 * - **Side effects:** one counter increment.
 * - **Notes:** `cache` is the cache's own name (`notify_unread_count`), not the Redis key, so the
 *   label stays bounded — a per-key label would be unbounded cardinality. Without this, a cache is
 *   unfalsifiable: it either helps or quietly costs a round trip per request and nothing says which.
 */
export function recordReadCacheRequest({
  cache,
  result,
}: {
  cache: string;
  result: 'hit' | 'miss';
}): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  if (!readCacheRequestsTotal) return;
  readCacheRequestsTotal.inc({ cache, result });
}

/**
 * Increments `bullmq_provider_outage_parked_jobs_total` for one job parked by a provider outage or
 * throttle.
 *
 * @remarks
 * Called by the provider-pausable worker each time a job waits out its provider. Every label is
 * bounded: a queue name, one of the pausable providers (`QueueProvider`), `outage` or `throttle`.
 */
export function recordProviderOutageParkedJob(options: {
  queue: string;
  provider: string;
  reason: 'outage' | 'throttle';
}): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  if (!bullmqProviderOutageParkedJobsTotal) return;
  bullmqProviderOutageParkedJobsTotal.inc({
    queue: options.queue,
    provider: options.provider,
    reason: options.reason,
  });
}

/**
 * Increments `database_unscoped_query_total`.
 *
 * @remarks
 * A non-zero rate means some path reached Postgres without a database context. Against a
 * FORCE RLS table that silently returns zero rows — how offboarding came to erase nothing —
 * so this is the counter to alert on, not merely graph.
 */
export function recordUnscopedDatabaseQuery(): void {
  databaseUnscopedQueriesTotal?.inc();
}
