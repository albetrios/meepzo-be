import { describe, expect, it } from 'vitest';
import {
  isMonolithicWorkerQueueFamilies,
  parseWorkerQueueFamilies,
} from '@/infrastructure/queue/worker-runtime/worker-queue-family.util.js';

describe('worker-queue-family.util', () => {
  it('returns all families when unset or all', () => {
    // Seven families since the Instagram family (launch-2026-11-20-ujai WH5).
    expect(parseWorkerQueueFamilies(undefined)).toHaveLength(7);
    expect(parseWorkerQueueFamilies('all')).toHaveLength(7);
    expect(parseWorkerQueueFamilies('all')).toContain('instagram');
    expect(isMonolithicWorkerQueueFamilies(parseWorkerQueueFamilies('all'))).toBe(true);
  });

  it('parses comma-separated families without duplicates', () => {
    expect(parseWorkerQueueFamilies('retention,mail,retention')).toEqual(['retention', 'mail']);
    expect(isMonolithicWorkerQueueFamilies(parseWorkerQueueFamilies('retention,mail'))).toBe(false);
  });
});
