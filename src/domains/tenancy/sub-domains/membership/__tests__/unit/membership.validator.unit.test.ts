import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import {
  isInvitableEmail,
  validateCreateMembership,
  validateListMembershipsQuery,
  validateTransferOwnership,
  validateUpdateMembership,
} from '@/domains/tenancy/sub-domains/membership/membership.validator.js';

describe('membership validators', () => {
  it('validateCreateMembership accepts emails + role_ids, trims and lower-cases each, and defaults expires_in_days', () => {
    const result = validateCreateMembership({
      emails: ['  Invitee@Example.com ', 'second@example.com'],
      role_ids: ['rolepublicid1234567'],
    });
    expect(result.emails).toEqual(['invitee@example.com', 'second@example.com']);
    expect(result.role_ids).toEqual(['rolepublicid1234567']);
    expect(result.expires_in_days).toBe(7);
  });

  it('validateCreateMembership leaves a malformed address to its own line (isInvitableEmail)', () => {
    const result = validateCreateMembership({
      emails: ['not-an-email'],
      role_ids: ['rolepublicid1234567'],
    });
    expect(result.emails).toEqual(['not-an-email']);
    expect(isInvitableEmail('not-an-email')).toBe(false);
    expect(isInvitableEmail('invitee@example.com')).toBe(true);
  });

  it('validateCreateMembership refuses no address, more than 20, no role, and the staff fields', () => {
    const role_ids = ['rolepublicid1234567'];
    expect(() => validateCreateMembership({ emails: [], role_ids })).toThrow(ValidationError);
    const twentyOne = Array.from({ length: 21 }, (_, index) => `invitee-${index}@example.com`);
    expect(() => validateCreateMembership({ emails: twentyOne, role_ids })).toThrow(
      ValidationError,
    );
    expect(() =>
      validateCreateMembership({ emails: ['invitee@example.com'], role_ids: [] }),
    ).toThrow(ValidationError);
    expect(() =>
      validateCreateMembership({
        emails: ['invitee@example.com'],
        role_ids,
        phone: '+15555550100',
      }),
    ).toThrow(ValidationError);
  });

  it('validateCreateMembership rejects the single email field (route 117 takes emails)', () => {
    expect(() =>
      validateCreateMembership({ email: 'invitee@example.com', role_ids: ['rolepublicid1234567'] }),
    ).toThrow(ValidationError);
  });

  it('validateUpdateMembership accepts status', () => {
    expect(validateUpdateMembership({ status: 'active' })).toEqual({ status: 'active' });
  });

  it('validateListMembershipsQuery applies defaults', () => {
    expect(validateListMembershipsQuery({})).toMatchObject({ limit: 25 });
  });

  it('validateListMembershipsQuery accepts and trims a q search term', () => {
    expect(validateListMembershipsQuery({ q: '  alice  ' })).toMatchObject({ q: 'alice' });
  });

  it('validateListMembershipsQuery rejects an over-long q term and unknown keys (strict)', () => {
    expect(() => validateListMembershipsQuery({ q: 'a'.repeat(201) })).toThrow(ValidationError);
    expect(() => validateListMembershipsQuery({ bogus: 1 })).toThrow(ValidationError);
  });

  it('validateListMembershipsQuery rejects rejects a page query parameter (cursor-only, strict query)', () => {
    // `page` is not a parameter of any list query — the strict schema refuses it like any other
    // unknown key.
    expect(() => validateListMembershipsQuery({ page: '1', limit: '10' })).toThrow(ValidationError);
  });

  it('validateTransferOwnership accepts new_owner_user_id', () => {
    expect(validateTransferOwnership({ new_owner_user_id: 'newownerpublicid12' })).toEqual({
      new_owner_user_id: 'newownerpublicid12',
    });
  });

  it('validateCreateMembership throws for missing fields', () => {
    expect(() => validateCreateMembership({})).toThrow(ValidationError);
  });

  it('validateUpdateMembership rejects invalid status', () => {
    expect(() => validateUpdateMembership({ status: 'DELETED' })).toThrow(ValidationError);
  });

  it('validateUpdateMembership accepts a role_ids-only update (REQ-3)', () => {
    expect(validateUpdateMembership({ role_ids: ['rolepublicid1234567'] })).toMatchObject({
      role_ids: ['rolepublicid1234567'],
    });
  });

  it('validateUpdateMembership accepts status + role_ids together (REQ-3)', () => {
    expect(
      validateUpdateMembership({ status: 'suspended', role_ids: ['rolepublicid1234567'] }),
    ).toMatchObject({ status: 'suspended', role_ids: ['rolepublicid1234567'] });
  });

  it('validateUpdateMembership rejects an empty body (at least one of status/role_id)', () => {
    expect(() => validateUpdateMembership({})).toThrow(ValidationError);
  });
});
