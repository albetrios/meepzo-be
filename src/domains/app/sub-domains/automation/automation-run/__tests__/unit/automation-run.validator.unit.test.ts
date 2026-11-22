import { describe, expect, it } from 'vitest';
import {
  assertQueuedAutomations,
  readQueuedAutomations,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run.validator.js';
import type { AutomationQueuedEntry } from '@/domains/app/sub-domains/automation/automation-run/automation-run.types.js';

/**
 * The queued-automation shape (routes-final § 3.B AU21, schema-routes § 10): strict, public ids
 * only, one entry per automation, at most 100 — checked before every save; a stored list is read
 * entry by entry so one malformed entry never stops the others (3.B.9).
 */

function entry(overrides: Partial<AutomationQueuedEntry> = {}): AutomationQueuedEntry {
  return {
    automation_id: 'aut_k7x9m2pqr4w8n1v3a1b2c',
    queued_at: '2026-11-21T12:00:00.000Z',
    trigger: {
      type: 'comment',
      instagram_media_id: '17900000000000001',
      instagram_comment_id: '17950000000000001',
      text: 'link please',
    },
    ...overrides,
  };
}

describe('assertQueuedAutomations (AU21)', () => {
  it('accepts a comment, a story reply and a DM trigger', () => {
    const entries = [
      entry(),
      entry({
        automation_id: 'aut_a1b2c3d4e5f6g7h8i9j0k',
        trigger: { type: 'story_reply', instagram_story_id: '17910000000000001', text: null },
      }),
      entry({ automation_id: 'aut_k0j9i8h7g6f5e4d3c2b1a', trigger: { type: 'dm', text: 'hi' } }),
    ];
    expect(assertQueuedAutomations(entries)).toEqual(entries);
  });

  it.each([
    ['an unknown key', { ...entry(), extra: true }],
    ['a malformed automation id', entry({ automation_id: 'automation-1' })],
    [
      'a comment trigger without its comment id',
      entry({ trigger: { type: 'comment', text: 'x' } }),
    ],
    [
      'a story trigger without its story id',
      entry({ trigger: { type: 'story_reply', text: 'x' } }),
    ],
    [
      'an Instagram id that is not digits',
      entry({ trigger: { ...entry().trigger, instagram_media_id: 'abc' } }),
    ],
    ['an unknown trigger key', entry({ trigger: { ...entry().trigger, url: 'x' } as never })],
  ])('refuses %s', (_label, value) => {
    expect(() => assertQueuedAutomations([value as AutomationQueuedEntry])).toThrow();
  });

  it('refuses two entries for one automation, and more than 100', () => {
    expect(() => assertQueuedAutomations([entry(), entry()])).toThrow();
    const many = Array.from({ length: 101 }, (_unused, index) =>
      entry({ automation_id: `aut_${String(index).padStart(21, '0')}` }),
    );
    expect(() => assertQueuedAutomations(many)).toThrow();
  });
});

describe('readQueuedAutomations (3.B.9)', () => {
  it('keeps every well-formed entry in order and counts the malformed ones', () => {
    const first = entry();
    const second = entry({ automation_id: 'aut_a1b2c3d4e5f6g7h8i9j0k' });
    expect(readQueuedAutomations([first, { broken: true }, second])).toEqual({
      entries: [first, second],
      malformedCount: 1,
    });
  });

  it('reads a value that is not a list as empty', () => {
    expect(readQueuedAutomations({})).toEqual({ entries: [], malformedCount: 0 });
  });
});
