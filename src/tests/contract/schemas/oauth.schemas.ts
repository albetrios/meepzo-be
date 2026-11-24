import { z } from 'zod';

/**
 * Zod contract for Google's `POST /token` success envelope — the fields
 * `exchangeGoogleOAuthCode` actually consumes plus the documented OAuth 2.0
 * companions, so an upstream rename of `access_token` fails loudly here.
 */
export const GoogleTokenSuccessResponseContractSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
    token_type: z.literal('Bearer'),
    scope: z.string().min(1),
  })
  .loose();

/**
 * Zod contract for Google's OIDC `GET /oauth2/v3/userinfo` envelope — `sub`,
 * `email`, and the strictly-boolean `email_verified` are the account-linking
 * inputs; the schema pins their types so a provider drift (e.g. stringly
 * `"true"`) cannot silently pass the takeover guard.
 */
export const GoogleUserinfoSuccessResponseContractSchema = z
  .object({
    sub: z.string().min(1),
    email: z.string().min(3),
    email_verified: z.boolean(),
    name: z.string().optional(),
    picture: z.string().optional(),
  })
  .loose();

/**
 * Zod contract for Apple's `POST /auth/token` success envelope — `id_token` is the only field
 * `exchangeAppleOAuthCode` reads (its claims carry `sub`, `email` and the flow's `nonce`).
 */
export const AppleTokenSuccessResponseContractSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive(),
    id_token: z.string().min(1),
  })
  .loose();

/** Zod contract for the form OUR Apple token swap sends upstream (the client secret is a JWT). */
export const AppleTokenOutgoingFormContractSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().regex(/^[\w-]+\.[\w-]+\.[\w-]+$/),
    code: z.string().min(1),
    grant_type: z.literal('authorization_code'),
    redirect_uri: z.url(),
  })
  .strict();

/** Zod contract for Apple's `GET /auth/keys` JWK set — RSA signing keys named by `kid`. */
export const AppleKeysResponseContractSchema = z.object({
  keys: z.array(
    z
      .object({
        kty: z.literal('RSA'),
        kid: z.string().min(1),
        use: z.literal('sig'),
        alg: z.literal('RS256'),
        n: z.string().min(1),
        e: z.string().min(1),
      })
      .loose(),
  ),
});
