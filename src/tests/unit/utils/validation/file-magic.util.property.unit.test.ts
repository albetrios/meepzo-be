import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  MAGIC_BYTE_PREFIX_LENGTH,
  verifyFileMagicBytes,
} from '@/shared/utils/validation/file-magic.util.js';
import { propertyAssertOptions } from '@/tests/helpers/fast-check-property.util.js';

const propertyOptions = propertyAssertOptions();

/**
 * Layer 2 (property) for the audio signatures a message file is checked against on confirm
 * (routes-final § 12 UP4): for ANY trailing bytes a file that starts like its type passes, and a
 * file whose leading bytes are anything else is refused.
 */

const tail = fc.uint8Array({ minLength: 0, maxLength: MAGIC_BYTE_PREFIX_LENGTH });
const fourBytes = fc.uint8Array({ minLength: 4, maxLength: 4 });

/** Builds `head` + `rest`, padded so a 12-byte RIFF header always fits. */
function file(head: readonly number[], rest: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(head), Buffer.from(rest), Buffer.alloc(12)]);
}

const AUDIO_TYPES = ['audio/aac', 'audio/mp4', 'audio/x-m4a', 'audio/wav'];

describe('audio magic bytes (property)', () => {
  it('accepts every ADTS / ADIF start for audio/aac, whatever follows', () => {
    const start = fc.constantFrom(
      [0xff, 0xf1],
      [0xff, 0xf9],
      [0xff, 0xf0],
      [0xff, 0xf8],
      [0x41, 0x44, 0x49, 0x46],
    );
    fc.assert(
      fc.property(start, tail, (head, rest) => {
        expect(verifyFileMagicBytes({ buffer: file(head, rest), contentType: 'audio/aac' })).toBe(
          true,
        );
      }),
      propertyOptions,
    );
  });

  it('accepts ftyp at offset 4 for audio/mp4 and audio/x-m4a, whatever the box size', () => {
    fc.assert(
      fc.property(
        fourBytes,
        tail,
        fc.constantFrom('audio/mp4', 'audio/x-m4a'),
        (boxSize, rest, contentType) => {
          const head = [...boxSize, 0x66, 0x74, 0x79, 0x70];
          expect(verifyFileMagicBytes({ buffer: file(head, rest), contentType })).toBe(true);
        },
      ),
      propertyOptions,
    );
  });

  it('accepts RIFF + WAVE for audio/wav, whatever the chunk size', () => {
    fc.assert(
      fc.property(fourBytes, tail, (chunkSize, rest) => {
        const head = [0x52, 0x49, 0x46, 0x46, ...chunkSize, 0x57, 0x41, 0x56, 0x45];
        expect(verifyFileMagicBytes({ buffer: file(head, rest), contentType: 'audio/wav' })).toBe(
          true,
        );
      }),
      propertyOptions,
    );
  });

  it('refuses any audio type when the leading bytes start like none of its signatures', () => {
    // A first byte that no audio signature starts with: not 0xFF (ADTS), 'A' (ADIF), 'R' (RIFF);
    // and bytes 4-8 not 'ftyp'.
    const firstByte = fc
      .integer({ min: 0, max: 0xfe })
      .filter((byte) => byte !== 0x41 && byte !== 0x52);
    fc.assert(
      fc.property(
        firstByte,
        fc.uint8Array({ minLength: 3, maxLength: 3 }),
        fourBytes.filter((bytes) => Buffer.from(bytes).toString('latin1') !== 'ftyp'),
        tail,
        fc.constantFrom(...AUDIO_TYPES),
        (first, next, boxType, rest, contentType) => {
          const head = [first, ...next, ...boxType];
          expect(verifyFileMagicBytes({ buffer: file(head, rest), contentType })).toBe(false);
        },
      ),
      propertyOptions,
    );
  });
});
