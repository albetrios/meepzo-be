/**
 * Canonical `auth.auth_methods.method_type` values — the single source of truth
 * shared by the Drizzle schema CHECK constraint, validators, and every insert
 * site so casing can never drift from the database constraint
 * (`chk_auth_methods_type`).
 *
 * @remarks
 * - **Algorithm:** the object literal is the authority; {@link AUTH_METHOD_TYPES}
 *   derives the allowed-value list used by the schema CHECK so adding a method
 *   type only requires one edit here.
 * - **Failure modes:** inserting a `method_type` outside these values violates
 *   the database CHECK constraint and raises a Postgres error — always reference
 *   {@link AUTH_METHOD_TYPE} rather than a string literal at insert sites.
 * - **Side effects:** none — compile-time constants only.
 * - **Notes:** values are intentionally UPPERCASE to match the persisted column
 *   contract. `PASSWORD` is a stored value only (feat-instagram-dm-sending P84): every
 *   `PASSWORD` row was revoked by `20261124100000_auth_passwords_off.sql` and no code path
 *   creates one, so the CHECK keeps it for those historic revoked rows while the API never
 *   accepts or returns it ({@link LIVE_AUTH_METHOD_TYPES}). `EMAIL_CODE` here is the auth-method credential type (passwordless email
 *   verification-code login), distinct from the `verification_tokens.token_type` of the same name.
 */
export const AUTH_METHOD_TYPE = {
  PASSWORD: 'PASSWORD',
  EMAIL_CODE: 'EMAIL_CODE',
  OAUTH: 'OAUTH',
  MFA_TOTP: 'MFA_TOTP',
  MFA_SMS: 'MFA_SMS',
  MFA_EMAIL: 'MFA_EMAIL',
} as const;

/** Literal union of supported {@link AUTH_METHOD_TYPE} values. */
export type AuthMethodType = (typeof AUTH_METHOD_TYPE)[keyof typeof AUTH_METHOD_TYPE];

/** All allowed `method_type` values, used to derive the schema CHECK constraint. */
export const AUTH_METHOD_TYPES = Object.values(AUTH_METHOD_TYPE) as AuthMethodType[];

/**
 * Stored-only `method_type` values: kept by the CHECK constraint for historic, revoked rows, never
 * created, accepted or returned by the API (`PASSWORD` — passwords are off, P84).
 */
export const RETIRED_AUTH_METHOD_TYPES: readonly AuthMethodType[] = [AUTH_METHOD_TYPE.PASSWORD];

/**
 * The `method_type` values a live auth method can hold — what `GET /auth/me/auth-methods` can
 * return and the OpenAPI enum documents: {@link AUTH_METHOD_TYPES} without the retired ones.
 */
export const LIVE_AUTH_METHOD_TYPES: readonly AuthMethodType[] = AUTH_METHOD_TYPES.filter(
  (methodType) => !RETIRED_AUTH_METHOD_TYPES.includes(methodType),
);
