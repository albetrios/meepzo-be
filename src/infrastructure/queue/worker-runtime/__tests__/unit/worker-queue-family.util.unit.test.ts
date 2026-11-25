import { describe, expect, it } from 'vitest';
import {
  isMonolithicWorkerQueueFamilies,
  parseWorkerQueueFamilies,
} from '@/infrastructure/queue/worker-runtime/worker-queue-family.util.js';

describe('worker-queue-family.util', () => {
  it('returns all families when unset or all', () => {
    // Eight families: the Instagram family (launch-2026-11-20-ujai WH5) and the send service's
    // `instagram-send` (feat-instagram-dm-sending SN2, SN24).
    expect(parseWorkerQueueFamilies(undefined)).toHaveLength(8);
    expect(parseWorkerQueueFamilies('all')).toHaveLength(8);
    expect(parseWorkerQueueFamilies('all')).toContain('instagram');
    expect(parseWorkerQueueFamilies('all')).toContain('instagram-send');
    expect(isMonolithicWorkerQueueFamilies(parseWorkerQueueFamilies('all'))).toBe(true);
  });

  it('parses comma-separated families without duplicates', () => {
    expect(parseWorkerQueueFamilies('retention,mail,retention')).toEqual(['retention', 'mail']);
    expect(isMonolithicWorkerQueueFamilies(parseWorkerQueueFamilies('retention,mail'))).toBe(false);
  });

  it('selects the send service on its own (SN24)', () => {
    expect(parseWorkerQueueFamilies('instagram-send')).toEqual(['instagram-send']);
  });
});
