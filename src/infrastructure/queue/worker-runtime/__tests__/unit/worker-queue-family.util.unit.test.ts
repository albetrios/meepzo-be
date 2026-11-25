import { describe, expect, it } from 'vitest';
import {
  isMonolithicWorkerQueueFamilies,
  parseWorkerQueueFamilies,
} from '@/infrastructure/queue/worker-runtime/worker-queue-family.util.js';

describe('worker-queue-family.util', () => {
  it('returns all families when unset or all', () => {
    // Seven families: the Instagram family (launch-2026-11-20-ujai WH5) carries the send queues
    // too (feat-instagram-dm-sending P140 — no send service, so no `instagram-send` family).
    expect(parseWorkerQueueFamilies(undefined)).toHaveLength(7);
    expect(parseWorkerQueueFamilies('all')).toHaveLength(7);
    expect(parseWorkerQueueFamilies('all')).toContain('instagram');
    expect(isMonolithicWorkerQueueFamilies(parseWorkerQueueFamilies('all'))).toBe(true);
  });

  it('parses comma-separated families without duplicates', () => {
    expect(parseWorkerQueueFamilies('retention,mail,retention')).toEqual(['retention', 'mail']);
    expect(isMonolithicWorkerQueueFamilies(parseWorkerQueueFamilies('retention,mail'))).toBe(false);
  });

  it('refuses the retired send-service family, so a stale WORKER_QUEUE_FAMILIES fails at boot (P140)', () => {
    expect(() => parseWorkerQueueFamilies('instagram-send')).toThrow(
      /Invalid WORKER_QUEUE_FAMILIES/,
    );
  });
});
