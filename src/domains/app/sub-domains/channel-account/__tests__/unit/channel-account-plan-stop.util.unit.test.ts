import { describe, expect, it } from 'vitest';
import { pickChannelAccountsInPlan } from '@/domains/app/sub-domains/channel-account/channel-account-plan-stop.util.js';
import { isWeakerPlanStop } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-plan-change.processor.js';

type Stop = 'plan_limit' | 'plan_ended' | 'plan_downgrade' | null;
const account = (id: number, plan_stop_reason: Stop = null) => ({
  id,
  public_id: `cha_${String(id).padStart(21, '0')}`,
  plan_stop_reason,
});

/**
 * feat-instagram-dm-sending ROUTE row R52 — WC-38, BL6, D57: which accounts stay in the plan after
 * a plan change, and which moves wake the lanes.
 */
describe('pickChannelAccountsInPlan (WC-38, BL6)', () => {
  const live = [account(1), account(2), account(3)];

  it('keeps the oldest connected on a move down with no pick', () => {
    const picked = pickChannelAccountsInPlan({
      live,
      accountsMax: 1,
      keptChannelAccountPublicIds: null,
      mayActivate: false,
    });
    expect([...picked]).toEqual([1]);
  });

  it('keeps the owner pick first; a kept account that is gone is skipped and the next oldest fills in', () => {
    const picked = pickChannelAccountsInPlan({
      live,
      accountsMax: 2,
      keptChannelAccountPublicIds: [account(3).public_id, 'cha_gone00000000000000000'],
      mayActivate: false,
    });
    expect([...picked].sort()).toEqual([1, 3]);
  });

  it('lets plan_downgrade accounts back on a move up, up to the new limit', () => {
    const stopped = [account(1), account(2, 'plan_downgrade'), account(3, 'plan_downgrade')];
    expect([
      ...pickChannelAccountsInPlan({
        live: stopped,
        accountsMax: 10,
        keptChannelAccountPublicIds: null,
        mayActivate: true,
      }),
    ]).toEqual([1, 2, 3]);
    expect([
      ...pickChannelAccountsInPlan({
        live: stopped,
        accountsMax: 2,
        keptChannelAccountPublicIds: null,
        mayActivate: true,
      }),
    ]).toEqual([1, 2]);
  });

  it('never brings a plan_downgrade account back without a move up (the backup, the month wake)', () => {
    const stopped = [account(1), account(2, 'plan_downgrade')];
    expect([
      ...pickChannelAccountsInPlan({
        live: stopped,
        accountsMax: 5,
        keptChannelAccountPublicIds: null,
        mayActivate: false,
      }),
    ]).toEqual([1]);
  });
});

describe('isWeakerPlanStop (WC-37)', () => {
  it('wakes when the stop got weaker, never when it got stronger or moved sideways', () => {
    expect(isWeakerPlanStop({ from: 'plan_ended', to: null })).toBe(true);
    expect(isWeakerPlanStop({ from: 'plan_ended', to: 'plan_limit' })).toBe(true);
    expect(isWeakerPlanStop({ from: 'plan_downgrade', to: null })).toBe(true);
    expect(isWeakerPlanStop({ from: 'plan_limit', to: null })).toBe(true);
    expect(isWeakerPlanStop({ from: null, to: 'plan_ended' })).toBe(false);
    expect(isWeakerPlanStop({ from: 'plan_limit', to: 'plan_ended' })).toBe(false);
  });
});
