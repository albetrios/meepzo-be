import { env } from '@/shared/config/env.config.js';

/** Resolves the BullMQ mail-worker concurrency, falling back to `WORKER_CONCURRENCY` when no per-queue override is set. */
export function getWorkerConcurrencyMail(): number {
  return env.WORKER_CONCURRENCY_MAIL ?? env.WORKER_CONCURRENCY;
}

/** Resolves the BullMQ notification-worker concurrency, falling back to `WORKER_CONCURRENCY`. */
export function getWorkerConcurrencyNotify(): number {
  return env.WORKER_CONCURRENCY_NOTIFY ?? env.WORKER_CONCURRENCY;
}

/** Resolves the BullMQ webhook-delivery worker concurrency, falling back to `WORKER_CONCURRENCY`. */
export function getWorkerConcurrencyWebhook(): number {
  return env.WORKER_CONCURRENCY_WEBHOOK ?? env.WORKER_CONCURRENCY;
}

/** Resolves the BullMQ Stripe-webhook worker concurrency, falling back to `WORKER_CONCURRENCY`. */
export function getWorkerConcurrencyStripe(): number {
  return env.WORKER_CONCURRENCY_STRIPE ?? env.WORKER_CONCURRENCY;
}

/**
 * Resolves the BullMQ Instagram event-processing worker concurrency — how many Instagram accounts
 * one process works on side by side (WH5) — falling back to `WORKER_CONCURRENCY`.
 */
export function getWorkerConcurrencyInstagram(): number {
  return env.WORKER_CONCURRENCY_INSTAGRAM ?? env.WORKER_CONCURRENCY;
}

/** Job places of the Instagram slow-lane send queue per process (SN2, P91 — its own maximum). */
export function getWorkerConcurrencyInstagramSendSlow(): number {
  return env.WORKER_CONCURRENCY_INSTAGRAM_SEND_SLOW;
}

/** Job places of the Instagram fast-message send queue per process (SN2, P91). */
export function getWorkerConcurrencyInstagramSendFast(): number {
  return env.WORKER_CONCURRENCY_INSTAGRAM_SEND_FAST;
}

/** Job places of the Instagram task queue per process (SN2, P91). */
export function getWorkerConcurrencyInstagramTasks(): number {
  return env.WORKER_CONCURRENCY_INSTAGRAM_TASKS;
}

/** Job places of the database-heavy Instagram task queue per process (S19, P97). */
export function getWorkerConcurrencyInstagramDatabaseTasks(): number {
  return env.WORKER_CONCURRENCY_INSTAGRAM_DATABASE_TASKS;
}

/**
 * Size of the in-process database limiter the Instagram send, intake and task workers share
 * (SN24, P91) — what the worker connection budget counts for them, once per process.
 */
export function getWorkerInstagramDatabaseSlots(): number {
  return env.WORKER_INSTAGRAM_DATABASE_SLOTS;
}
