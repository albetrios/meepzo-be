import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { InstagramAccountKey } from './instagram-account.repository.js';
import type {
  InstagramAccountTokenRecord,
  InstagramAccountTokenRepository,
} from './instagram-account-token.repository.js';

/**
 * The organization scope and the account a token call acts on.
 *
 * @remarks
 * Notes: the scope's organization must be the account's — under any other the token row is
 * invisible and unwritable (RLS).
 */
export interface InstagramAccountTokenTarget {
  /** The caller's organization scope; nested in the caller's unit of work when one is open. */
  scope: OrganizationPrincipalDatabaseScope;
  /** The account's organization and internal id. */
  instagramAccount: InstagramAccountKey;
}

/**
 * The one service over the Instagram token table (IA5): stores a connect's new token, hands out
 * the encrypted token for an Instagram call, and erases it on a disconnect.
 *
 * @remarks
 * Algorithm:
 * - Every method runs in `withAppDatabaseContext` with the caller's organization scope. Called
 *   inside the caller's open unit of work for the same organization (the connect or disconnect
 *   transaction), it joins that transaction, so the token and the account's
 *   `token_expires_at` copy commit together.
 *
 * Failure modes:
 * - A scope of another organization than the account's sees no token (`null`) and cannot write
 *   one (the policy's `WITH CHECK`).
 *
 * Side effects:
 * - Writes `app.instagram_account_tokens` only. The caller writes the account's
 *   `token_expires_at` copy in the same transaction.
 *
 * Notes:
 * - Ciphertext only: tokens arrive already encrypted by the Instagram client and leave encrypted;
 *   only the client decrypts, right before its call. Nothing here logs a token.
 * - Only this service and, later, the daily check use the token repository
 *   (`instagram-account-token-isolation.policy.unit.test.ts`).
 * - No Instagram call here — and none may run inside the unit of work these methods join.
 */
export class InstagramAccountTokenService {
  constructor(private readonly tokenRepository: InstagramAccountTokenRepository) {}

  /**
   * Stores the account's long-lived token (IA12 step 4), replacing any earlier one.
   *
   * @remarks
   * Algorithm: one upsert keyed by the account. Failure modes: a write outside the account's
   * organization fails the policy's `WITH CHECK`. Side effects: writes the token row.
   */
  async storeAccessToken({
    scope,
    instagramAccount,
    encryptedAccessToken,
    expiresAt,
  }: InstagramAccountTokenTarget & {
    encryptedAccessToken: string;
    expiresAt: Date;
  }): Promise<void> {
    await withAppDatabaseContext({
      scope,
      callback: () =>
        this.tokenRepository.upsert({ ...instagramAccount, encryptedAccessToken, expiresAt }),
    });
  }

  /**
   * The account's encrypted token and its expiry, for an Instagram call made after the unit of
   * work closes; `null` when the account has none (a revoked account).
   *
   * @remarks
   * Algorithm: one read keyed by the account. Failure modes: none of its own. Side effects: none.
   */
  async findAccessToken({
    scope,
    instagramAccount,
  }: InstagramAccountTokenTarget): Promise<InstagramAccountTokenRecord | null> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.tokenRepository.findByInstagramAccount(instagramAccount),
    });
  }

  /**
   * Erases the account's token — every disconnect (IA14) and Meta's data deletion (IA20).
   *
   * @remarks
   * Algorithm: one delete keyed by the account; returns whether a token was there. Failure modes:
   * none of its own. Side effects: deletes the token row.
   */
  async eraseAccessToken({
    scope,
    instagramAccount,
  }: InstagramAccountTokenTarget): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.tokenRepository.deleteByInstagramAccount(instagramAccount),
    });
  }
}
