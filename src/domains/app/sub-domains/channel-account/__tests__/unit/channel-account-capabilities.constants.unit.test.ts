import { describe, expect, it } from 'vitest';
import { PLAN_FEATURE_KEYS } from '@/domains/billing/sub-domains/plan/plan.constants.js';
import { CHANNEL_ACCOUNT_CHANNELS } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import {
  APP_UNTESTED_META_FEATURES,
  CHANNEL_CAPABILITIES,
  CHANNEL_FEATURE_KEYS,
  CHANNEL_FEATURES,
} from '@/domains/app/sub-domains/channel-account/channel-account-capabilities.constants.js';

describe('the capability list and the plan switches (CA11, P83, P103)', () => {
  it('names exactly the plan switches billing has: the two sets agree (BL12)', () => {
    const switches = Object.values(CHANNEL_FEATURES).map((requirement) => requirement.planSwitch);
    expect(new Set(switches)).toEqual(new Set(PLAN_FEATURE_KEYS));
    expect(new Set(CHANNEL_FEATURE_KEYS)).toEqual(new Set(PLAN_FEATURE_KEYS));
  });

  it('describes every feature and gives every channel an entry', () => {
    expect(Object.keys(CHANNEL_FEATURES).sort()).toEqual([...CHANNEL_FEATURE_KEYS].sort());
    expect(Object.keys(CHANNEL_CAPABILITIES).sort()).toEqual([...CHANNEL_ACCOUNT_CHANNELS].sort());
    expect(CHANNEL_CAPABILITIES.instagram.triggerTypes).toHaveLength(15);
  });

  it('lists as untested only features that wait for Meta’s test (P36)', () => {
    for (const feature of APP_UNTESTED_META_FEATURES) {
      expect(CHANNEL_FEATURES[feature].isMetaTestRequired).toBe(true);
    }
  });
});
