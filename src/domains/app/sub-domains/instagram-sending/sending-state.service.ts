import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { env } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { MetaAppUsageStore } from '@/domains/app/sub-domains/channel-connection/channel-connection-usage.types.js';
import { SendingStateRepository, type SendingStateRow } from './sending-state.repository.js';
import {
  SENDING_MINIMUM_COMPATIBLE_SETTINGS_VERSION,
  SENDING_SETTINGS_VERSION,
} from './instagram-sending.constants.js';

/** How long one server trusts its last sending check before reading the row again (SN7: per minute). */
const SENDING_CHECK_REFRESH_MILLISECONDS = 60_000;

/**
 * Why this server may not send (SN7, P95, D20).
 *
 * @remarks
 * Notes: logged with `app.sending_state.sending_refused` and shown in the readiness body (SNC9).
 */
export type SendingRefusalReason =
  | 'sending_disabled'
  | 'environment_id_missing'
  | 'sending_state_missing'
  | 'environment_mismatch'
  | 'settings_version_too_old';

/**
 * The answer of {@link SendingStateService.checkSending}.
 *
 * @remarks
 * Notes: `maySend` is false whenever `reason` is set; the versions are the row's and this build's.
 */
export interface SendingCheck {
  maySend: boolean;
  reason: SendingRefusalReason | null;
  /** The database's newest settings version, or `null` when the row is missing. */
  settingsVersion: string | null;
  /** The database's minimum compatible settings version, or `null` when the row is missing. */
  minimumCompatibleSettingsVersion: string | null;
  /** This build's settings version. */
  serverSettingsVersion: string;
  checkedAt: Date;
}

/** Whether whole-number version `left` is older than `right`. */
function isOlderVersion({ left, right }: { left: string; right: string }): boolean {
  return BigInt(left) < BigInt(right);
}

/**
 * The decision of {@link SendingStateService.checkSending} over values already read — pure, so the
 * rules are tested without a database (SN7, P95, D20).
 *
 * @remarks
 * In order: sending off (`SENDING_ENABLED`) → `sending_disabled`; no environment id →
 * `environment_id_missing`; no row → `sending_state_missing`; another environment's row (a restored
 * or copied database) → `environment_mismatch`; this build older than the row's minimum compatible
 * version → `settings_version_too_old`. An older but compatible build may send (P95).
 */
export function decideSending({
  isSendingEnabled,
  environmentId,
  serverSettingsVersion,
  state,
}: {
  isSendingEnabled: boolean;
  environmentId: string | undefined;
  serverSettingsVersion: string;
  state: Pick<
    SendingStateRow,
    'environment_id' | 'settings_version' | 'minimum_compatible_settings_version'
  > | null;
}): Pick<SendingCheck, 'maySend' | 'reason'> {
  if (!isSendingEnabled) return { maySend: false, reason: 'sending_disabled' };
  if (environmentId === undefined) return { maySend: false, reason: 'environment_id_missing' };
  if (state === null) return { maySend: false, reason: 'sending_state_missing' };
  if (state.environment_id !== environmentId) {
    return { maySend: false, reason: 'environment_mismatch' };
  }
  if (
    isOlderVersion({
      left: serverSettingsVersion,
      right: state.minimum_compatible_settings_version,
    })
  ) {
    return { maySend: false, reason: 'settings_version_too_old' };
  }
  return { maySend: true, reason: null };
}

/**
 * The one global sending row (feat-instagram-dm-sending routes-final § 6 SN7, § 6.A.3, D20, D21,
 * P16, P95, S13): its creation by `prepareDatabase`, each release's settings versions, the "may this
 * server send" check every sender asks, the rollback's minimum lowering and Meta's app-level usage.
 *
 * @remarks
 * Algorithm:
 * - Every read and write runs under `MAINTENANCE_SCOPE.SENDING_STATE` on the maintenance login —
 *   the row has no organization and no other context can see it (P16).
 * - The row is created with the server's `SENDING_ENVIRONMENT_ID` only when missing, never
 *   overwritten: a restore or a Neon branch of production carries production's id and so never
 *   matches a test server's.
 * - `checkSending` reads `env.SENDING_ENABLED` alone (CLAUDE.md env rule 2), then the row.
 *   `mayTakeTickets` keeps its last answer for a minute per process (SN7: read at start and once a
 *   minute).
 *
 * Failure modes: a database failure propagates from the reads; `mayTakeTickets` answers `false` on
 * one (fail closed: no send without a confirmed row) and logs it.
 *
 * Side effects: the row's writes; a warning log when this server may not send.
 *
 * Notes: implements `MetaAppUsageStore` (S13, P107) — the app-level usage is written from the Meta
 * client's recorder, also on request paths (route 2's Meta calls), which is the one request-path
 * entry into this maintenance scope (P307).
 */
export class SendingStateService implements MetaAppUsageStore {
  private lastCheck: SendingCheck | null = null;

