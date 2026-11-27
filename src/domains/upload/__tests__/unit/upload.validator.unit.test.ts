import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import { validateCreateUpload } from '@/domains/upload/upload.validator.js';
import { createUploadDto } from '@/domains/upload/upload.dto.js';

describe('upload.validator', () => {
  it('validateCreateUpload accepts valid upload input', () => {
    const input = {
      purpose: 'avatar',
      for: 'user',
      content_type: 'image/png',
      file_name: 'photo.png',
      file_size: 1024,
    };
    expect(validateCreateUpload(input)).toEqual(input);
  });

  it('validateCreateUpload throws for invalid purpose', () => {
    expect(() =>
      validateCreateUpload({
        purpose: 'invalid',
        for: 'user',
        content_type: 'image/png',
        file_name: 'photo.png',
        file_size: 1024,
      }),
    ).toThrow(ValidationError);
  });

  it('validateCreateUpload throws for missing required fields', () => {
    expect(() => validateCreateUpload({})).toThrow(ValidationError);
  });

  it('validateCreateUpload rejects non-positive file_size', () => {
    expect(() =>
      validateCreateUpload({
        purpose: 'avatar',
        for: 'user',
        content_type: 'image/png',
        file_name: 'photo.png',
        file_size: 0,
      }),
    ).toThrow(ValidationError);
  });

  it('validateCreateUpload rejects strict unknown keys', () => {
    expect(() =>
      validateCreateUpload({
        purpose: 'avatar',
        for: 'user',
        content_type: 'image/png',
        file_name: 'photo.png',
        file_size: 1024,
        extra: true,
      }),
    ).toThrow(ValidationError);
  });

  it('route-audit L3: rejects a purpose/target mismatch (organization-logo with for=user)', () => {
    // Pre-fix this passed validation and built an `organization-logos/undefined/...` key on a
    // user-scoped row. The purpose↔target cross-check now rejects it before key construction.
    expect(() =>
      validateCreateUpload({
        purpose: 'organization-logo',
        for: 'user',
        content_type: 'image/png',
        file_name: 'logo.png',
        file_size: 1024,
      }),
    ).toThrow(ValidationError);
  });

  it('route-audit L3: rejects avatar with for=organization', () => {
    expect(() =>
      validateCreateUpload({
        purpose: 'avatar',
        for: 'organization',
        organization_id: 'org_abcdefghijklmnopqrstu',
        content_type: 'image/png',
        file_name: 'photo.png',
        file_size: 1024,
      }),
    ).toThrow(ValidationError);
  });

  it('route-audit L3: accepts a matching organization purpose/target', () => {
    const input = {
      purpose: 'organization-logo',
      for: 'organization',
      organization_id: 'org_abcdefghijklmnopqrstu',
      content_type: 'image/png',
      file_name: 'logo.png',
      file_size: 1024,
    };
    expect(validateCreateUpload(input)).toEqual(input);
  });
});

describe('createUploadDto purpose list', () => {
  it('refuses the server-only instagram-inbound-media purpose (feat-instagram-inbox R6, I-D7)', () => {
    const result = createUploadDto.safeParse({
      purpose: 'instagram-inbound-media',
      for: 'organization',
      file_name: 'photo.jpg',
      content_type: 'image/jpeg',
      file_size: 1024,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === 'purpose')).toBe(true);
  });
});
