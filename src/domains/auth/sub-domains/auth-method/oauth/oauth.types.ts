/** Lower-cased OAuth provider slugs the platform supports (Google and Apple, AT5/AT10; GitHub is gone). */
export const SUPPORTED_OAUTH_PROVIDERS = ['google', 'apple'] as const;

/** Literal union of supported provider slugs in {@link SUPPORTED_OAUTH_PROVIDERS}. */
export type OAuthProvider = (typeof SUPPORTED_OAUTH_PROVIDERS)[number];

/** The only `intent` the OAuth start takes: link the provider account to the signed-in person (AT12). */
export const OAUTH_LINK_INTENT = 'link';

/**
 * Normalised user profile returned by `exchangeXOAuthCode` helpers, consumed by
 * {@link completeOAuthUserSession}. `email` is absent when the provider did not send one — Apple
 * sends it only while the person shares it; a later sign-in is matched by `provider_user_id`.
 */
export interface OAuthProfile {
  email?: string;
  name?: string;
  avatar_url?: string;
  provider_user_id: string;
}

/** The signed-in person a link-mode start binds into the OAuth state (AT12). */
export interface OAuthLinkTarget {
  user_public_id: string;
  session_public_id: string;
}
