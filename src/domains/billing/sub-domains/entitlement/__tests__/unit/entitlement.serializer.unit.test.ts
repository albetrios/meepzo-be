import { describe, expect, it } from 'vitest';
import {
  serializeEntitlementOverride,
  serializeEntitlements,
} from '@/domains/billing/sub-domains/entitlement/entitlement.serializer.js';
import { CREATOR_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import type { OrganizationEntitlementOverrideRow } from '@/domains/billing/sub-domains/entitlement/entitlement-override.schema.js';

const NOW = new Date('2026-11-26T12:00:00.000Z');

function row(overrides: Partial<OrganizationEntitlementOverrideRow> = {}) {
  return {
    id: 7,
    public_id: 'ovr_a1b2c3d4e5f6g7h8i9j0k',
    organization_id: 3,
    key: 'broadcasts',
    value: true,
    expires_at: null,
    reason: 'Support deal',
    created_by_user_id: 1,
    updated_by_user_id: 1,
    deleted_at: null,
    created_at: new Date('2026-11-20T00:00:00.000Z'),
    updated_at: new Date('2026-11-21T00:00:00.000Z'),
    ...overrides,
  } satisfies OrganizationEntitlementOverrideRow;
}

/** The admin override body (P270): public ids only, ISO times, `is_active` at `now`. */
describe('serializeEntitlementOverride', () => {
  it('shapes the row with the organization public id and no internal id', () => {
    const body = serializeEntitlementOverride({
      row: row(),
      organization_public_id: 'org_a1b2c3d4e5f6g7h8i9j0k',
      now: NOW,
    });
    expect(body).toEqual({
      id: 'ovr_a1b2c3d4e5f6g7h8i9j0k',
      organization_id: 'org_a1b2c3d4e5f6g7h8i9j0k',
      key: 'broadcasts',
      value: true,
      expires_at: null,
      is_active: true,
      reason: 'Support deal',
      created_at: '2026-11-20T00:00:00.000Z',
      updated_at: '2026-11-21T00:00:00.000Z',
    });
  });

  it('is not active once expired or removed', () => {
    const organization_public_id = 'org_a1b2c3d4e5f6g7h8i9j0k';
    expect(
      serializeEntitlementOverride({
        row: row({ expires_at: new Date('2026-11-25T00:00:00.000Z') }),
        organization_public_id,
        now: NOW,
      }),
    ).toMatchObject({ is_active: false, expires_at: '2026-11-25T00:00:00.000Z' });
    expect(
      serializeEntitlementOverride({
        row: row({ deleted_at: NOW }),
        organization_public_id,
        now: NOW,
      }).is_active,
    ).toBe(false);
  });
});

/** `GET /billing/entitlements` (P271): the one plan read, the usage and the members, shaped. */
describe('serializeEntitlements', () => {
  const planAccess = {
    state: 'grace' as const,
    graceEndsAt: new Date('2026-12-10T00:00:00.000Z'),
    trialEndsAt: null,
    plan: { publicId: 'pln_creator', name: 'Creator' },
    features: { ...CREATOR_PLAN_FEATURES, channel_accounts_max: 7 },
    seatLimit: null,
    overrides: [
      {
        key: 'channel_accounts_max' as const,
        value: 7,
        expiresAt: new Date('2026-12-31T00:00:00.000Z'),
      },
    ],
    isPlanChoiceRequired: false,
  };

  it('answers the limits from the merged features, the usage, the dates and the overrides', () => {
    expect(
      serializeEntitlements({
        plan_access: planAccess,
        usage: {
          directMessagesUsed: 120,
          directMessagesResetsOn: '2026-12-01',
          channelAccountsUsed: 2,
        },
        seats_used: 4,
      }),
    ).toEqual({
      state: 'grace',
      plan: { id: 'pln_creator', name: 'Creator' },
      features: planAccess.features,
      limits: {
        direct_messages: {
          used: 120,
          limit: CREATOR_PLAN_FEATURES.message_month_limit,
          resets_on: '2026-12-01',
        },
        channel_accounts: { used: 2, limit: 7 },
        seats: { used: 4, limit: null },
      },
      trial_ends_at: null,
      grace_ends_at: '2026-12-10T00:00:00.000Z',
      is_plan_choice_required: false,
      overrides: [{ key: 'channel_accounts_max', expires_at: '2026-12-31T00:00:00.000Z' }],
    });
  });

  it('has no limits without a plan in the catalog', () => {
    const output = serializeEntitlements({
      plan_access: { ...planAccess, plan: null, features: null, overrides: [] },
      usage: {
        directMessagesUsed: 0,
        directMessagesResetsOn: '2026-12-01',
        channelAccountsUsed: 0,
      },
      seats_used: 1,
    });
    expect(output.plan).toBeNull();
    expect(output.limits.direct_messages.limit).toBeNull();
    expect(output.limits.channel_accounts.limit).toBeNull();
  });
});
