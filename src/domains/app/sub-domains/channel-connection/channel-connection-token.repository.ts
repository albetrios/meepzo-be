import { and, eq } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { databaseUpdatedAtTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { channel_connection_tokens } from './channel-connection-token.schema.js';
import type { ChannelConnectionKey } from './channel-connection.repository.js';
import type { ChannelConnectionTokenType } from './channel-connection.constants.js';

/** `updated_at` for every change of a token — never before the row's `created_at`. */
const tokenUpdatedAtTimestamp = databaseUpdatedAtTimestamp(channel_connection_tokens.created_at);

/** The connection's token as the token repository hands it out — ciphertext only (MC9). */
export interface ChannelConnectionTokenRecord {
  /** `encryptFieldSecret` output; only the provider client decrypts it. */
  encryptedAccessToken: string;
  /** `encryptFieldSecret` output, or `null` (always for Meta — MC18). */
  encryptedRefreshToken: string | null;
  tokenType: ChannelConnectionTokenType;
  /** `null` = never ends (D24). */
  expiresAt: Date | null;
}

/** What a token write stores — ciphertext only. */
export interface ChannelConnectionTokenValues {
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  tokenType: ChannelConnectionTokenType;
  expiresAt: Date | null;
}

/**
 * Drizzle access to `app.channel_connection_tokens` (routes-final § 1 MC9) — the only code that
 * reads the table.
 *
 * @remarks
 * - **Algorithm:** one row per connection, keyed by `(organization_id, channel_connection_id)` —
 *   every statement names both. A new token replaces the old one in place (`ON CONFLICT … DO
 *   UPDATE`).
 * - **Failure modes:** none of its own; a write under another organization's context fails the
 *   policy's `WITH CHECK`.
 * - **Side effects:** writes `app.channel_connection_tokens` only.
 * - **Notes:** callers are pinned by `channel-connection-token-isolation.policy.unit.test.ts`: the
 *   token service, and the worker paths through {@link createWorkerChannelConnectionTokenRepository}.
 *   The token is never decrypted here — the provider client decrypts it right before a call.
 */
export class ChannelConnectionTokenRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** Writes the connection's token — a callback's new token replaces any earlier one. */
  async upsert({
    organizationId,
    channelConnectionId,
    encryptedAccessToken,
    encryptedRefreshToken,
    tokenType,
    expiresAt,
  }: ChannelConnectionKey & ChannelConnectionTokenValues): Promise<void> {
    const values = {
      encrypted_access_token: encryptedAccessToken,
      encrypted_refresh_token: encryptedRefreshToken,
      token_type: tokenType,
      expires_at: expiresAt,
    };
    await this.db()
      .insert(channel_connection_tokens)
      .values({
        organization_id: organizationId,
        channel_connection_id: channelConnectionId,
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          channel_connection_tokens.organization_id,
          channel_connection_tokens.channel_connection_id,
        ],
        set: { ...values, updated_at: tokenUpdatedAtTimestamp },
      });
  }

  /** The connection's token, or `null` when it has none (a revoked connection). */
  async findByConnection({
    organizationId,
    channelConnectionId,
  }: ChannelConnectionKey): Promise<ChannelConnectionTokenRecord | null> {
    const rows = await this.db()
      .select({
        encryptedAccessToken: channel_connection_tokens.encrypted_access_token,
        encryptedRefreshToken: channel_connection_tokens.encrypted_refresh_token,
        tokenType: channel_connection_tokens.token_type,
        expiresAt: channel_connection_tokens.expires_at,
      })
      .from(channel_connection_tokens)
      .where(
        and(
          eq(channel_connection_tokens.organization_id, organizationId),
          eq(channel_connection_tokens.channel_connection_id, channelConnectionId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return { ...row, tokenType: row.tokenType as ChannelConnectionTokenType };
  }

  /**
   * Replaces the access token's ciphertext with the same token under another key (S26: the token
   * check moves a token still on an old key version) — only while the stored value is still
   * `previousEncryptedAccessToken`, so a new token written meanwhile (a reconnect) is never
   * overwritten. Returns whether the row was written.
   */
  async replaceEncryptedAccessToken({
    organizationId,
    channelConnectionId,
    previousEncryptedAccessToken,
    encryptedAccessToken,
  }: ChannelConnectionKey & {
    previousEncryptedAccessToken: string;
    encryptedAccessToken: string;
  }): Promise<boolean> {
    const rows = await this.db()
      .update(channel_connection_tokens)
      .set({ encrypted_access_token: encryptedAccessToken, updated_at: tokenUpdatedAtTimestamp })
      .where(
        and(
          eq(channel_connection_tokens.organization_id, organizationId),
          eq(channel_connection_tokens.channel_connection_id, channelConnectionId),
          eq(channel_connection_tokens.encrypted_access_token, previousEncryptedAccessToken),
        ),
      )
      .returning({ id: channel_connection_tokens.id });
    return rows.length > 0;
  }

  /** Deletes the connection's token; returns whether one was there. */
  async deleteByConnection({
    organizationId,
    channelConnectionId,
  }: ChannelConnectionKey): Promise<boolean> {
    const rows = await this.db()
      .delete(channel_connection_tokens)
      .where(
        and(
          eq(channel_connection_tokens.organization_id, organizationId),
          eq(channel_connection_tokens.channel_connection_id, channelConnectionId),
        ),
      )
      .returning({ id: channel_connection_tokens.id });
    return rows.length > 0;
  }
}

/**
 * {@link ChannelConnectionTokenRepository} bound to a job's organization handle — the worker paths
 * that read a token right before a provider call (the Instagram account jobs — R40 — the
 * connection's token check — MC10, which also re-encrypts an old-key token, S26 — and the sender at
 * R42).
 */
export function createWorkerChannelConnectionTokenRepository(
  databaseHandle: WorkerDatabaseHandle,
): ChannelConnectionTokenRepository {
  assertWorkerDatabaseContext(['organization']);
  return new ChannelConnectionTokenRepository(databaseHandle);
}
