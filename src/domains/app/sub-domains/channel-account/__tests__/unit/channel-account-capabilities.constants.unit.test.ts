import { describe, expect, it } from 'vitest';
import { PLAN_FEATURE_KEYS } from '@/domains/billing/sub-domains/plan/plan.constants.js';
import {
  CHANNEL_ACCOUNT_CHANNELS,
  CHANNEL_ACCOUNT_PLAN_STOP_REASON,
} from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import {
  APP_UNTESTED_META_FEATURES,
  INSTAGRAM_SEND_STOP_REASONS,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import {
  CHANNEL_ACCOUNT_BLOCKER_FIXES,
  CHANNEL_ACCOUNT_BLOCKERS,
  CHANNEL_CAPABILITIES,
  CHANNEL_FEATURE_REFUSAL_FIXES,
  CHANNEL_FEATURE_REFUSAL_REASONS,
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

describe('the capability read fixes (feat-meta-connect-flow AC2, AC3)', () => {
  it('gives every refusal reason and every blocker a fix', () => {
    expect(Object.keys(CHANNEL_FEATURE_REFUSAL_FIXES).sort()).toEqual(
      [...CHANNEL_FEATURE_REFUSAL_REASONS].sort(),
    );
    expect(Object.keys(CHANNEL_ACCOUNT_BLOCKER_FIXES).sort()).toEqual(
      [...CHANNEL_ACCOUNT_BLOCKERS].sort(),
    );
  });

  it('names every lane stop and every plan stop as a blocker, so route 153 never hides one', () => {
    const blockers = new Set<string>(CHANNEL_ACCOUNT_BLOCKERS);
    for (const reason of INSTAGRAM_SEND_STOP_REASONS) expect(blockers.has(reason)).toBe(true);
    for (const reason of Object.values(CHANNEL_ACCOUNT_PLAN_STOP_REASON)) {
      expect(blockers.has(reason)).toBe(true);
    }
  });
});
