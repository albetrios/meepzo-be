import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { assertTeamOrganization } from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import { assertRecordNotChangedSince } from '@/shared/utils/validation/record-fields.util.js';
import type {
  InstagramAccountKey,
  InstagramAccountRepository,
} from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { instagramNotConnectedError } from '@/domains/app/sub-domains/instagram-account/instagram-account-error.util.js';
import type {
  InstagramAccountSettingsRepository,
  InstagramAccountSettingsRow,
} from './instagram-account-settings.repository.js';
import { serializeInstagramAccountSettings } from './instagram-account-settings.serializer.js';
import type {
  InstagramAccountSettingsUpdateInput,
  InstagramAccountSettingsUpdateResult,
} from './instagram-account-settings.types.js';
import { assertPublicReplyGapOrder } from './instagram-account-settings.validator.js';

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
 * first connect, reads it for the account object (route 2) and event processing, and changes it
 * (route 3, IA15).
 *
 * @remarks
 * Algorithm:
 * - Every method runs in `withAppDatabaseContext` with the caller's organization scope; called
 *   inside the connect transaction it joins it, so the account and its settings commit together.
 *
 * Failure modes:
 * - An account of another organization than the scope's: no row is read or written.
 * - Route 3: `422` on a personal organization, `404 instagram_not_connected`,
 *   `409 record_changed`, `400` on `public_reply_gap_max_seconds` (1.B.9).
 *
 * Side effects:
 * - {@link InstagramAccountSettingsService.createDefaultSettings} may insert one
 *   `app.instagram_account_settings` row; {@link InstagramAccountSettingsService.updateSettings}
 *   changes it. Nothing else writes; the audit entry is the controller's, after commit.
 *
 * Notes:
 * - The settings row is written through this service only, never by the account's repository
 *   (1.B.10). It reads the account through the account's repository (the live account of the
 *   organization) — the account service already depends on this one, so it cannot call back. No
 *   cache at launch (IA15).
 */
export class InstagramAccountSettingsService {
  constructor(
    private readonly settingsRepository: InstagramAccountSettingsRepository,
    private readonly accountRepository: InstagramAccountRepository,
    private readonly organizationService: OrganizationService,
  ) {}

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

  /**
   * Changes the organization's account settings (route 3, IA15) and returns them as saved, with
   * the account's public id for the caller's audit entry.
   *
   * @remarks
   * Algorithm — one unit of work in the caller's organization scope:
   * 1. The organization must be a team (`422`, capability `INSTAGRAM`).
   * 2. Its account that is not revoked — `connected`, `expired` or `error`, so the switch can be
   *    turned off while a reconnect is pending; none → `404 instagram_not_connected`.
   * 3. The settings row, locked `FOR UPDATE`.
   * 4. `expected_updated_at` older than the saved row → `409 record_changed` (who and when).
   * 5. The merged gap: maximum below minimum → `400` on `public_reply_gap_max_seconds`.
   * 6. Write the change with `updated_by_user_id` (the caller; `null` for an API key) and
   *    `updated_at`.
   *
   * Failure modes: as above; the table's checks hold the same rules. Side effects: the one row
   * update. Never calls Instagram.
   */
  async updateSettings({
    scope,
    changes,
    expectedUpdatedAt,
    updatedByUserPublicId,
  }: InstagramAccountSettingsUpdateInput): Promise<InstagramAccountSettingsUpdateResult> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const account = await this.accountRepository.findLiveByOrganizationId(organization.id);
        if (account === null) throw instagramNotConnectedError();
        const key: InstagramAccountKey = {
          organizationId: organization.id,
          instagramAccountId: account.id,
        };
        const saved = await this.settingsRepository.findByInstagramAccountForUpdate(key);
        if (saved === null) {
          // The connect transaction always writes the settings row with the account (1.B.10).
          throw new Error('instagram account has no settings row');
        }
        await assertRecordNotChangedSince({
          row: saved,
          expected: expectedUpdatedAt,
          resolveUserPublicId: (userInternalId) =>
            this.organizationService.resolveUserPublicIdByInternalId(userInternalId),
        });
        assertPublicReplyGapOrder({ saved, changes });
        const updatedByUserId =
          await this.organizationService.resolveUserInternalIdByPublicId(updatedByUserPublicId);
        const updated = await this.settingsRepository.update({
          ...key,
          changes,
          updatedByUserId,
        });
        if (updated === null) throw new Error('instagram account settings row vanished');
        return {
          settings: serializeInstagramAccountSettings({
            settings: updated,
            updated_by_user_public_id:
              updatedByUserId === null ? null : (updatedByUserPublicId ?? null),
          }),
          instagramAccountPublicId: account.public_id,
        };
      },
    });
  }
}
