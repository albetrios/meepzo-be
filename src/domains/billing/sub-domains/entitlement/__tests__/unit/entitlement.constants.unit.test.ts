import { describe, expect, it } from 'vitest';
import {
  ENTITLEMENT_LIMIT_KEYS,
  ENTITLEMENT_OVERRIDE_KEYS,
  ENTITLEMENT_OVERRIDE_LIMIT_KEYS,
  ENTITLEMENT_REGISTRY,
  ENTITLEMENT_SWITCH_KEYS,
} from '@/domains/billing/sub-domains/entitlement/entitlement.constants.js';
import { PLAN_FEATURE_KEYS } from '@/domains/billing/sub-domains/plan/plan.constants.js';

/**
 * The entitlement key registry (change-plan-gates EN1, ENC1, P17–P19, P21, P36): every gated key,
 * the switches built from the plan's own list, and the override lists derived from it.
 */
describe('ENTITLEMENT_REGISTRY (EN1)', () => {
  it('holds the 11 plan switches, the 2 plan limits and seats, in that order', () => {
    expect(ENTITLEMENT_REGISTRY.map((entry) => entry.key)).toEqual([
      ...PLAN_FEATURE_KEYS,
      'message_month_limit',
      'channel_accounts_max',
      'seats',
    ]);
    expect(ENTITLEMENT_SWITCH_KEYS).toEqual([...PLAN_FEATURE_KEYS]);
    expect(ENTITLEMENT_SWITCH_KEYS).toHaveLength(11);
    expect(ENTITLEMENT_LIMIT_KEYS).toEqual([
      'message_month_limit',
      'channel_accounts_max',
      'seats',
    ]);
  });

  it('every switch is an Instagram switch, off by default and overridable (P19, P36)', () => {
    for (const entry of ENTITLEMENT_REGISTRY.filter((candidate) => candidate.kind === 'switch')) {
      expect(entry).toEqual({
        key: entry.key,
        kind: 'switch',
        product: 'instagram',
        default: false,
        overridable: true,
      });
    }
  });

  it('the two limits have no default and are overridable; seats are core, unlimited and not overridable (P18, P36)', () => {
    const byKey = new Map(ENTITLEMENT_REGISTRY.map((entry) => [entry.key, entry]));
    expect(byKey.get('message_month_limit')).toEqual({
      key: 'message_month_limit',
      kind: 'metered',
      product: 'instagram',
      default: undefined,
      overridable: true,
    });
    expect(byKey.get('channel_accounts_max')).toEqual({
      key: 'channel_accounts_max',
      kind: 'cap',
      product: 'instagram',
      default: undefined,
      overridable: true,
    });
    expect(byKey.get('seats')).toEqual({
      key: 'seats',
      kind: 'cap',
      product: 'core',
      default: null,
      overridable: false,
    });
  });
});

/**
 * The override key lists are derived from the registry but must stay the 13 keys
 * `chk_organization_entitlement_overrides_key` pins — a change here is a billing migration.
 */
describe('derived override key lists (EN1 — no migration)', () => {
  it('ENTITLEMENT_OVERRIDE_KEYS is exactly the 13 keys, in the same order as before the registry', () => {
    expect([...ENTITLEMENT_OVERRIDE_KEYS]).toEqual([
      'email_ask',
      'phone_ask',
      'reply_like_person',
      'multiple_public_reply_lines',
      'message_versions',
      'broadcasts',
      'segments',
      'past_comments',
      'extra_delay',
      'starter_questions',
      'mark_seen',
      'message_month_limit',
      'channel_accounts_max',
    ]);
  });

  it('ENTITLEMENT_OVERRIDE_LIMIT_KEYS is the two plan limits; seats are never overridable', () => {
    expect([...ENTITLEMENT_OVERRIDE_LIMIT_KEYS]).toEqual([
      'message_month_limit',
      'channel_accounts_max',
    ]);
    expect(ENTITLEMENT_OVERRIDE_KEYS).not.toContain('seats');
  });
});
