import { describe, expect, it } from 'vitest';
import { CircuitBreakerOpenError } from '@/infrastructure/resilience/circuit-breaker.js';
import { readMetaGraphErrorResponse } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import {
  isMetaAdPermissionMissing,
  isMetaTokenRefused,
  planAccountLimitError,
  toChannelConnectionAdReadError,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-error.util.js';

/** A Graph error answer as the Meta client throws it. */
function metaError({ httpStatus, code }: { httpStatus: number; code: number }) {
  return readMetaGraphErrorResponse({
    httpStatus,
    body: JSON.stringify({ error: { message: 'Meta says no', type: 'OAuthException', code } }),
    retryAfterHeader: null,
  });
}

/**
 * The ad picker's Meta failures (routes 15 and 41, routes-final § 1 MC13, MC11): only code 190
 * breaks the connection; a permission code means the ad access is missing; Meta refusing route 15's
 * ad account is `404 ad_account_not_found`; an outage is `503 instagram_unavailable`.
 */
describe('channel connection ad picker errors', () => {
  it('tells the refused token (190) from a missing ad permission (10, 200–299)', () => {
    expect(isMetaTokenRefused(metaError({ httpStatus: 400, code: 190 }))).toBe(true);
    expect(isMetaAdPermissionMissing(metaError({ httpStatus: 400, code: 190 }))).toBe(false);
    expect(isMetaTokenRefused(metaError({ httpStatus: 403, code: 200 }))).toBe(false);
    expect(isMetaAdPermissionMissing(metaError({ httpStatus: 403, code: 200 }))).toBe(true);
    expect(isMetaAdPermissionMissing(new Error('ours'))).toBe(false);
  });

  it('maps each failure to its route error', () => {
    expect(
      toChannelConnectionAdReadError({
        error: metaError({ httpStatus: 400, code: 190 }),
        adAccountId: null,
      }),
    ).toMatchObject({ statusCode: 404, reason: 'instagram_reconnect_required' });
    expect(
      toChannelConnectionAdReadError({
        error: metaError({ httpStatus: 400, code: 100 }),
        adAccountId: '42',
      }),
    ).toMatchObject({ statusCode: 404, reason: 'ad_account_not_found' });
    expect(
      toChannelConnectionAdReadError({
        error: metaError({ httpStatus: 400, code: 100 }),
        adAccountId: null,
      }),
    ).toMatchObject({ statusCode: 503, reason: 'instagram_unavailable' });
    expect(
      toChannelConnectionAdReadError({
        error: metaError({ httpStatus: 500, code: 2 }),
        adAccountId: '42',
      }),
    ).toMatchObject({ statusCode: 503, reason: 'instagram_unavailable' });
    expect(
      toChannelConnectionAdReadError({
        error: new CircuitBreakerOpenError('meta', 1000, 'open'),
        adAccountId: null,
      }),
    ).toMatchObject({ statusCode: 503 });
    const ours = new Error('ours');
    expect(toChannelConnectionAdReadError({ error: ours, adAccountId: null })).toBe(ours);
  });
});

/** The account limit's refusal carries the plan refusal contract's fields (MC7, CA9, P269). */
describe('planAccountLimitError', () => {
  it('is 409 plan_account_limit with limit, used and upgrade_required', () => {
    const error = planAccountLimitError({ limit: 3, used: 3 });
    expect(error).toMatchObject({ statusCode: 409, reason: 'plan_account_limit' });
    expect(error.fields).toEqual({ limit: 3, used: 3, upgrade_required: true });
  });
});
