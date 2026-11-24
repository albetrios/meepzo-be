import { parseUserAgent } from '@/shared/utils/http/user-agent.util.js';

/**
 * Public shape for an auth session. Deliberately omits credential material and
 * internal identifiers — `token_hash`, `refresh_token_hash`, the numeric `id`,
 * `user_id`, `organization_id` — so the "list my sessions" response never leaks
 * session-validation secrets or internal FKs. The raw `ip_address` / `user_agent`
 * are retained alongside the derived `device` / `browser` display fields so a
 * client can use the parsed hint or the source value. `place` is where the IP
 * is, from the server's local IP-to-place file (routes-final § 10.D AT18).
 */
export interface AuthSessionOutput {
  id: string;
  ip_address: string;
  user_agent: string | null;
  /** Device/OS family parsed from `user_agent` (e.g. `"Mac"`, `"iPhone"`), or null. */
  device: string | null;
  /** Browser family parsed from `user_agent` (e.g. `"Chrome"`, `"Safari"`), or null. */
  browser: string | null;
  /**
   * Where the session's IP is: the English city name and the ISO 3166-1 alpha-2 country code
   * (the app names the country from its code); null when the place file has no match or there is
   * no file. Either inner field can be null on a partial match.
   */
  place: AuthSessionPlaceOutput | null;
  /** True when this row is the session the request is authenticated with. */
  is_current: boolean;
  last_active_at: string;
  expires_at: string;
  created_at: string;
}

/** The `place` of a session: city and country code, either of which can be null. */
export interface AuthSessionPlaceOutput {
  city: string | null;
  country_code: string | null;
}

/** Row fields the serializer reads (a subset of the `auth.sessions` row). */
interface AuthSessionRowLike {
  public_id: string;
  ip_address: string;
  user_agent: string | null;
  place_city: string | null;
  place_country: string | null;
  last_active_at: Date;
  expires_at: Date;
  created_at: Date;
}

/** Options controlling per-row derivation — chiefly which row is the caller's current session. */
interface SerializeAuthSessionOptions {
  /** The `public_id` of the session the request is authenticated with; flags the matching row `is_current`. */
  currentSessionPublicId: string | null;
}

/** The session's `place`: null when neither the city nor the country is known. */
function serializePlace(row: AuthSessionRowLike): AuthSessionPlaceOutput | null {
  const city = row.place_city ?? null;
  const countryCode = row.place_country ?? null;
  return city === null && countryCode === null ? null : { city, country_code: countryCode };
}

/** Maps a raw session row to its safe public shape, deriving device/browser and the current-session flag. */
export function serializeAuthSession({
  row,
  options,
}: {
  row: AuthSessionRowLike;
  options: SerializeAuthSessionOptions;
}): AuthSessionOutput {
  const { device, browser } = parseUserAgent(row.user_agent);
  return {
    id: row.public_id,
    ip_address: row.ip_address,
    user_agent: row.user_agent ?? null,
    device,
    browser,
    place: serializePlace(row),
    is_current: row.public_id === options.currentSessionPublicId,
    last_active_at: row.last_active_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}

/** Maps a list of raw session rows to their safe public shapes. */
export function serializeAuthSessions({
  rows,
  options,
}: {
  rows: AuthSessionRowLike[];
  options: SerializeAuthSessionOptions;
}): AuthSessionOutput[] {
  return rows.map((row) => serializeAuthSession({ row, options }));
}
