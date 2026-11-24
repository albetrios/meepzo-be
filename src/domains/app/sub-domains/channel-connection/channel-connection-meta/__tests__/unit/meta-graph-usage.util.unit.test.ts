import { describe, expect, it } from 'vitest';
import {
  decideMetaUsagePace,
  parseMetaGraphUsage,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-usage.util.js';

const READ_AT = new Date('2026-11-24T10:00:00.000Z');
const MINUTE = 60_000;

/** Headers with Meta's business use-case usage for one asset. */
function businessUsageHeaders(entries: unknown[], assetId = '1784001'): Headers {
  return new Headers({ 'x-business-use-case-usage': JSON.stringify({ [assetId]: entries }) });
}

describe('parseMetaGraphUsage', () => {
  it('keeps one entry per asset and type with the highest of the three counters', () => {
    const reading = parseMetaGraphUsage({
      headers: new Headers({
        'x-business-use-case-usage': JSON.stringify({
          '1784001': [
            { type: 'instagram', call_count: 12, total_cputime: 81.2, total_time: 40 },
            { type: 'MESSENGER', call_count: 3, total_cputime: 1, total_time: 2 },
          ],
          '5550001': [{ type: 'ads_management', call_count: 50, total_cputime: 0, total_time: 0 }],
        }),
      }),
      readAt: READ_AT,
    });

    expect(reading).toEqual({
      readAt: READ_AT,
      appUsagePercent: null,
      businessUseCases: [
        { assetId: '1784001', type: 'instagram', usagePercent: 82, waitUntil: null },
        { assetId: '1784001', type: 'messenger', usagePercent: 3, waitUntil: null },
        { assetId: '5550001', type: 'ads_management', usagePercent: 50, waitUntil: null },
      ],
    });
  });

  it('waits the time Meta gives to regain access, even under 95 %', () => {
    const reading = parseMetaGraphUsage({
      headers: businessUsageHeaders([
        { type: 'instagram', call_count: 90, estimated_time_to_regain_access: 7 },
      ]),
      readAt: READ_AT,
    });
    expect(reading?.businessUseCases[0]?.waitUntil).toEqual(
      new Date(READ_AT.getTime() + 7 * MINUTE),
    );
  });

  it('waits 15 minutes at 95 % when Meta names no time', () => {
    const reading = parseMetaGraphUsage({
      headers: businessUsageHeaders([
        { type: 'instagram', call_count: 95, estimated_time_to_regain_access: 0 },
      ]),
      readAt: READ_AT,
    });
    expect(reading?.businessUseCases[0]?.waitUntil).toEqual(
      new Date(READ_AT.getTime() + 15 * MINUTE),
    );
  });

  it('caps a percentage at 100', () => {
    const reading = parseMetaGraphUsage({
      headers: businessUsageHeaders([{ type: 'instagram', call_count: 130 }]),
      readAt: READ_AT,
    });
    expect(reading?.businessUseCases[0]?.usagePercent).toBe(100);
  });

  it('reads the app-level usage on its own', () => {
    const reading = parseMetaGraphUsage({
      headers: new Headers({
        'x-app-usage': JSON.stringify({ call_count: 20, total_cputime: 5, total_time: 61 }),
      }),
      readAt: READ_AT,
    });
    expect(reading).toEqual({ readAt: READ_AT, businessUseCases: [], appUsagePercent: 61 });
  });

  it.each([
    ['no usage header', new Headers()],
    ['an empty header', new Headers({ 'x-business-use-case-usage': '' })],
    ['a header that is not JSON', new Headers({ 'x-business-use-case-usage': 'not-json' })],
    ['a header that is a list', new Headers({ 'x-app-usage': '[1,2]' })],
    [
      'entries without a type or counter',
      businessUsageHeaders([{ call_count: 10 }, { type: 'instagram' }, 'text']),
    ],
  ])('changes nothing with %s', (_label, headers) => {
    expect(parseMetaGraphUsage({ headers, readAt: READ_AT })).toBeNull();
  });
});

describe('decideMetaUsagePace', () => {
  const now = READ_AT;

  it('goes normally under 80 %', () => {
    expect(decideMetaUsagePace({ usagePercent: 79, waitUntil: null, now })).toEqual({
      pace: 'normal',
      waitUntil: null,
    });
  });

  it('slows at 80 %', () => {
    expect(decideMetaUsagePace({ usagePercent: 80, waitUntil: null, now })).toEqual({
      pace: 'slow',
      waitUntil: null,
    });
  });

  it('waits until the time while it is ahead', () => {
    const waitUntil = new Date(now.getTime() + 15 * MINUTE);
    expect(decideMetaUsagePace({ usagePercent: 96, waitUntil, now })).toEqual({
      pace: 'wait',
      waitUntil,
    });
  });

  it('never waits on a time that has passed — it slows instead', () => {
    const waitUntil = new Date(now.getTime() - MINUTE);
    expect(decideMetaUsagePace({ usagePercent: 96, waitUntil, now })).toEqual({
      pace: 'slow',
      waitUntil: null,
    });
  });
});
