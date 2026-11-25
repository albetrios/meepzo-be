import { describe, expect, it } from 'vitest';
import { serializeAppUsage } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.serializer.js';

const MONTH = { monthStart: '2026-11-01', resetsOn: '2026-12-01', used: 0 };
const ACTIVE = { state: 'active' as const, graceEndsAt: null, trialEndsAt: null };
const NOW = new Date('2026-11-24T10:00:00Z');

/** Route 64's App usage (feat-instagram-dm-sending routes-final § 6.A.6, SN15, D34). */
describe('serializeAppUsage', () => {
  it.each([
    [790, 'ok'],
    [800, 'nearly'],
    [999, 'nearly'],
    [1000, 'reached'],
    [1200, 'reached'],
  ])('used %i of 1,000 is %s', (used, state) => {
    const usage = serializeAppUsage({
      month: { ...MONTH, used },
      limit: 1000,
      accounts: { used: 1, maximum: 1 },
      hasLiveAccount: true,
      planAccess: ACTIVE,
      now: NOW,
    });
    expect(usage.direct_messages).toEqual({
      used,
      limit: 1000,
      resets_on: '2026-12-01',
      state,
    });
  });

  it('lists payment failed in a grace, plan ended while read-only and a trial that ends within 3 days', () => {
    const grace = serializeAppUsage({
      month: MONTH,
      limit: 1000,
      accounts: { used: 1, maximum: 3 },
      hasLiveAccount: true,
      planAccess: {
        state: 'grace',
        graceEndsAt: new Date('2026-11-30T00:00:00Z'),
        trialEndsAt: null,
      },
      now: NOW,
    });
    expect(grace.notices).toEqual([{ kind: 'payment_failed', ends_on: '2026-11-30' }]);
    const ended = serializeAppUsage({
      month: MONTH,
      limit: 1000,
      accounts: { used: 1, maximum: 3 },
      hasLiveAccount: true,
      planAccess: { state: 'read_only', graceEndsAt: null, trialEndsAt: null },
      now: NOW,
    });
    expect(ended.notices).toEqual([{ kind: 'plan_ended', ends_on: null }]);
    const trial = serializeAppUsage({
      month: MONTH,
      limit: 1000,
      accounts: { used: 1, maximum: 3 },
      hasLiveAccount: true,
      planAccess: { ...ACTIVE, trialEndsAt: new Date('2026-11-26T10:00:00Z') },
      now: NOW,
    });
    expect(trial.notices).toEqual([{ kind: 'trial_ending', ends_on: '2026-11-26' }]);
    const laterTrial = serializeAppUsage({
      month: MONTH,
      limit: 1000,
      accounts: { used: 1, maximum: 3 },
      hasLiveAccount: true,
      planAccess: { ...ACTIVE, trialEndsAt: new Date('2026-12-10T10:00:00Z') },
      now: NOW,
    });
    expect(laterTrial.notices).toEqual([]);
  });

  it('has no limit and stays ok with no plan in the catalog', () => {
    const usage = serializeAppUsage({
      month: { ...MONTH, used: 5000 },
      limit: null,
      accounts: { used: 1, maximum: 1 },
      hasLiveAccount: true,
      planAccess: ACTIVE,
      now: NOW,
    });
    expect(usage.direct_messages.state).toBe('ok');
    expect(usage.direct_messages.limit).toBeNull();
  });

  it('shows being_set_up while the organization has no not-revoked account (R40, plan §46)', () => {
    const usage = serializeAppUsage({
      month: MONTH,
      limit: 1000,
      accounts: { used: 0, maximum: 1 },
      hasLiveAccount: false,
      planAccess: ACTIVE,
      now: NOW,
    });
    expect(usage.notices).toEqual([{ kind: 'being_set_up', ends_on: null }]);
  });
});
