import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  ORGANIZATION_CURRENCY,
  ORGANIZATION_DEFAULT_TIMEZONE,
} from '@/domains/tenancy/sub-domains/organization/organization.constants.js';

/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';

/**
 * The organization profile on `tenancy.organizations` (launch ROUTE #1): the column defaults match
 * the constants the services read, and every CHECK rejects what it should. Fixtures and
 * assertions run on the operator connection, so the suite holds in the RLS-role lane too.
 */
describe('Integration: organization profile fields', () => {
  let organizationId: number;

  beforeEach(async () => {
    await cleanupDatabase();
    const owner = await createTestUser({ email: 'profile-owner@example.com' });
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    organizationId = organization.id;
  });

  it('gives a new organization the launch profile', async () => {
    const [row] = await operatorQuery<
      { timezone: string; currency: string }[]
    >`SELECT timezone, currency FROM tenancy.organizations WHERE id = ${organizationId}`;

    expect(row).toEqual({
      timezone: ORGANIZATION_DEFAULT_TIMEZONE,
      currency: ORGANIZATION_CURRENCY,
    });
  });

  it.each([
    [
      'a currency other than INR',
      `UPDATE tenancy.organizations SET currency = 'USD' WHERE id = $1`,
    ],
  ])('rejects %s on the organization', async (_case, statement) => {
    await expect(operatorQuery.unsafe(statement, [organizationId])).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });
});
