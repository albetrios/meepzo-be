import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/config/env.config.js', () => ({
  env: new Proxy(
    {
      LOG_LEVEL: 'silent',
      WORKER_CONCURRENCY: 4,
      WORKER_CONCURRENCY_MAIL: 4,
      WORKER_CONCURRENCY_NOTIFY: 4,
      WORKER_CONCURRENCY_WEBHOOK: 4,
      WORKER_CONCURRENCY_STRIPE: 4,
      WORKER_CONCURRENCY_INSTAGRAM: 4,
      WORKER_INSTAGRAM_DATABASE_SLOTS: 16,
    },
    {
      get(target, property: string) {
        return property in target ? target[property as keyof typeof target] : undefined;
      },
    },
  ),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/infrastructure/database/connection.js', () => ({
  sql: vi.fn(),
  database: {},
}));

vi.mock('@/infrastructure/cache/redis.client.js', () => ({
  redis: {},
  redisConnection: {},
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn(),
}));

import {
  getWorkerQueueOperationalManifest,
  getWorkerQueueRegistrationDefinitions,
} from '@/infrastructure/queue/worker-runtime/worker-registration.registry.js';
import { WORKER_QUEUE_FAMILY_NAMES } from '@/infrastructure/queue/worker-runtime/worker-queue-family.constants.js';

