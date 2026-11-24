import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { assertTeamOrganization } from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import { assertRecordNotChangedSince } from '@/shared/utils/validation/record-fields.util.js';
import type { ChannelAccountKey } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import type { ChannelFeature } from '@/domains/app/sub-domains/channel-account/channel-account-capabilities.constants.js';
import { channelFeatureRefusalError } from '@/domains/app/sub-domains/channel-account/channel-account-error.util.js';
import type {
  InstagramAccountSettingsRepository,
  InstagramAccountSettingsRow,
} from './instagram-account-settings.repository.js';
import { serializeInstagramAccountSettings } from './instagram-account-settings.serializer.js';
import type {
  InstagramAccountSettingsChanges,
  InstagramAccountSettingsChannelAccountPort,
  InstagramAccountSettingsFieldChange,
  InstagramAccountSettingsLanePort,
  InstagramAccountSettingsUpdateInput,
  InstagramAccountSettingsUpdateResult,
} from './instagram-account-settings.types.js';
import { assertMergedSettingsValid } from './instagram-account-settings.validator.js';

/** The settings columns whose change gives the slow and reply lanes a new turn (IA14). */
const LANE_LIMIT_FIELDS = [
  'opening_hour_limit',
  'opening_day_limit',
  'fast_hour_limit',
  'person_hour_limit',
  'broadcast_hour_limit',
] as const satisfies readonly (keyof InstagramAccountSettingsChanges)[];

/**
 * The organization scope and the channel account a settings call acts on.
 *
 * @remarks
 * Notes: the scope's organization must be the account's — under any other the settings row is
 * invisible and unwritable (RLS).
 */
export interface InstagramAccountSettingsTarget {
  /** The caller's organization scope; nested in the caller's unit of work when one is open. */
  scope: OrganizationPrincipalDatabaseScope;
  /** The account's organization and channel account internal id. */
  channelAccount: ChannelAccountKey;
}

/** Whether two stored values are the same (stop-word lists compared element by element). */
function isSameValue({ left, right }: { left: unknown; right: unknown }): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

/** The fields whose saved value the change actually moves, with their old and new values. */
function diffChanges({
  saved,
  changes,
}: {
  saved: InstagramAccountSettingsRow;
  changes: InstagramAccountSettingsChanges;
}): Record<string, InstagramAccountSettingsFieldChange> {
  const diff: Record<string, InstagramAccountSettingsFieldChange> = {};
  for (const [field, newValue] of Object.entries(changes)) {
    if (newValue === undefined) continue;
    const oldValue = saved[field as keyof InstagramAccountSettingsChanges];
    if (!isSameValue({ left: oldValue, right: newValue })) {
      diff[field] = { old_value: oldValue, new_value: newValue };
    }
  }
  return diff;
}

/**
 * The features a change turns on (IA13): the extra delay set where it was off (PRO, P83), mark as
 * seen turned on (Meta-test-gated, P36). Clearing or keeping either is never checked (P10).
 */
function featuresTurnedOn({
  saved,
  changes,
}: {
  saved: InstagramAccountSettingsRow;
  changes: InstagramAccountSettingsChanges;
}): ChannelFeature[] {
  const features: ChannelFeature[] = [];
  const isDelaySent =
    (changes.extra_delay_seconds_min ?? null) !== null ||
    (changes.extra_delay_seconds_max ?? null) !== null;
  if (isDelaySent && saved.extra_delay_seconds_min === null) features.push('extra_delay');
  if (
    changes.is_mark_seen_after_reply_enabled === true &&
    !saved.is_mark_seen_after_reply_enabled
  ) {
    features.push('mark_seen');
  }
  return features;
}

/**
 * The Instagram account settings service (feat-instagram-dm-sending routes-final § 2.B): creates the
 * empty row at the pick, reads it for the account object (route 7) and event processing, and
 * changes it (route 12, IA12–IA14).
 *
 * @remarks
 * Algorithm:
 * - Every method runs in `withAppDatabaseContext` with the caller's organization scope; called
 *   inside the pick's transaction it joins it, so the account and its settings commit together.
 *
 * Failure modes:
 * - An account of another organization than the scope's: no row is read or written.
 * - Route 12: `422` on a personal organization, `404 channel_account_not_found`, `400` naming the
 *   field, `403 plan_lacks_feature`, `422 feature_not_offered`, `409 permission_not_granted`,
 *   `409 record_changed` (2.B.9).
 *
 * Side effects:
 * - {@link InstagramAccountSettingsService.createDefaultSettings} may insert one
 *   `app.instagram_account_settings` row; {@link InstagramAccountSettingsService.updateSettings}
 *   changes it and the channel account's automation switch (through the channel account, P42) in
 *   one commit, then wakes the lanes after a limit change. The audit entry is the controller's,
 *   after commit.
 *
 * Notes:
 * - The settings row is written through this service only, never by the account's repository
 *   (2.B.10). The channel account is reached through {@link InstagramAccountSettingsChannelAccountPort}
 *   (the channel account service depends on this one, so it cannot be a constructor service here);
 *   the lane wake through {@link InstagramAccountSettingsLanePort} (sub-domain 6's lane service, R18).
 *   No cache (IA14).
 */
export class InstagramAccountSettingsService {
  constructor(
    private readonly settingsRepository: InstagramAccountSettingsRepository,
    private readonly channelAccountPort: InstagramAccountSettingsChannelAccountPort,
    private readonly organizationService: OrganizationService,
    private readonly lanePort?: InstagramAccountSettingsLanePort,
  ) {}

