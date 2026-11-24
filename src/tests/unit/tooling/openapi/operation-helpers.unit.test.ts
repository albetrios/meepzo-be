import { describe, expect, it } from 'vitest';
import {
  generateOperationId,
  getRequestBodySchema,
  inferTagFromPath,
} from '@tooling/openapi/emitters/operation-helpers.js';

type DocumentedField = { description?: string; example?: unknown };

/** One request-body property as the document describes it. */
function bodyField(options: { method: string; path: string; field: string }): DocumentedField {
  const schema = getRequestBodySchema(options.method, options.path) as {
    properties: Record<string, DocumentedField>;
  };
  return schema.properties[options.field] ?? {};
}

describe('operation-helpers', () => {
  it('generateOperationId builds camelCase operation ids', () => {
    expect(generateOperationId('GET', '/api/v1/auth/me')).toMatch(/^getAuth/i);
    expect(generateOperationId('POST', '/api/v1/tenancy/organization/invitations')).toMatch(
      /^postTenancy/i,
    );
  });

  it('inferTagFromPath title-cases the first API segment', () => {
    expect(inferTagFromPath('/api/v1/auth/email/login')).toBe('Auth');
    expect(inferTagFromPath('/readyz')).toBe('General');
  });

  it('describes the MFA code as a TOTP code', () => {
    const mfaCode = bodyField({
      method: 'POST',
      path: '/api/v1/auth/me/mfa/verify',
      field: 'code',
    });
    expect(mfaCode.description).toContain('TOTP verification code');
  });
});
