import { createHash, randomBytes } from 'node:crypto';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import {
  TRUSTED_DEVICE_DAYS,
  TRUSTED_DEVICE_TOKEN_BYTES,
  TRUSTED_DEVICES_MAX,
} from './auth-trusted-device.constants.js';
import type { TrustedDeviceRepository } from './auth-trusted-device.repository.js';
import type { TrustedDeviceOwner } from './auth-trusted-device.types.js';

/** SHA-256 hex of a trusted-device cookie value — the only form stored. */
function hashTrustedDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * "Trust this device for 30 days" (feat-instagram-dm-sending AT17, D56): creates, accepts and ends
 * the rows of `auth.trusted_devices`.
 *
 * @remarks
 * - **Algorithm:** {@link TrustedDeviceService.trustDevice} mints 32 random bytes (the cookie value),
 *   stores only their SHA-256 with `expires_at` = now + {@link TRUSTED_DEVICE_DAYS}, and revokes the
 *   oldest live row beyond {@link TRUSTED_DEVICES_MAX} under a per-user advisory lock.
 *   {@link TrustedDeviceService.acceptTrustedDevice} matches a cookie against the person's live rows
 *   (setting `last_used_at`, never moving `expires_at`). The two `revoke*` methods end rows early.
 * - **Failure modes:** none of its own — a cookie that matches nothing (another person's, an expired
 *   or a revoked one, garbage) is simply not accepted.
 * - **Side effects:** writes `auth.trusted_devices`, each call in its own (or the caller's pinned)
 *   `withAppDatabaseContext` with the owner's verified scope.
 * - **Notes:** whether a trusted device may skip the 2FA code at all (no organization requiring 2FA,
 *   never a `super_admin`) is decided by `completeFirstFactorAuth`; a trusted device never opens a
 *   step-up and its session's `mfa_verified_at` stays empty.
 */
export class TrustedDeviceService {
  constructor(private readonly repository: TrustedDeviceRepository) {}

  /** Trusts this browser for the person: returns the raw cookie value, its row's public id and its end. */
  async trustDevice(options: {
    owner: TrustedDeviceOwner;
    userAgent: string | undefined;
  }): Promise<{
    token: string;
    public_id: string;
    expires_at: Date;
    revoked_public_ids: string[];
  }> {
    const token = randomBytes(TRUSTED_DEVICE_TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_DAYS * MILLISECONDS_PER_DAY);
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: options.owner.public_id }),
      callback: async () => {
        await this.repository.acquireCreationQuotaLock(options.owner.id);
        const revokedPublicIds = await this.repository.revokeOldestLiveBeyond({
          userId: options.owner.id,
          keepCount: TRUSTED_DEVICES_MAX - 1,
        });
        const row = await this.repository.create({
          user_id: options.owner.id,
          token_hash: hashTrustedDeviceToken(token),
          user_agent: options.userAgent?.slice(0, 512) ?? null,
          expires_at: expiresAt,
        });
        return {
          token,
          public_id: row.public_id,
          expires_at: row.expires_at,
          revoked_public_ids: revokedPublicIds,
        };
      },
    });
  }

  /**
   * Whether `token` is a live, unexpired trusted device of this person; marks it used when it is.
   * An absent or empty token is `false` without a query.
   */
  async acceptTrustedDevice(options: {
    owner: TrustedDeviceOwner;
    token: string | undefined;
  }): Promise<boolean> {
    if (!options.token) return false;
    const tokenHash = hashTrustedDeviceToken(options.token);
    const row = await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: options.owner.public_id }),
      callback: () => this.repository.touchLiveByTokenHash({ userId: options.owner.id, tokenHash }),
    });
    return row !== null;
  }

  /**
   * Ends every trusted device of the person — or every one but this browser's (`keepToken`, the
   * "sign out everywhere else" case). Returns the public ids it ended.
   */
  async revokeAllForUser(options: {
    owner: TrustedDeviceOwner;
    keepToken?: string | undefined;
  }): Promise<string[]> {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: options.owner.public_id }),
      callback: () =>
        this.repository.revokeAllForUser({
          userId: options.owner.id,
          ...(options.keepToken
            ? { exceptTokenHash: hashTrustedDeviceToken(options.keepToken) }
            : {}),
        }),
    });
  }
}
