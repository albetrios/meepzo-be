import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { env } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { MetaAppUsageStore } from '@/domains/app/sub-domains/channel-connection/channel-connection-usage.types.js';
import { SendingStateRepository, type SendingStateRow } from './sending-state.repository.js';
import {
  INSTAGRAM_SEND_CORE_SETTINGS,
  INSTAGRAM_SENDING_WATCH_SETTINGS,
  SENDING_MINIMUM_COMPATIBLE_SETTINGS_VERSION,
  SENDING_SETTINGS_VERSION,
} from './instagram-sending.constants.js';
import { ladderStep } from './instagram-send-error.util.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import { readWorkerClockReading } from '@/infrastructure/queue/worker-runtime/worker-clock-watch.js';

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
  | 'settings_version_too_old'
  | 'clock_skew';

/**
 * Whether this server's clock is in line with Postgres's (WC-23, AC-17.23): a reading within
 * `INSTAGRAM_SENDING_WATCH_SETTINGS.clockSkewMaxMilliseconds`. No reading (never read, or the last
 * read failed) is not in line — fail closed.
 *
 * @remarks
 * Algorithm: `|skew| ≤ max`. Failure modes: none. Side effects: none.
 */
export function isServerClockInLine(skewMilliseconds: number | null): boolean {
  return (
    skewMilliseconds !== null &&
    Math.abs(skewMilliseconds) <= INSTAGRAM_SENDING_WATCH_SETTINGS.clockSkewMaxMilliseconds
  );
}

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
 * What the all-accounts stop asks of a lane now (plan §33.5 rule 3, §33.6 rules 2–3; ROUTE row
 * R62): `free`; `stopped` until its end; `test_due` — the stop is over and no lane took its one test
 * yet; `testing` — another lane holds the test until `until`; `releasing` — the test passed at
 * `releaseStartedAt` and the lanes go back one by one over the spread.
 *
 * @remarks
 * Notes: decided by {@link decideAllAccountsGate}; the send core's hold reads it each turn.
 */
export type AllAccountsGate =
  | { kind: 'free' }
  | { kind: 'stopped'; reason: string; until: Date }
  | { kind: 'test_due'; reason: string }
  | { kind: 'testing'; reason: string; until: Date }
  | { kind: 'releasing'; releaseStartedAt: Date };

/**
 * The gate of {@link AllAccountsGate} over the row's columns — pure, so the rules are tested
 * without a database.
 *
 * @remarks
 * Algorithm: no stop → `free`; its end ahead → `stopped`; no release yet → `testing` while a
 * lane's test lease runs, else `test_due`; a release under its spread → `releasing`; else `free`.
 * Failure modes: none. Side effects: none.
 */
export function decideAllAccountsGate({
  state,
  now,
}: {
  state: Pick<
    SendingStateRow,
    | 'all_stop_reason'
    | 'all_stop_until'
    | 'testing_lane'
    | 'testing_until'
    | 'all_release_started_at'
  > | null;
  now: Date;
}): AllAccountsGate {
  if (state?.all_stop_reason == null || state.all_stop_until === null) return { kind: 'free' };
  const reason = state.all_stop_reason;
  if (state.all_stop_until.getTime() > now.getTime()) {
    return { kind: 'stopped', reason, until: state.all_stop_until };
  }
  const releaseStartedAt = state.all_release_started_at;
  if (releaseStartedAt === null) {
    return state.testing_until !== null && state.testing_until.getTime() > now.getTime()
      ? { kind: 'testing', reason, until: state.testing_until }
      : { kind: 'test_due', reason };
  }
  const spread = INSTAGRAM_SEND_CORE_SETTINGS.allReleaseSpreadMinutes * MILLISECONDS_PER_MINUTE;
  return now.getTime() < releaseStartedAt.getTime() + spread
    ? { kind: 'releasing', releaseStartedAt }
    : { kind: 'free' };
}

/**
 * When one lane goes again after the all-accounts test passed (plan §33.6 rule 3): the release
 * start plus the lane's own place in the 5-minute spread — the same place for the same lane, the
 * lanes of the app spread evenly by a hash of the account and the lane.
 *
 * @remarks
 * Algorithm: a multiplicative hash of (account id, lane index) to a fraction of the spread.
 * Failure modes: none. Side effects: none.
 */
export function allAccountsReleaseAt({
  releaseStartedAt,
  channelAccountId,
  laneIndex,
}: {
  releaseStartedAt: Date;
  channelAccountId: number;
  laneIndex: number;
}): Date {
  const spread = INSTAGRAM_SEND_CORE_SETTINGS.allReleaseSpreadMinutes * MILLISECONDS_PER_MINUTE;
  const hash = Math.imul(channelAccountId * 4 + laneIndex + 1, 2_654_435_761) >>> 0;
  return new Date(releaseStartedAt.getTime() + Math.floor((hash / 2 ** 32) * spread));
}

