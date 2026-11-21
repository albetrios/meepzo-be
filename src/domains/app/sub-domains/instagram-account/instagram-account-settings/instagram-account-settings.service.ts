import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { InstagramAccountKey } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import type {
  InstagramAccountSettingsRepository,
  InstagramAccountSettingsRow,
} from './instagram-account-settings.repository.js';

/**
 * The organization scope and the account a settings call acts on.
 *
 * @remarks
 * Notes: the scope's organization must be the account's — under any other the settings row is
 * invisible and unwritable (RLS).
 */
export interface InstagramAccountSettingsTarget {
  /** The caller's organization scope; nested in the caller's unit of work when one is open. */
  scope: OrganizationPrincipalDatabaseScope;
  /** The account's organization and internal id. */
  instagramAccount: InstagramAccountKey;
}

/**
 * The Instagram account settings service (routes-final § 1.B): creates the default row at the
 * first connect and reads it for the account object (route 2) and event processing.
 *
 * @remarks
 * Algorithm:
 * - Every method runs in `withAppDatabaseContext` with the caller's organization scope; called
 *   inside the connect transaction it joins it, so the account and its settings commit together.
 *
 * Failure modes:
 * - An account of another organization than the scope's: no row is read or written.
 *
 * Side effects:
 * - {@link InstagramAccountSettingsService.createDefaultSettings} may insert one
 *   `app.instagram_account_settings` row; nothing else writes.
 *
 * Notes:
 * - The settings row is written through this service only, never by the account's repository
 *   (1.B.10). Route 3's update (`PATCH /social/instagram/account/settings`) lands with R4. No cache
 *   at launch (IA15).
 */
export class InstagramAccountSettingsService {
  constructor(private readonly settingsRepository: InstagramAccountSettingsRepository) {}

  /**
   * Gives the account its default settings when it has none and returns its settings row — the
   * new defaults on a first connect, the kept row on a reconnect (IA12 step 4).
   *
   * @remarks
   * Algorithm: insert-if-absent, then read the kept row when one was already there. Failure modes:
   * throws when neither the insert nor the read finds a row (the account is not in the scope's
   * organization). Side effects: may insert the settings row.
   */
  async createDefaultSettings({
    scope,
    instagramAccount,
  }: InstagramAccountSettingsTarget): Promise<InstagramAccountSettingsRow> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const created = await this.settingsRepository.insertDefaults(instagramAccount);
        if (created !== null) return created;
        const kept = await this.settingsRepository.findByInstagramAccount(instagramAccount);
        if (kept === null) {
          throw new Error('instagram account settings were neither created nor found');
        }
        return kept;
      },
    });
  }

  /**
   * The account's settings row, or `null` when it has none.
   *
   * @remarks
   * Algorithm: one read keyed by the account. Failure modes: none of its own. Side effects: none.
   */
  async findSettings({
    scope,
    instagramAccount,
  }: InstagramAccountSettingsTarget): Promise<InstagramAccountSettingsRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.settingsRepository.findByInstagramAccount(instagramAccount),
    });
  }
}
