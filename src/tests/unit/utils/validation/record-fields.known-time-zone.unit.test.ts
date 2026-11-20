import { describe, expect, it } from 'vitest';
import { isKnownTimeZone } from '@/shared/utils/validation/record-fields.util.js';

/** `isKnownTimeZone` — the check behind an organization's IANA time zone field. */
describe('isKnownTimeZone', () => {
  it('knows real zones and refuses made-up ones', () => {
    expect(isKnownTimeZone('Asia/Kolkata')).toBe(true);
    expect(isKnownTimeZone('Europe/Berlin')).toBe(true);
    expect(isKnownTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});
