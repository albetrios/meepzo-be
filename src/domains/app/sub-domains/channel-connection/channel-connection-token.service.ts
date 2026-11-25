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
 * A connection's status and its encrypted token — {@link ChannelConnectionTokenService.findConnectionAccess}.
 *
 * @remarks
 * Notes: the token stays ciphertext; only the provider client decrypts it, right before its call.
 */
export interface ChannelConnectionAccess {
  /** `connected` · `error` · `revoked`. */
  connectionStatus: string;
  /** `chc_…` — the key of the connection's usage (MC19, read before a sender's Meta call). */
  channelConnectionPublicId: string;
  /** The business portfolio's id — the asset Meta reports the business-wide usage under (SN23). */
  clientBusinessId: string;
  /** The ciphertext; `null` when the connection has no token (revoked). */
  encryptedAccessToken: string | null;
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
   * The connection's status and its encrypted token in one read, for a provider call made after the
   * unit of work closes — an account read that must refuse a broken connection without calling
   * (routes 13–14, IA15). `null` when the connection is not the organization's.
   *
   * @remarks
   * Algorithm: the connection row, then its token, keyed by the connection, in the caller's unit
   * when one is open. Failure modes: none of its own. Side effects: none — never the provider.
   */
  async findConnectionAccess({
    scope,
    channelConnection,
  }: ChannelConnectionTokenTarget): Promise<ChannelConnectionAccess | null> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const [connection] = await this.connectionRepository.findByIds({
          organizationId: channelConnection.organizationId,
          channelConnectionIds: [channelConnection.channelConnectionId],
        });
        if (connection === undefined) return null;
        const token = await this.tokenRepository.findByConnection(channelConnection);
        return {
          connectionStatus: connection.status,
          channelConnectionPublicId: connection.public_id,
          clientBusinessId: connection.client_business_id,
          encryptedAccessToken: token?.encryptedAccessToken ?? null,
        };
      },
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

  /**
   * The team delete's step of sub-domain 1 (IAC5, D54): every not-revoked connection of the
   * organization revoked and its token deleted — those with no account left too. Returns how many
   * connections were live before.
   *
   * @remarks
   * Algorithm: the organization's not-revoked connections, then {@link revokeConnection} on each, in
   * the caller's unit (the erasure's transaction). Failure modes: none of its own — an organization
   * without connections answers `0`. Side effects: writes the connection and token rows. Notes: must
   * run before the organization is soft-deleted (its own scope hides a deleted organization's rows);
   * safe to repeat.
   */
  async revokeOrganizationConnections({
    scope,
    organizationId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    /** `tenancy.organizations.id` of the scope's organization. */
    organizationId: number;
  }): Promise<number> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const connections = await this.connectionRepository.listByOrganizationId({
          organizationId,
          includeRevoked: false,
        });
        let revokedCount = 0;
        for (const connection of connections) {
          const wasLive = await this.revokeConnection({
            scope,
            channelConnection: { organizationId, channelConnectionId: connection.id },
          });
          if (wasLive) revokedCount += 1;
        }
        return revokedCount;
      },
    });
  }
}
