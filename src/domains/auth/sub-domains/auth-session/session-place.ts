import { readFileSync } from 'node:fs';
import { type CityResponse, Reader } from 'maxmind';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/** Longest city name kept on `auth.sessions.place_city` (the column is `varchar(100)`). */
export const SESSION_PLACE_CITY_MAX_LENGTH = 100;

/** An ISO 3166-1 alpha-2 country code, upper case — the only form `auth.sessions.place_country` accepts. */
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/**
 * Where an IP address is, as stored on a session row: the file's English city name and the
 * ISO 3166-1 alpha-2 country code. Either can be null (a country-only match); a lookup that finds
 * neither answers null instead of this object.
 */
export interface SessionPlace {
  place_city: string | null;
  place_country: string | null;
}

/**
 * Finds the place of an IP address in a local IP-to-place file (routes-final § 10.D AT18, P86).
 * Never calls an outside service and never throws: an unknown address, an IPv6 address in an
 * IPv4-only file, or no file at all answers null.
 */
export interface SessionPlaceLookup {
  findPlace(ipAddress: string): SessionPlace | null;
}

/** An IPv4 address written in IPv6 form (`::ffff:203.0.113.7`) — a dual-stack socket reports IPv4 clients this way. */
const IPV4_MAPPED_IPV6_PATTERN = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** The address a file is searched with: an IPv4-mapped IPv6 address becomes its IPv4 form. */
function toLookupAddress(ipAddress: string): string {
  return IPV4_MAPPED_IPV6_PATTERN.exec(ipAddress)?.[1] ?? ipAddress;
}

/** The lookup used when no file is configured: every address answers null (the place stays empty). */
export const NO_SESSION_PLACE_LOOKUP: SessionPlaceLookup = {
  findPlace: () => null,
};

/** Maps one record of a City-shaped `.mmdb` (DB-IP "IP to City Lite", GeoLite2 City) to the session's columns. */
function toSessionPlace(record: CityResponse | null): SessionPlace | null {
  if (!record) return null;
  const cityName = record.city?.names?.en?.trim();
  const countryCode = record.country?.iso_code?.trim().toUpperCase();
  const placeCity = cityName ? cityName.slice(0, SESSION_PLACE_CITY_MAX_LENGTH) : null;
  const placeCountry =
    countryCode !== undefined && COUNTRY_CODE_PATTERN.test(countryCode) ? countryCode : null;
  if (placeCity === null && placeCountry === null) return null;
  return { place_city: placeCity, place_country: placeCountry };
}

/** Opens the file once; a missing or unreadable file is logged once and leaves the place empty. */
function openReader(databasePath: string): Reader<CityResponse> | null {
  try {
    return new Reader<CityResponse>(readFileSync(databasePath));
  } catch (error) {
    logger.warn(
      { err: error, databasePath },
      'session place file could not be opened; session places stay empty',
    );
    return null;
  }
}

/**
 * Builds the {@link SessionPlaceLookup} the session service uses, from `SESSION_PLACE_DATABASE_PATH`.
 *
 * @remarks
 * - **Algorithm:** unset path → {@link NO_SESSION_PLACE_LOOKUP}. Otherwise the file is read into
 *   memory once, on the first lookup (so a process that never creates a session — the worker —
 *   never loads it), and every lookup after that is an in-process tree walk: no network call is
 *   added to sign-in or refresh.
 * - **Failure modes:** none thrown. A missing, unreadable or malformed file logs one warning and
 *   every lookup answers null; an address the reader refuses (an IPv6 address in an IPv4-only file,
 *   a malformed string) answers null.
 * - **Side effects:** one synchronous file read on the first lookup; one warning log when it fails.
 * - **Notes:** the file is DB-IP "IP to City Lite" (CC BY 4.0, P86), fetched by the image build
 *   (`Dockerfile`, build argument `SESSION_PLACE_DATABASE_URL`) — never downloaded at runtime.
 *   The city is the file's English name; the app shows the country's name from its code.
 */
export function createSessionPlaceLookup({
  databasePath,
}: {
  databasePath: string | undefined;
}): SessionPlaceLookup {
  if (!databasePath) return NO_SESSION_PLACE_LOOKUP;
  let reader: Reader<CityResponse> | null | undefined;
  return {
    findPlace(ipAddress: string): SessionPlace | null {
      if (reader === undefined) reader = openReader(databasePath);
      if (reader === null) return null;
      try {
        return toSessionPlace(reader.get(toLookupAddress(ipAddress)));
      } catch {
        return null;
      }
    },
  };
}
