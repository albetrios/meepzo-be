import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import {
  getUploadMaxSizeForContentType,
  MESSAGE_AUDIO_MAX_BYTES,
  MESSAGE_FILE_MAX_BYTES,
  MESSAGE_IMAGE_MAX_BYTES,
  UPLOAD_DTO_FILE_SIZE_MAX_BYTES,
  UPLOAD_PURPOSE_CONFIG,
  UPLOAD_PURPOSE_REQUIRED_TARGET,
  UPLOAD_PURPOSES,
} from '@/domains/upload/upload.constants.js';
import {
  getAllowedContentTypesForPurpose,
  getAllowedExtensionsForContentType,
} from '@/domains/upload/utils/upload-content-type.util.js';
import { validateCreateUpload } from '@/domains/upload/upload.validator.js';
import { isMagicByteVerifiable } from '@/shared/utils/validation/file-magic.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

// The content-type util reads `env.UPLOAD_ALLOW_SVG` at call time.
const { environmentMock } = vi.hoisted(() => ({ environmentMock: { UPLOAD_ALLOW_SVG: false } }));
vi.mock('@/shared/config/env.config.js', () => ({
  env: environmentMock,
  getEnv: () => environmentMock,
}));

const MESSAGE_MEDIA = UPLOAD_PURPOSES.MESSAGE_MEDIA;
const organizationPublicId = generatePublicId('organization');

/** One `message-media` create body; override what a case varies. */
function messageUpload(overrides: Record<string, unknown>) {
  return {
    purpose: MESSAGE_MEDIA,
    for: 'organization',
    organization_id: organizationPublicId,
    content_type: 'image/png',
    file_name: 'picture.png',
    file_size: 1024,
    ...overrides,
  };
}

/** The `errors[].field` of the ValidationError `run` throws. */
function refusedField(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).errors?.[0]?.field;
  }
  throw new Error('expected a ValidationError');
}

/**
 * The `message-media` purpose (routes-final § 12 UP1–UP4, UPC1–UPC2): the files an Instagram
 * message carries, capped per type, organization-only, and every type checkable by its bytes.
 */
describe('message-media upload purpose', () => {
  afterEach(() => {
    environmentMock.UPLOAD_ALLOW_SVG = false;
  });

  it('every message-media type is magic-byte verifiable (no file is used unchecked)', () => {
    const config = UPLOAD_PURPOSE_CONFIG[MESSAGE_MEDIA];
    expect(config.magicByteVerifiedTypesOnly).toBe(true);
    for (const contentType of config.allowedTypes) {
      expect(isMagicByteVerifiable(contentType), contentType).toBe(true);
    }
  });

  it('every purpose that requires verified types holds only verifiable types', () => {
    for (const config of Object.values(UPLOAD_PURPOSE_CONFIG)) {
      if (config.magicByteVerifiedTypesOnly !== true) continue;
      expect(config.allowedTypes.every(isMagicByteVerifiable)).toBe(true);
    }
  });

  it('never takes SVG, even when UPLOAD_ALLOW_SVG is on', () => {
    environmentMock.UPLOAD_ALLOW_SVG = true;
    expect(getAllowedContentTypesForPurpose(MESSAGE_MEDIA)).not.toContain('image/svg+xml');
    // Other image purposes still gain SVG under the flag.
    expect(getAllowedContentTypesForPurpose(UPLOAD_PURPOSES.ORGANIZATION_FILE)).toContain(
      'image/svg+xml',
    );
  });

  it('targets the organization', () => {
    expect(UPLOAD_PURPOSE_REQUIRED_TARGET[MESSAGE_MEDIA]).toBe('organization');
  });

  it('caps each type: images 8 MB, audio and PDF 25 MB; the DTO ceiling is the highest cap', () => {
    expect(MESSAGE_IMAGE_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(MESSAGE_AUDIO_MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(MESSAGE_FILE_MAX_BYTES).toBe(25 * 1024 * 1024);
    const caps = Object.values(UPLOAD_PURPOSE_CONFIG).flatMap((config) => [
      config.maxSize,
      ...Object.values(config.maxSizeByContentType ?? {}),
    ]);
    expect(UPLOAD_DTO_FILE_SIZE_MAX_BYTES).toBe(Math.max(...caps));
    expect(
      getUploadMaxSizeForContentType({ purpose: MESSAGE_MEDIA, contentType: 'image/jpeg' }),
    ).toBe(MESSAGE_IMAGE_MAX_BYTES);
    // A purpose without per-type caps keeps its own cap.
    expect(
      getUploadMaxSizeForContentType({
        purpose: UPLOAD_PURPOSES.ORGANIZATION_FILE,
        contentType: 'application/pdf',
      }),
    ).toBe(UPLOAD_PURPOSE_CONFIG[UPLOAD_PURPOSES.ORGANIZATION_FILE].maxSize);
  });

  it('maps the audio types to their extensions (.m4a for both mp4 forms)', () => {
    expect(getAllowedExtensionsForContentType('audio/aac')).toEqual(['.aac']);
    expect(getAllowedExtensionsForContentType('audio/mp4')).toEqual(['.m4a', '.mp4']);
    expect(getAllowedExtensionsForContentType('audio/x-m4a')).toEqual(['.m4a']);
    expect(getAllowedExtensionsForContentType('audio/wav')).toEqual(['.wav']);
  });

  describe('validateCreateUpload', () => {
    it.each([
      ['image/png', 'picture.png', MESSAGE_IMAGE_MAX_BYTES],
      ['image/jpeg', 'picture.jpg', MESSAGE_IMAGE_MAX_BYTES],
      ['audio/aac', 'voice.aac', MESSAGE_AUDIO_MAX_BYTES],
      ['audio/mp4', 'voice.m4a', MESSAGE_AUDIO_MAX_BYTES],
      ['audio/x-m4a', 'voice.m4a', MESSAGE_AUDIO_MAX_BYTES],
      ['audio/wav', 'voice.wav', MESSAGE_AUDIO_MAX_BYTES],
      ['application/pdf', 'menu.pdf', MESSAGE_FILE_MAX_BYTES],
    ])('accepts %s at its cap and refuses one byte over', (contentType, fileName, cap) => {
      const body = { content_type: contentType, file_name: fileName };
      expect(validateCreateUpload(messageUpload({ ...body, file_size: cap }))).toMatchObject({
        purpose: MESSAGE_MEDIA,
        content_type: contentType,
      });
      expect(
        refusedField(() => validateCreateUpload(messageUpload({ ...body, file_size: cap + 1 }))),
      ).toBe('file_size');
    });

    it.each([
      ['image/webp', 'picture.webp'],
      ['image/svg+xml', 'picture.svg'],
      ['audio/ogg', 'voice.ogg'],
    ])('refuses %s', (contentType, fileName) => {
      environmentMock.UPLOAD_ALLOW_SVG = true;
      expect(
        refusedField(() =>
          validateCreateUpload(messageUpload({ content_type: contentType, file_name: fileName })),
        ),
      ).toBe('content_type');
    });

    it('refuses a personal (user-target) message file', () => {
      expect(
        refusedField(() =>
          validateCreateUpload(messageUpload({ for: 'user', organization_id: undefined })),
        ),
      ).toBe('for');
    });
  });
});
