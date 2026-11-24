import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type {
  ChannelConnectionKey,
  ChannelConnectionRepository,
} from './channel-connection.repository.js';
import type {
  ChannelConnectionTokenRecord,
  ChannelConnectionTokenRepository,
  ChannelConnectionTokenValues,
} from './channel-connection-token.repository.js';

/**
 * The organization scope and the connection a token call acts on.
 *
 * @remarks
 * Notes: the scope's organization must be the connection's — under any other the token row is
 * invisible and unwritable (RLS).
 */
export interface ChannelConnectionTokenTarget {
  /** The caller's organization scope; nested in the caller's unit of work when one is open. */
  scope: OrganizationPrincipalDatabaseScope;
  /** The connection's organization and internal id. */
  channelConnection: ChannelConnectionKey;
}

/**
 * The one service over the connection's token (routes-final § 1 MC9): stores a callback's token,
 * hands out the encrypted token for a provider call, and — when the connection goes — revokes the
 * connection and deletes its token in the caller's unit of work.
 *
 * @remarks
 * Algorithm:
 * - Every method runs in `withAppDatabaseContext` with the caller's organization scope. Called
 *   inside the caller's open unit of work for the same organization (the callback, a disconnect,
 *   Meta's callbacks), it joins that transaction.
 *
 * Failure modes:
 * - A scope of another organization than the connection's sees no token (`null`) and cannot write
 *   one (the policy's `WITH CHECK`).
 *
 * Side effects:
 * - Writes `app.channel_connection_tokens`; `revokeConnection` also writes the connection row.
 *
 * Notes:
 * - Ciphertext only: tokens arrive already encrypted by the provider client and leave encrypted;
 *   only the client decrypts, right before its call. Nothing here logs a token.
 * - Only this service and the worker paths use the token repository
 *   (`channel-connection-token-isolation.policy.unit.test.ts`).
 * - Meta writes a `system_user` token that never ends and no refresh token (D24, MC18).
 * - No provider call here — and none may run inside the unit of work these methods join.
 */
export class ChannelConnectionTokenService {
  constructor(
    private readonly tokenRepository: ChannelConnectionTokenRepository,
    private readonly connectionRepository: ChannelConnectionRepository,
  ) {}

  /**
   * Stores the connection's token (MC5 step 5), replacing any earlier one.
   *
   * @remarks
   * Algorithm: one upsert keyed by the connection. Failure modes: a write outside the
   * connection's organization fails the policy's `WITH CHECK`. Side effects: writes the token row.
   */
  async storeAccessToken({
    scope,
    channelConnection,
    token,
  }: ChannelConnectionTokenTarget & { token: ChannelConnectionTokenValues }): Promise<void> {
    await withAppDatabaseContext({
      scope,
      callback: () => this.tokenRepository.upsert({ ...channelConnection, ...token }),
    });
  }

  /**
   * The connection's encrypted token, for a provider call made after the unit of work closes;
   * `null` when it has none (a revoked connection).
   *
   * @remarks
   * Algorithm: one read keyed by the connection. Failure modes: none of its own. Side effects: none.
   */
  async findAccessToken({
    scope,
    channelConnection,
  }: ChannelConnectionTokenTarget): Promise<ChannelConnectionTokenRecord | null> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.tokenRepository.findByConnection(channelConnection),
    });
  }

  /**
   * Revokes the connection and deletes its token (MC8, CA8 — the last account leaving, "Disconnect
   * business", Meta's callbacks). Returns whether the connection was live before.
   *
   * @remarks
   * Algorithm: the guarded revoke, then the token delete, in the caller's unit. Failure modes: none
   * of its own — an already revoked connection is `false` (its token is deleted all the same).
   * Side effects: writes the connection and token rows.
   */
  async revokeConnection({
    scope,
    channelConnection,
  }: ChannelConnectionTokenTarget): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const revoked = await this.connectionRepository.revoke(channelConnection);
        await this.tokenRepository.deleteByConnection(channelConnection);
        return revoked !== null;
      },
    });
  }
}
