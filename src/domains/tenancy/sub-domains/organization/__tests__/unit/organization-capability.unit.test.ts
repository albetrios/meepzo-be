import { describe, expect, it } from 'vitest';
import {
  assertTeamOrganization,
  assertTeamOrganizationForRead,
  type OrganizationCapability,
} from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import { NotFoundError, UnprocessableEntityError } from '@/shared/errors/index.js';

describe('assertTeamOrganization', () => {
  it.each<OrganizationCapability>(['MEMBERS', 'ROLES', 'MUTATION', 'BILLING', 'INSTAGRAM'])(
    'is a no-op for a TEAM organization on %s',
    (capability) => {
      expect(() =>
        assertTeamOrganization({ organization: { type: 'TEAM' }, capability }),
      ).not.toThrow();
    },
  );

  it.each<[OrganizationCapability, string]>([
    ['MEMBERS', 'errors:personalOrganizationNoMembers'],
    ['ROLES', 'errors:personalOrganizationNoRoles'],
    ['MUTATION', 'errors:personalOrganizationImmutable'],
    ['BILLING', 'errors:personalOrganizationNoBilling'],
    ['INSTAGRAM', 'errors:personalOrganizationNoInstagram'],
  ])('rejects %s on a PERSONAL organization with 422 and key %s', (capability, messageKey) => {
    let caught: unknown;
    try {
      assertTeamOrganization({ organization: { type: 'PERSONAL' }, capability });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnprocessableEntityError);
    expect(caught).toMatchObject({
      statusCode: 422,
      code: 'UNPROCESSABLE_ENTITY',
      messageKey,
    });
  });
});

describe('assertTeamOrganizationForRead', () => {
  it('is a no-op for a TEAM organization', () => {
    expect(() => assertTeamOrganizationForRead({ organization: { type: 'TEAM' } })).not.toThrow();
  });

  it('rejects a PERSONAL organization with 404 and reason team_organization_required', () => {
    let caught: unknown;
    try {
      assertTeamOrganizationForRead({ organization: { type: 'PERSONAL' } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect(caught).toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
      reason: 'team_organization_required',
      messageKey: 'errors:notFound',
      messageParams: { resource: 'Team organization' },
    });
  });
});