  /**
   * Creates the row when it is missing (with `environmentId`) and writes this build's settings
   * versions — `prepareDatabase`'s step (SN7, P95). Returns whether the row was created and the row.
   *
   * @remarks
   * Algorithm: one maintenance unit — insert-if-missing, then the guarded version raise (each only
   * upward). Failure modes: a database failure propagates. Side effects: the row.
   */
  async ensureSendingState({
    environmentId,
  }: {
    environmentId: string;
  }): Promise<{ created: boolean; state: SendingStateRow | null }> {
    return withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.SENDING_STATE,
      callback: async (databaseHandle) => {
        const repository = new SendingStateRepository(databaseHandle);
        const created = await repository.insertIfMissing({
          environmentId,
          settingsVersion: SENDING_SETTINGS_VERSION,
          minimumCompatibleSettingsVersion: SENDING_MINIMUM_COMPATIBLE_SETTINGS_VERSION,
        });
        const state = await repository.raiseSettingsVersions({
          settingsVersion: SENDING_SETTINGS_VERSION,
          minimumCompatibleSettingsVersion: SENDING_MINIMUM_COMPATIBLE_SETTINGS_VERSION,
        });
        return { created, state };
      },
    });
  }

  /**
   * The row, or `null` when it was never created.
   *
   * @remarks
   * Algorithm: one maintenance read. Failure modes: propagates. Side effects: none.
   */
  async readSendingState(): Promise<SendingStateRow | null> {
    return withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.SENDING_STATE,
      callback: (databaseHandle) => new SendingStateRepository(databaseHandle).find(),
    });
  }

  /**
   * Whether this server may send now (SN7, P95, AC-17.21), read fresh.
   *
   * @remarks
   * Algorithm: `env.SENDING_ENABLED` first — off answers without a read; else the row, then
   * {@link decideSending}. Failure modes: a database failure propagates. Side effects: none.
   */
  async checkSending(): Promise<SendingCheck> {
    const checkedAt = new Date(Date.now());
    const state = env.SENDING_ENABLED ? await this.readSendingState() : null;
    const decision = decideSending({
      isSendingEnabled: env.SENDING_ENABLED,
      environmentId: env.SENDING_ENVIRONMENT_ID,
      serverSettingsVersion: SENDING_SETTINGS_VERSION,
      state,
    });
    return {
      ...decision,
      settingsVersion: state?.settings_version ?? null,
      minimumCompatibleSettingsVersion: state?.minimum_compatible_settings_version ?? null,
      serverSettingsVersion: SENDING_SETTINGS_VERSION,
      checkedAt,
    };
  }

  /**
   * Whether this server may take sending tickets — the check every send worker, Meta-calling task
   * and repair duty asks before it works (SN7; the workers are ROUTE rows R37, R42, R47).
   *
   * @remarks
   * Algorithm: the last {@link checkSending} answer while under a minute old, else a fresh one.
   * Failure modes: a failed read answers `false` (fail closed) and is logged. Side effects: a
   * warning log whenever a fresh check refuses.
   */
  async mayTakeTickets(): Promise<boolean> {
    const now = Date.now();
    if (
      this.lastCheck !== null &&
      now - this.lastCheck.checkedAt.getTime() < SENDING_CHECK_REFRESH_MILLISECONDS
    ) {
      return this.lastCheck.maySend;
    }
    try {
      this.lastCheck = await this.checkSending();
    } catch (error) {
      logger.error({ error }, 'app.sending_state.check_failed');
      return false;
    }
    if (!this.lastCheck.maySend) {
      logger.warn(
        {
          reason: this.lastCheck.reason,
          settings_version: this.lastCheck.settingsVersion,
          minimum_compatible_settings_version: this.lastCheck.minimumCompatibleSettingsVersion,
          server_settings_version: this.lastCheck.serverSettingsVersion,
        },
        'app.sending_state.sending_refused',
      );
    }
    return this.lastCheck.maySend;
  }

  /**
   * The last {@link mayTakeTickets} answer of this process, or `null` before the first — the health
   * report's sending part (SNC9).
   *
   * @remarks
   * Algorithm: none — the kept value. Failure modes: none. Side effects: none.
   */
  lastSendingCheck(): SendingCheck | null {
    return this.lastCheck;
  }

  /**
   * Lowers (or sets) the minimum compatible settings version — the rollback step before rolling
   * back past an incompatible release (P95). Returns the row, or `null` when there is none.
   *
   * @remarks
   * Algorithm: one maintenance update. Failure modes: propagates. Side effects: the row; every server
   * re-reads it within a minute.
   */
  async setMinimumCompatibleSettingsVersion(version: string): Promise<SendingStateRow | null> {
    return withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.SENDING_STATE,
      callback: (databaseHandle) =>
        new SendingStateRepository(databaseHandle).setMinimumCompatibleSettingsVersion(version),
    });
  }

  /**
   * Records Meta's app-level usage once for the whole app (S13, P107), keeping the newer reading;
   * the percentage is held to 0–100.
   *
   * @remarks
   * Algorithm: one maintenance update, guarded by `app_usage_read_at`. Failure modes: propagates
   * (the usage recorder logs and drops it). Side effects: the row; nothing when the row is missing.
   */
  async writeAppUsage({
    usagePercent,
    readAt,
  }: {
    usagePercent: number;
    readAt: Date;
  }): Promise<void> {
    const clamped = Math.min(100, Math.max(0, Math.round(usagePercent)));
    await withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.SENDING_STATE,
      callback: (databaseHandle) =>
        new SendingStateRepository(databaseHandle).writeAppUsage({
          usagePercent: clamped,
          readAt,
        }),
    });
  }
}
