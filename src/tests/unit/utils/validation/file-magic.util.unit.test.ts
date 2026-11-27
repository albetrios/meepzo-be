import { describe, expect, it } from 'vitest';
import { verifyFileMagicBytes } from '@/shared/utils/validation/file-magic.util.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff, ...Array(9).fill(0)]);
const PDF_SIGNATURE = Buffer.from([0x25, 0x50, 0x44, 0x46, ...Array(8).fill(0)]);

function webpBuffer(): Buffer {
  const buffer = Buffer.alloc(16);
  Buffer.from([0x52, 0x49, 0x46, 0x46]).copy(buffer, 0);
  Buffer.from([0x57, 0x45, 0x42, 0x50]).copy(buffer, 8);
  return buffer;
}

/** A buffer of `length` bytes that starts with `bytes`. */
function withPrefix(bytes: number[], length = 16): Buffer {
  const buffer = Buffer.alloc(length);
  Buffer.from(bytes).copy(buffer, 0);
  return buffer;
}

describe('file-magic.util', () => {
  it('accepts PNG magic bytes', () => {
    const buffer = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4)]);
    expect(verifyFileMagicBytes({ buffer, contentType: 'image/png' })).toBe(true);
  });

  it('accepts JPEG magic bytes', () => {
    expect(verifyFileMagicBytes({ buffer: JPEG_SIGNATURE, contentType: 'image/jpeg' })).toBe(true);
  });

  it('accepts WebP magic bytes with WEBP marker at offset 8', () => {
    expect(verifyFileMagicBytes({ buffer: webpBuffer(), contentType: 'image/webp' })).toBe(true);
  });

  it('accepts PDF magic bytes', () => {
    expect(verifyFileMagicBytes({ buffer: PDF_SIGNATURE, contentType: 'application/pdf' })).toBe(
      true,
    );
  });

  it('rejects buffer shorter than minimum length', () => {
    expect(verifyFileMagicBytes({ buffer: Buffer.from([0x89]), contentType: 'image/png' })).toBe(
      false,
    );
  });

  it('rejects unknown content type', () => {
    expect(
      verifyFileMagicBytes({ buffer: PNG_SIGNATURE, contentType: 'application/octet-stream' }),
    ).toBe(false);
  });

  it('rejects mismatched magic bytes for declared type', () => {
    expect(verifyFileMagicBytes({ buffer: JPEG_SIGNATURE, contentType: 'image/png' })).toBe(false);
  });

  it('rejects WebP when WEBP marker is missing', () => {
    const buffer = Buffer.alloc(16);
    Buffer.from([0x52, 0x49, 0x46, 0x46]).copy(buffer, 0);
    expect(verifyFileMagicBytes({ buffer, contentType: 'image/webp' })).toBe(false);
  });

  // audit #33: a valid WebP needs the full 12-byte RIFF+WEBP header. Exactly 12 bytes is the
  // minimum; 11 bytes must be rejected (the explicit WEBP_MINIMUM_LENGTH, not a brittle `+8`).
  it('accepts a WebP at exactly the 12-byte minimum', () => {
    expect(
      verifyFileMagicBytes({ buffer: webpBuffer().subarray(0, 12), contentType: 'image/webp' }),
    ).toBe(true);
  });

  it('rejects an 11-byte WebP (one byte short of the WEBP marker)', () => {
    expect(
      verifyFileMagicBytes({ buffer: webpBuffer().subarray(0, 11), contentType: 'image/webp' }),
    ).toBe(false);
  });

  describe('audio signatures (message files)', () => {
    it.each([0xf1, 0xf9, 0xf0, 0xf8])('accepts an AAC ADTS frame start FF %s', (secondByte) => {
      expect(
        verifyFileMagicBytes({ buffer: withPrefix([0xff, secondByte]), contentType: 'audio/aac' }),
      ).toBe(true);
    });

    it('accepts an AAC ADIF header', () => {
      expect(
        verifyFileMagicBytes({
          buffer: withPrefix([0x41, 0x44, 0x49, 0x46]),
          contentType: 'audio/aac',
        }),
      ).toBe(true);
    });

    it.each(['audio/mp4', 'audio/x-m4a'])('accepts an ftyp box at offset 4 for %s', (type) => {
      const buffer = withPrefix([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);
      expect(verifyFileMagicBytes({ buffer, contentType: type })).toBe(true);
    });

    it('accepts a WAV (RIFF … WAVE) and refuses it as a WebP', () => {
      const buffer = Buffer.alloc(16);
      Buffer.from([0x52, 0x49, 0x46, 0x46]).copy(buffer, 0);
      Buffer.from([0x57, 0x41, 0x56, 0x45]).copy(buffer, 8);
      expect(verifyFileMagicBytes({ buffer, contentType: 'audio/wav' })).toBe(true);
      expect(verifyFileMagicBytes({ buffer, contentType: 'image/webp' })).toBe(false);
      expect(verifyFileMagicBytes({ buffer: webpBuffer(), contentType: 'audio/wav' })).toBe(false);
    });

    it('refuses a fake .m4a (a PNG or text declared as audio)', () => {
      const text = Buffer.from('<html><script>alert(1)</script></html>');
      for (const contentType of ['audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav']) {
        expect(verifyFileMagicBytes({ buffer: text, contentType })).toBe(false);
        expect(
          verifyFileMagicBytes({
            buffer: Buffer.concat([PNG_SIGNATURE, Buffer.alloc(8)]),
            contentType,
          }),
        ).toBe(false);
      }
    });

    it('refuses an AAC sync word with a non-ADTS second byte', () => {
      expect(
        verifyFileMagicBytes({ buffer: withPrefix([0xff, 0xfb]), contentType: 'audio/aac' }),
      ).toBe(false);
    });
  });

  describe('inbound DM signatures (the Instagram inbound-media purpose)', () => {
    it.each(['video/mp4', 'video/quicktime'])('accepts an ftyp box at offset 4 for %s', (type) => {
      const buffer = withPrefix([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
      expect(verifyFileMagicBytes({ buffer, contentType: type })).toBe(true);
    });

    it('accepts a GIF87a and a GIF89a header', () => {
      for (const header of ['GIF87a', 'GIF89a']) {
        const buffer = Buffer.concat([Buffer.from(header, 'ascii'), Buffer.alloc(10)]);
        expect(verifyFileMagicBytes({ buffer, contentType: 'image/gif' })).toBe(true);
      }
    });

    it('accepts an MP3 with an ID3 tag or a bare Layer III frame sync', () => {
      expect(
        verifyFileMagicBytes({ buffer: withPrefix([0x49, 0x44, 0x33]), contentType: 'audio/mpeg' }),
      ).toBe(true);
      for (const secondByte of [0xfb, 0xf3, 0xf2]) {
        expect(
          verifyFileMagicBytes({
            buffer: withPrefix([0xff, secondByte]),
            contentType: 'audio/mpeg',
          }),
        ).toBe(true);
      }
    });

    it('refuses a disguised file (HTML or a PNG declared as video, GIF or MP3)', () => {
      const text = Buffer.from('<html><script>alert(1)</script></html>');
      for (const contentType of ['video/mp4', 'video/quicktime', 'image/gif', 'audio/mpeg']) {
        expect(verifyFileMagicBytes({ buffer: text, contentType })).toBe(false);
        expect(
          verifyFileMagicBytes({
            buffer: Buffer.concat([PNG_SIGNATURE, Buffer.alloc(8)]),
            contentType,
          }),
        ).toBe(false);
      }
    });
  });
});
