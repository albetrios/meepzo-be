/**
 * Magic byte signatures for common file types.
 * Use when validating uploads to ensure content matches declared content-type
 * (prevents malicious files disguised with wrong extensions). Presigned uploads land in S3
 * directly, so the upload confirm path and the pending-upload sweep read the leading
 * {@link MAGIC_BYTE_PREFIX_LENGTH} bytes back with a ranged GET and verify them here.
 */

/**
 * One way a file of `contentType` may start: `signature` at `offset` (default 0), and — for a
 * container format whose first bytes are shared (RIFF: WebP and WAV) — `marker` at `markerOffset`.
 * A type may have several entries; matching any one of them is enough.
 */
interface MagicSignature {
  contentType: string;
  signature: Uint8Array;
  offset?: number;
  marker?: Uint8Array;
  markerOffset?: number;
}

/** The `RIFF` container tag (bytes 0-4) — WebP and WAV both start with it. */
const RIFF_SIGNATURE = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

/**
 * RIFF layout (audit #33): `RIFF` at bytes 0-4, the 4-byte size at 4-8, the format marker at
 * 8-12 — so a valid WebP or WAV needs at least 12 bytes. Named here so the bounds can't silently
 * drift from a signature edit.
 */
const RIFF_FORMAT_MARKER_OFFSET = 8;

/** The ISO base media (MP4 / M4A) box type `ftyp`, at offset 4 after the 4-byte box size. */
const ISO_MEDIA_FILE_TYPE_BOX_OFFSET = 4;

/** The ADTS frame starts of an AAC stream (12-bit sync, MPEG version, no CRC / CRC). */
const AAC_ADTS_SIGNATURES = [0xf1, 0xf9, 0xf0, 0xf8].map(
  (secondByte) => new Uint8Array([0xff, secondByte]),
);

/** The MPEG audio (MP3) frame starts without an ID3 tag (11-bit sync, MPEG-1/2 Layer III, no CRC). */
const MPEG_AUDIO_FRAME_SIGNATURES = [0xfb, 0xf3, 0xf2].map(
  (secondByte) => new Uint8Array([0xff, secondByte]),
);

const MAGIC_SIGNATURES: ReadonlyArray<MagicSignature> = [
  {
    contentType: 'image/png',
    signature: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { contentType: 'image/jpeg', signature: new Uint8Array([0xff, 0xd8, 0xff]) },
  {
    contentType: 'image/webp',
    signature: RIFF_SIGNATURE,
    marker: new Uint8Array([0x57, 0x45, 0x42, 0x50]), // 'WEBP'
    markerOffset: RIFF_FORMAT_MARKER_OFFSET,
  },
  { contentType: 'application/pdf', signature: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }, // %PDF
  ...AAC_ADTS_SIGNATURES.map((signature) => ({ contentType: 'audio/aac', signature })),
  { contentType: 'audio/aac', signature: new Uint8Array([0x41, 0x44, 0x49, 0x46]) }, // 'ADIF'
  ...['audio/mp4', 'audio/x-m4a'].map((contentType) => ({
    contentType,
    signature: new Uint8Array([0x66, 0x74, 0x79, 0x70]), // 'ftyp'
    offset: ISO_MEDIA_FILE_TYPE_BOX_OFFSET,
  })),
  // Video in the same ISO base media container (MP4; QuickTime's own `ftyp qt  ` brand).
  ...['video/mp4', 'video/quicktime'].map((contentType) => ({
    contentType,
    signature: new Uint8Array([0x66, 0x74, 0x79, 0x70]), // 'ftyp'
    offset: ISO_MEDIA_FILE_TYPE_BOX_OFFSET,
  })),
  { contentType: 'image/gif', signature: new Uint8Array([0x47, 0x49, 0x46, 0x38]) }, // 'GIF8'
  { contentType: 'audio/mpeg', signature: new Uint8Array([0x49, 0x44, 0x33]) }, // 'ID3'
  ...MPEG_AUDIO_FRAME_SIGNATURES.map((signature) => ({ contentType: 'audio/mpeg', signature })),
  {
    contentType: 'audio/wav',
    signature: RIFF_SIGNATURE,
    marker: new Uint8Array([0x57, 0x41, 0x56, 0x45]), // 'WAVE'
    markerOffset: RIFF_FORMAT_MARKER_OFFSET,
  },
];

/** Whether `buffer` holds `bytes` starting at `offset` (false when it is too short). */
function hasBytesAt(options: { buffer: Buffer; bytes: Uint8Array; offset: number }): boolean {
  const { buffer, bytes, offset } = options;
  if (buffer.length < offset + bytes.length) return false;
  return buffer.subarray(offset, offset + bytes.length).equals(Buffer.from(bytes));
}

/** Whether `buffer` starts the way one {@link MagicSignature} says. */
function matchesSignature(options: { buffer: Buffer; entry: MagicSignature }): boolean {
  const { buffer, entry } = options;
  if (!hasBytesAt({ buffer, bytes: entry.signature, offset: entry.offset ?? 0 })) return false;
  if (entry.marker === undefined) return true;
  return hasBytesAt({ buffer, bytes: entry.marker, offset: entry.markerOffset ?? 0 });
}

/**
 * Leading bytes to read for {@link verifyFileMagicBytes} — comfortably more than the longest
 * signature it checks (the 12-byte RIFF header of WebP and WAV).
 */
export const MAGIC_BYTE_PREFIX_LENGTH = 32;

/**
 * Returns true when {@link verifyFileMagicBytes} knows a magic-byte signature for
 * `contentType` (i.e. the type can be content-verified). Used to skip enforcement for
 * allowed-but-signature-less types (e.g. text-based SVG, which is sanitized instead).
 */
export function isMagicByteVerifiable(contentType: string): boolean {
  return MAGIC_SIGNATURES.some((entry) => entry.contentType === contentType);
}

/**
 * Verifies that the buffer's magic bytes match the declared content type — any one of the type's
 * signatures (AAC has several frame starts). Returns true if valid, false otherwise (also for a
 * type with no signature).
 */
export function verifyFileMagicBytes({
  buffer,
  contentType,
}: {
  buffer: Buffer;
  contentType: string;
}): boolean {
  return MAGIC_SIGNATURES.some(
    (entry) => entry.contentType === contentType && matchesSignature({ buffer, entry }),
  );
}
