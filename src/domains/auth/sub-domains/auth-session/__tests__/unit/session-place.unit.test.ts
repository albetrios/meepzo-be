import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  createSessionPlaceLookup,
  NO_SESSION_PLACE_LOOKUP,
  SESSION_PLACE_CITY_MAX_LENGTH,
} from '@/domains/auth/sub-domains/auth-session/session-place.js';
import { writeSessionPlaceMmdb } from '@/tests/helpers/session-place-mmdb.helper.js';

const fixturePath = writeSessionPlaceMmdb([
  {
    network: '203.0.113.0',
    prefixLength: 24,
    record: { city: { names: { en: '  Mumbai ' } }, country: { iso_code: 'in' } },
  },
  {
    network: '198.51.100.0',
    prefixLength: 24,
    record: { country: { iso_code: 'DE' } },
  },
  {
    network: '192.0.2.0',
    prefixLength: 25,
    record: { city: { names: { en: 'x'.repeat(120) } }, country: { iso_code: 'ZZZ' } },
  },
  {
    network: '192.0.2.128',
    prefixLength: 25,
    record: { location: { time_zone: 'UTC' } },
  },
]);

describe('session place lookup (routes-final § 10.D AT18)', () => {
  const lookup = createSessionPlaceLookup({ databasePath: fixturePath });

  it('finds the city and the upper-case country code of an address in the file', () => {
    expect(lookup.findPlace('203.0.113.7')).toEqual({
      place_city: 'Mumbai',
      place_country: 'IN',
    });
  });

  it('finds an IPv4 client reported in IPv6-mapped form', () => {
    expect(lookup.findPlace('::ffff:203.0.113.7')).toEqual({
      place_city: 'Mumbai',
      place_country: 'IN',
    });
  });

  it('answers a country-only match with the city null', () => {
    expect(lookup.findPlace('198.51.100.200')).toEqual({ place_city: null, place_country: 'DE' });
  });

  it('drops a country code that is not two letters and keeps the city, cut to the column length', () => {
    expect(SESSION_PLACE_CITY_MAX_LENGTH).toBe(100);
    expect(lookup.findPlace('192.0.2.1')).toEqual({
      place_city: 'x'.repeat(SESSION_PLACE_CITY_MAX_LENGTH),
      place_country: null,
    });
  });

  it('answers null for a record with neither city nor country', () => {
    expect(lookup.findPlace('192.0.2.200')).toBeNull();
  });

  it('answers null for an address the file does not hold', () => {
    expect(lookup.findPlace('10.0.0.1')).toBeNull();
  });

  it('answers null (never throws) for an IPv6 address in an IPv4-only file and for a malformed address', () => {
    expect(lookup.findPlace('2001:db8::1')).toBeNull();
    expect(lookup.findPlace('not-an-ip')).toBeNull();
  });

  it('answers null for every address when no path is configured', () => {
    expect(createSessionPlaceLookup({ databasePath: undefined })).toBe(NO_SESSION_PLACE_LOOKUP);
    expect(NO_SESSION_PLACE_LOOKUP.findPlace('203.0.113.7')).toBeNull();
  });

  it('answers null (never throws) when the configured file is missing', () => {
    const missing = createSessionPlaceLookup({
      databasePath: join(tmpdir(), 'no-such-dir', 'session-place.mmdb'),
    });
    expect(missing.findPlace('203.0.113.7')).toBeNull();
    expect(missing.findPlace('203.0.113.8')).toBeNull();
  });
});
