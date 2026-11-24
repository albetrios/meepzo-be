/** Insert payload accepted by {@link AuthSessionRepository.create}; `public_id` is generated server-side, so only the user link, token hash, network metadata, and expiry are required. */
export interface AuthSessionCreateData {
  user_id: number;
  token_hash: string;
  refresh_token_hash: string;
  ip_address: string;
  user_agent?: string;
  expires_at: Date;
  /** Set when the session is created by the MFA login challenge (second factor proven). */
  mfa_verified_at?: Date;
  /** The IP's city from the session-place file (set by the service, never by a caller). */
  place_city?: string | null;
  /** The IP's ISO 3166-1 alpha-2 country code from the session-place file (set by the service). */
  place_country?: string | null;
}

/** A refresh from a new IP: the address and its place, written beside the rotated credentials. */
export interface AuthSessionNetworkUpdate {
  ip_address: string;
  place_city: string | null;
  place_country: string | null;
}