describe('worker-registration.registry', () => {
  it('keeps complete metadata for every registered worker', () => {
    const definitions = getWorkerQueueRegistrationDefinitions();

    // REQ-4: +1 for the subscription-seat-sync worker (Stripe family, throughput, Postgres-backed);
    // +1 for the webhook-delivery-reclaim sweep (webhook family, cron, Postgres-backed); +1 for the
    // membership invitation expiry sweep (launch D84); +2 for the Instagram reconnect notice (notify
    // family, throughput) and the daily Instagram account check (retention family, cron — launch
    // IA8, IA9); +1 for the Instagram webhook event clean-up (instagram family, cron,
    // Postgres-backed — launch-2026-11-20-ujai WH19); the "next post" expiry is gone (P127); +2 for
    // the run and automation clean-ups (retention family, crons, Postgres-backed — the hourly 7-day
    // wait cancel and the deleted-automation purge; run and comment-log retention retired at
    // feat-instagram-dm-sending R14, P133 — their month parts are dropped);
    // +1 for the Instagram webhook event processing (instagram family, throughput,
    // Postgres-backed, its stuck-event pick-up riding the queue — launch-2026-11-20-ujai WH5,
    // WH12–WH15); +3 for the Instagram send and task queues (feat-instagram-dm-sending SN2, R37 —
    // `instagram-send-slow`, `instagram-send-fast` and `instagram-tasks`, all in family `instagram`
    // (P140); throughput, event-driven, their database through the shared limiter); +1 for the
    // channel connection's token check (retention family, cron, Postgres-backed — MC10, WC-34),
    // which replaced the daily Instagram account check (−1); +1 for the database-heavy Instagram
    // task queue (`instagram-database-tasks`, S19 — R46).
    expect(definitions).toHaveLength(44);
    for (const definition of definitions) {
      expect(definition.queueName).toBeTruthy();
      expect(definition.logLabel).toBeTruthy();
      expect(WORKER_QUEUE_FAMILY_NAMES).toContain(definition.family);
      expect(typeof definition.usesPostgres).toBe('boolean');
      expect(typeof definition.scheduled).toBe('boolean');
      expect(['throughput', 'maintenance', 'observability']).toContain(definition.criticality);
      expect(typeof definition.create).toBe('function');

      if (definition.usesPostgres) {
        expect(definition.resolvePostgresConcurrency).toEqual(expect.any(Function));
      } else {
        expect(definition.resolvePostgresConcurrency).toBeUndefined();
        expect(definition.holdsConnectionDuringExternalIo).not.toBe(true);
      }
    }
  });

  it('keeps expected family, criticality, scheduler, and external-io counts', () => {
    const definitions = getWorkerQueueRegistrationDefinitions();

    // REQ-4: subscription-seat-sync adds one Postgres-backed throughput worker (event-driven, plus the
    // hourly seat reconcile on its queue); the webhook-delivery-reclaim sweep one Postgres-backed,
    // scheduled, maintenance worker; user-data-export also runs its lost-enqueue sweep; the
    // membership invitation expiry sweep (D84) one Postgres-backed, scheduled, maintenance worker;
    // the Instagram reconnect notice one Postgres-backed throughput worker (event-driven) (IA9; the
    // daily Instagram account check, IA8, went when the token check below replaced it);
    // the Instagram webhook event clean-up (WH19) one more Postgres-backed, scheduled, maintenance
    // worker; the two run and automation clean-ups (the 7-day wait cancel, the deleted-automation purge)
    // two more; the Instagram webhook event processing (WH5, WH15) one
    // Postgres-backed throughput worker whose every-minute pick-up rides its queue; the Instagram
    // send and task queues (SN2, R37) three Postgres-backed, event-driven throughput workers; the
    // channel connection's token check (MC10) one more Postgres-backed, scheduled, maintenance worker;
    // the database-heavy task queue (S19, R46) one more Postgres-backed, event-driven throughput one.
    expect(definitions.filter((definition) => definition.usesPostgres)).toHaveLength(41);
    expect(definitions.filter((definition) => definition.scheduled)).toHaveLength(35);
    expect(
      definitions.filter((definition) => definition.criticality === 'throughput'),
    ).toHaveLength(12);
    expect(
      definitions.filter((definition) => definition.criticality === 'maintenance'),
    ).toHaveLength(30);
    expect(
      definitions.filter((definition) => definition.criticality === 'observability'),
    ).toHaveLength(2);
    // No worker holds a database context across an outbound call: the audit export, the data
    // export, the upload sweep and both retention purges open short contexts around their S3 calls.
    expect(
      definitions
        .filter((definition) => definition.holdsConnectionDuringExternalIo === true)
        .map((definition) => definition.queueName),
    ).toEqual([]);
  });

  it('puts the Instagram send and task queues on one database limiter in the instagram family, gated on sending (SN24, P140, S19)', () => {
    const sendingQueues = getWorkerQueueRegistrationDefinitions().filter(
      (definition) => definition.databaseSlotLimiterName !== undefined,
    );
    expect(sendingQueues.map((definition) => [definition.queueName, definition.family])).toEqual([
      ['instagram-send-slow', 'instagram'],
      ['instagram-send-fast', 'instagram'],
      ['instagram-tasks', 'instagram'],
      ['instagram-database-tasks', 'instagram'],
    ]);
    for (const definition of sendingQueues) {
      expect(definition.databaseSlotLimiterName).toBe('instagram-database');
      expect(definition.resolvePostgresConcurrency?.(undefined)).toBe(16);
    }
    // The send and Meta-calling task queues wait for sending; the database-heavy tasks (bulk
    // changes, counts, audiences, retries) call no Meta and run with sending off too (R46).
    expect(
      sendingQueues.map((definition) => [definition.queueName, definition.isEnabled !== undefined]),
    ).toEqual([
      ['instagram-send-slow', true],
      ['instagram-send-fast', true],
      ['instagram-tasks', true],
      ['instagram-database-tasks', false],
    ]);
  });

  it('has no maintenance workers left unscheduled (every retention worker has a cron)', () => {
    const orphanQueueNames = getWorkerQueueRegistrationDefinitions()
      .filter(
        (definition) => definition.criticality === 'maintenance' && definition.scheduled === false,
      )
      .map((definition) => definition.queueName)
      .sort();

    expect(orphanQueueNames).toEqual([]);
  });

  it('exports a serializable operational manifest without factory functions', () => {
    const manifest = getWorkerQueueOperationalManifest();
    expect(manifest).toHaveLength(getWorkerQueueRegistrationDefinitions().length);
    for (const entry of manifest) {
      expect(entry).not.toHaveProperty('create');
      expect(entry.queueName).toBeTruthy();
      expect(entry.family).toBeTruthy();
    }
  });
});
