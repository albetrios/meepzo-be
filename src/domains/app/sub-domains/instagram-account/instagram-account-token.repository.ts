import { and, eq } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { databaseNowTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { instagram_account_tokens } from './instagram-account-token.schema.js';
import { INSTAGRAM_ACCOUNT_TOKEN_TYPE } from './instagram-account.constants.js';
import type { InstagramAccountKey } from './instagram-account.repository.js';

/** The account's token as the token repository hands it out — ciphertext only (IA5). */
export interface InstagramAccountTokenRecord {
  /** `encryptFieldSecret` output; only the Instagram client decrypts it. */
  encryptedAccessToken: string;
  expiresAt: Date | null;
}

/**
 * Drizzle access to `app.instagram_account_tokens` (IA5) — the only code that reads the table.
 *
 * @remarks
 * - **Algorithm:** one row per account, keyed by `(organization_id, instagram_account_id)` — every
 *   statement names both. A new token replaces the old one in place (`ON CONFLICT … DO UPDATE`).
 * - **Failure modes:** none of its own; a write under another organization's context fails the
 *   policy's `WITH CHECK`.
 * - **Side effects:** writes `app.instagram_account_tokens` only.
 * - **Notes:** callers are pinned by `instagram-account-token-isolation.policy.unit.test.ts`: the
 *   token service, and the daily check through {@link createWorkerInstagramAccountTokenRepository}.
 *   The token is never decrypted here — the Instagram client decrypts it right before a call.
 */
export class InstagramAccountTokenRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /**
   * Writes the account's token — a connect's new long-lived token replaces any earlier one and
   * clears the renewal bookkeeping (`last_refreshed_at`, `last_refresh_error`).
   */
  async upsert({
    organizationId,
    instagramAccountId,
    encryptedAccessToken,
    expiresAt,
  }: InstagramAccountKey & { encryptedAccessToken: string; expiresAt: Date }): Promise<void> {
    await this.db()
      .insert(instagram_account_tokens)
      .values({
        organization_id: organizationId,
        instagram_account_id: instagramAccountId,
        encrypted_access_token: encryptedAccessToken,
        token_type: INSTAGRAM_ACCOUNT_TOKEN_TYPE,
        expires_at: expiresAt,
      })
      .onConflictDoUpdate({
        target: [
          instagram_account_tokens.organization_id,
          instagram_account_tokens.instagram_account_id,
        ],
        set: {
          encrypted_access_token: encryptedAccessToken,
          token_type: INSTAGRAM_ACCOUNT_TOKEN_TYPE,
          expires_at: expiresAt,
          last_refreshed_at: null,
          last_refresh_error: null,
          updated_at: databaseNowTimestamp,
        },
      });
  }

  /** The account's encrypted token and its expiry, or `null` when the account has none. */
  async findByInstagramAccount({
    organizationId,
    instagramAccountId,
  }: InstagramAccountKey): Promise<InstagramAccountTokenRecord | null> {
    const rows = await this.db()
      .select({
        encryptedAccessToken: instagram_account_tokens.encrypted_access_token,
        expiresAt: instagram_account_tokens.expires_at,
      })
      .from(instagram_account_tokens)
      .where(
        and(
          eq(instagram_account_tokens.organization_id, organizationId),
          eq(instagram_account_tokens.instagram_account_id, instagramAccountId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Deletes the account's token (every disconnect, IA14); returns whether a row was deleted. */
  async deleteByInstagramAccount({
    organizationId,
    instagramAccountId,
  }: InstagramAccountKey): Promise<boolean> {
    const rows = await this.db()
      .delete(instagram_account_tokens)
      .where(
        and(
          eq(instagram_account_tokens.organization_id, organizationId),
          eq(instagram_account_tokens.instagram_account_id, instagramAccountId),
        ),
      )
      .returning({ id: instagram_account_tokens.id });
    return rows.length > 0;
  }
}

/**
 * {@link InstagramAccountTokenRepository} bound to a job's organization handle — the daily check's
 * renewal (IA8), the only worker path allowed to read the token table (IA5).
 */
export function createWorkerInstagramAccountTokenRepository(
  databaseHandle: WorkerDatabaseHandle,
): InstagramAccountTokenRepository {
  assertWorkerDatabaseContext(['organization']);
  return new InstagramAccountTokenRepository(databaseHandle);
}