/**
 * How the all-accounts test ended (plan §33.4's table, applied to §33.6 rule 2).
 *
 * @remarks
 * Notes: `good` releases the lanes, `bad` restarts the stop one step longer, `unclear` the same
 * step, `none` frees the test for the next lane ({@link SendingStateService.finishAllAccountsTest}).
 */
export type AllAccountsTestOutcome = 'good' | 'bad' | 'unclear' | 'none';

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
  private isClockRefusalLogged = false;

  constructor(
    private readonly options: {
      /** This process's clock skew against Postgres (WC-23); the worker clock watch by default. */
      readClockSkewMilliseconds?: (() => number | null) | undefined;
    } = {},
  ) {}

  private readClockSkewMilliseconds(): number | null {
    return (
      this.options.readClockSkewMilliseconds ?? (() => readWorkerClockReading().skewMilliseconds)
    )();
  }

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
   * Algorithm: this server's clock first — over 2 s from Postgres's (or never read) answers
   * `false` until the clock watch sees it in line (WC-23, AC-17.23; read live, never kept); then the
   * last {@link checkSending} answer while under a minute old, else a fresh one.
   * Failure modes: a failed read answers `false` (fail closed) and is logged. Side effects: a
   * warning log whenever a fresh check refuses, and once when the clock refuses.
   */
  async mayTakeTickets(): Promise<boolean> {
    const skewMilliseconds = this.readClockSkewMilliseconds();
    if (!isServerClockInLine(skewMilliseconds)) {
      if (!this.isClockRefusalLogged) {
        logger.warn(
          { reason: 'clock_skew', skew_milliseconds: skewMilliseconds },
          'app.sending_state.sending_refused',
        );
        this.isClockRefusalLogged = true;
      }
      return false;
    }
    this.isClockRefusalLogged = false;
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

  /**
   * One account met Meta's app limit (plan §33.6, AC-17.11): when another account met it within
   * {@link INSTAGRAM_SEND_CORE_SETTINGS}`.appLimitWindowMinutes`, every account stops (`app_limit`,
   * 15 · 30 · 60 minutes by its count) — answers `all`; else the sighting is kept and the caller
   * stops that lane as "too fast" — answers `lane`.
   *
   * @remarks
   * Algorithm: one maintenance unit with the row locked. Failure modes: propagates. Side effects:
   * the row. Notes: no row (sending never set up) answers `lane`.
   */
  async recordAppLimit({
    channelAccountId,
    now = new Date(),
  }: {
    channelAccountId: number;
    now?: Date | undefined;
  }): Promise<'all' | 'lane'> {
    return withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.SENDING_STATE,
      callback: async (databaseHandle) => {
        const repository = new SendingStateRepository(databaseHandle);
        const row = await repository.lockRow();
        if (row === null) return 'lane';
        const windowStart =
          now.getTime() -
          INSTAGRAM_SEND_CORE_SETTINGS.appLimitWindowMinutes * MILLISECONDS_PER_MINUTE;
        const isSecondAccount =
          row.app_limit_seen_at !== null &&
          row.app_limit_seen_at.getTime() >= windowStart &&
          row.app_limit_channel_account_id !== channelAccountId;
        if (!isSecondAccount) {
          await repository.recordAppLimitSeen({ channelAccountId });
          return 'lane';
        }
        const minutes = ladderStep({
          ladder: INSTAGRAM_SEND_CORE_SETTINGS.appStopMinutes,
          stopCount: row.all_stop_count,
        });
        await repository.startAppLimitStop({
          stopUntil: new Date(now.getTime() + minutes * MILLISECONDS_PER_MINUTE),
        });
        return 'all';
      },
    });
  }

  /**
   * Starts the all-accounts `instagram_down` stop (plan §33.5 rule 3, WC-22 — ROUTE row R48) when
   * no all-accounts stop holds now: 5 · 10 · 20 · 40 minutes by the row's `all_stop_count`.
   * Answers the stop's end, or `null` when one already held (nothing changed) or there is no row.
   *
   * @remarks
   * Algorithm: one maintenance unit with the row locked — a live stop wins (an app limit is not
   * overwritten, a down stop is not lengthened: the lanes test after it). Failure modes:
   * propagates. Side effects: the row.
   */
  async startAllAccountsDownStop({ now = new Date() }: { now?: Date } = {}): Promise<Date | null> {
    return withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.SENDING_STATE,
      callback: async (databaseHandle) => {
        const repository = new SendingStateRepository(databaseHandle);
        const row = await repository.lockRow();
        if (row === null) return null;
        if (row.all_stop_until !== null && row.all_stop_until.getTime() > now.getTime()) {
          return null;
        }
        const minutes = ladderStep({
          ladder: INSTAGRAM_SENDING_WATCH_SETTINGS.allDownStopMinutes,
          stopCount: row.all_stop_count,
        });
        const stopUntil = new Date(now.getTime() + minutes * MILLISECONDS_PER_MINUTE);
        await repository.startAllStop({ reason: 'instagram_down', stopUntil });
        return stopUntil;
      },
    });
  }

  /**
   * Clears an all-accounts stop that ended over 24 quiet hours ago, so the next one starts at the
   * first step again (plan §33.6 rule 4, WC-22). Answers whether it cleared one.
   *
   * @remarks
   * Algorithm: one guarded maintenance update. Failure modes: propagates. Side effects: the row.
   */
  async resetQuietAllStop({ now = new Date() }: { now?: Date } = {}): Promise<boolean> {
    const endedBefore = new Date(
      now.getTime() -
        INSTAGRAM_SENDING_WATCH_SETTINGS.allStopCountResetHours * 60 * MILLISECONDS_PER_MINUTE,
    );
    return withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.SENDING_STATE,
      callback: (databaseHandle) =>
        new SendingStateRepository(databaseHandle).clearAllStopEndedBefore(endedBefore),
    });
  }

  /**
   * The all-accounts stop holding every lane now (6.A.3), or `null`.
   *
   * @remarks
   * Algorithm: one maintenance read. Failure modes: propagates. Side effects: none.
   */
  async readAllAccountsStop(
    now: Date = new Date(),
  ): Promise<{ reason: string; until: Date } | null> {
    const row = await this.readSendingState();
    if (row?.all_stop_until == null || row.all_stop_reason === null) return null;
    return row.all_stop_until.getTime() > now.getTime()
      ? { reason: row.all_stop_reason, until: row.all_stop_until }
      : null;
  }

  /**
   * The all-accounts gate now ({@link decideAllAccountsGate} over the row).
   *
   * @remarks
   * Algorithm: one maintenance read. Failure modes: propagates. Side effects: none.
   */
  async readAllAccountsGate(now: Date = new Date()): Promise<AllAccountsGate> {
    return decideAllAccountsGate({ state: await this.readSendingState(), now });
  }

  /**
   * Takes the one all-accounts test for `lane` (plan §33.6 rule 2, ROUTE row R62): only while the
   * gate is `test_due`, for `testLeaseMinutes`. Answers the stop's reason when this lane holds the
   * test, else `null`.
   *
   * @remarks
   * Algorithm: one maintenance unit with the row locked, the gate decided again under the lock.
   * Failure modes: propagates. Side effects: `testing_lane`, `testing_until`.
   */
  async claimAllAccountsTest({
    lane,
    now = new Date(),
  }: {
    lane: string;
    now?: Date;
  }): Promise<string | null> {
    return withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.SENDING_STATE,
      callback: async (databaseHandle) => {
        const repository = new SendingStateRepository(databaseHandle);
        const gate = decideAllAccountsGate({ state: await repository.lockRow(), now });
        if (gate.kind !== 'test_due') return null;
        await repository.writeAllStopTest({
          testingLane: lane,
          testingUntil: new Date(
            now.getTime() + INSTAGRAM_SEND_CORE_SETTINGS.testLeaseMinutes * MILLISECONDS_PER_MINUTE,
          ),
        });
        return gate.reason;
      },
    });
  }

  /**
   * Ends the all-accounts test (plan §33.6 rules 1–3 with §33.4's table, ROUTE row R62): `good` →
   * the release starts now (the lanes go back over 5 minutes at half speed); `bad` → the stop again
   * for its next step, counted; `unclear` → the same step again, not counted; `none` (nothing to
   * send, a problem with that person or text) → the test is free for the next lane.
   *
   * @remarks
   * Algorithm: one maintenance unit with the row locked; nothing when no stop is on the row.
   * Failure modes: propagates. Side effects: the row's test, release and stop columns.
   */
  async finishAllAccountsTest({
    outcome,
    now = new Date(),
  }: {
    outcome: AllAccountsTestOutcome;
    now?: Date;
  }): Promise<void> {
    await withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.SENDING_STATE,
      callback: async (databaseHandle) => {
        const repository = new SendingStateRepository(databaseHandle);
        const row = await repository.lockRow();
        if (row?.all_stop_reason == null) return;
        const free = { testingLane: null, testingUntil: null };
        if (outcome === 'good') {
          await repository.writeAllStopTest({ ...free, releaseStartedAt: now });
          return;
        }
        if (outcome === 'none') {
          await repository.writeAllStopTest(free);
          return;
        }
        const ladder =
          row.all_stop_reason === 'app_limit'
            ? INSTAGRAM_SEND_CORE_SETTINGS.appStopMinutes
            : INSTAGRAM_SENDING_WATCH_SETTINGS.allDownStopMinutes;
        const minutes = ladderStep({
          ladder,
          stopCount: outcome === 'bad' ? row.all_stop_count : Math.max(row.all_stop_count - 1, 0),
        });
        await repository.writeAllStopTest({
          ...free,
          stopUntil: new Date(now.getTime() + minutes * MILLISECONDS_PER_MINUTE),
          isCountedAgain: outcome === 'bad',
        });
      },
    });
  }
}
