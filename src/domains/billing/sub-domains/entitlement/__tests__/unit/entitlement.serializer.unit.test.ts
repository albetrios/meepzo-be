import { describe, expect, it } from 'vitest';
import { serializeEntitlementOverride } from '@/domains/billing/sub-domains/entitlement/entitlement.serializer.js';
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