  /**
   * Gives the account its empty settings when it has none and returns its settings row — the new
   * row on a first pick, the kept row on a reconnect or a pick back (MC7).
   *
   * @remarks
   * Algorithm: insert-if-absent, then read the kept row when one was already there. Failure modes:
   * throws when neither the insert nor the read finds a row (the account is not in the scope's
   * organization). Side effects: may insert the settings row.
   */
  async createDefaultSettings({
    scope,
    channelAccount,
  }: InstagramAccountSettingsTarget): Promise<InstagramAccountSettingsRow> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const created = await this.settingsRepository.insertDefaults(channelAccount);
        if (created !== null) return created;
        const kept = await this.settingsRepository.findByChannelAccount(channelAccount);
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
   * Algorithm: one read keyed by the channel account. Failure modes: none of its own. Side
   * effects: none.
   */
  async findSettings({
    scope,
    channelAccount,
  }: InstagramAccountSettingsTarget): Promise<InstagramAccountSettingsRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.settingsRepository.findByChannelAccount(channelAccount),
    });
  }

  /**
   * Route 12 (IA12–IA14): changes one account's settings and, when sent, its automation switch, and
   * returns the settings as saved with the account's public id and the changed fields (old and new
   * values) for the caller's audit entry.
   *
   * @remarks
   * Algorithm:
   * 1. One read unit: the organization must be a team (`422`, capability `INSTAGRAM`); the account
   *    — not revoked, `instagram` (`404 channel_account_not_found`); its saved settings.
   * 2. Outside any unit: each feature the change turns on goes through the one feature check
   *    (CA11) — the extra delay (`403 plan_lacks_feature` without the plan's `extra_delay` switch,
   *    P83), mark as seen (`422 feature_not_offered` while untested, P36); a connection lacking the
   *    permission → `409 permission_not_granted`.
   * 3. One commit: the settings row locked `FOR UPDATE`; `expected_updated_at` older → `409
   *    record_changed`; the merged checks (`400`); the settings written with `updated_by_user_id` and
   *    `updated_at`; the switch written on the channel account (P42).
   * 4. After commit: a changed limit gives the account's lanes a new turn (IA14, sub-domain 6).
   *
   * Failure modes: as above. Side effects: the settings row and the channel account's switch; the
   * lane wake. Works on an `error` account. Never calls Meta.
   */
  async updateSettings({
    scope,
    channelAccountPublicId,
    changes,
    isAutomationEnabled,
    expectedUpdatedAt,
    updatedByUserPublicId,
  }: InstagramAccountSettingsUpdateInput): Promise<InstagramAccountSettingsUpdateResult> {
    const { organizationId, channelAccountId, saved } = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const account = await this.channelAccountPort.requireLiveInstagramAccount({
          scope,
          organizationId: organization.id,
          channelAccountPublicId,
        });
        const row = await this.requireSettings({
          organizationId: organization.id,
          channelAccountId: account.id,
        });
        return { organizationId: organization.id, channelAccountId: account.id, saved: row };
      },
    });
    for (const feature of featuresTurnedOn({ saved, changes })) {
      const check = await this.channelAccountPort.canChannelAccountUseFeature({
        scope,
        organizationId,
        channelAccountId,
        feature,
      });
      if (!check.isAllowed) throw channelFeatureRefusalError(check.reason);
    }
    const key: ChannelAccountKey = { organizationId, channelAccountId };
    const result = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const locked = await this.settingsRepository.findByChannelAccountForUpdate(key);
        if (locked === null) throw new Error('instagram account has no settings row');
        await assertRecordNotChangedSince({
          row: locked,
          expected: expectedUpdatedAt,
          resolveUserPublicId: (userInternalId) =>
            this.organizationService.resolveUserPublicIdByInternalId(userInternalId),
        });
        assertMergedSettingsValid({ saved: locked, changes });
        const account = await this.channelAccountPort.requireLiveInstagramAccount({
          scope,
          organizationId,
          channelAccountPublicId,
        });
        const updatedByUserId =
          await this.organizationService.resolveUserInternalIdByPublicId(updatedByUserPublicId);
        const updated = await this.settingsRepository.update({
          ...key,
          changes,
          updatedByUserId,
        });
        if (updated === null) throw new Error('instagram account settings row vanished');
        const switched =
          isAutomationEnabled === undefined
            ? account
            : await this.channelAccountPort.setAutomationEnabled({
                scope,
                ...key,
                isAutomationEnabled,
              });
        const fieldChanges = diffChanges({ saved: locked, changes });
        if (account.is_automation_enabled !== switched.is_automation_enabled) {
          fieldChanges.is_automation_enabled = {
            old_value: account.is_automation_enabled,
            new_value: switched.is_automation_enabled,
          };
        }
        return {
          settings: serializeInstagramAccountSettings({
            settings: updated,
            channel_account: switched,
            updated_by_user_public_id:
              updatedByUserId === null ? null : (updatedByUserPublicId ?? null),
            now: new Date(Date.now()),
          }),
          channelAccountPublicId: account.public_id,
          changes: fieldChanges,
        };
      },
    });
    if (LANE_LIMIT_FIELDS.some((field) => field in result.changes)) {
      await this.lanePort?.wakeLanes({ scope, organizationId, channelAccountId });
    }
    return result;
  }

  /** The account's settings row — the pick always writes it with the account (2.B.10). */
  private async requireSettings(key: ChannelAccountKey): Promise<InstagramAccountSettingsRow> {
    const settings = await this.settingsRepository.findByChannelAccount(key);
    if (settings === null) throw new Error('instagram account has no settings row');
    return settings;
  }
}
