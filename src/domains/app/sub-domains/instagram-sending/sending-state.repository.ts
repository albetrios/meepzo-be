import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { sending_states } from './sending-state.schema.js';

/** One `app.sending_states` row as Drizzle reads it. */
export type SendingStateRow = typeof sending_states.$inferSelect;

/** The one row's key (`CHECK (id = 1)`). */
const SENDING_STATE_ROW_ID = 1;

/** A whole-number settings version column as a `numeric`, for "newer" comparisons. */
function versionNumber(value: unknown) {
  return sql`(${value})::numeric`;
}

/**
 * Drizzle access to `app.sending_states` (feat-instagram-dm-sending routes-final § 6.A.3, SN7, P16):
 * the one tenantless row. Run only under `MAINTENANCE_SCOPE.SENDING_STATE` on the maintenance login —
 * the row's policy opens to nothing else, and `meepzo_be_app` has no grant.
 *
 * @remarks
 * - **Algorithm:** the row is created only when missing (never overwritten — a restore keeps its
 *   environment id); the settings versions only ever go up, compared as numbers; the app usage keeps
 *   the newer reading.
 * - **Failure modes:** under any other context every statement sees no row (or `42501` on write).
 * - **Side effects:** writes `app.sending_states` only.
 */
export class SendingStateRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** The row, or `null` when it was never created. */
  async find(): Promise<SendingStateRow | null> {
    const rows = await this.db()
      .select()
      .from(sending_states)
      .where(eq(sending_states.id, SENDING_STATE_ROW_ID))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Creates the row with this environment id only when it is missing; returns whether it did. */
  async insertIfMissing({
    environmentId,
    settingsVersion,
    minimumCompatibleSettingsVersion,
  }: {
    environmentId: string;
    settingsVersion: string;
    minimumCompatibleSettingsVersion: string;
  }): Promise<boolean> {
    const rows = await this.db()
      .insert(sending_states)
      .values({
        id: SENDING_STATE_ROW_ID,
        environment_id: environmentId,
        settings_version: settingsVersion,
        minimum_compatible_settings_version: minimumCompatibleSettingsVersion,
      })
      .onConflictDoNothing({ target: sending_states.id })
      .returning({ id: sending_states.id });
    return rows.length > 0;
  }

  /**
   * Writes a release's settings versions (D21, P95): `settings_version` (and its since) only when
   * this one is newer; the minimum only when this release's minimum is higher. Returns the row.
   */
  async raiseSettingsVersions({
    settingsVersion,
    minimumCompatibleSettingsVersion,
  }: {
    settingsVersion: string;
    minimumCompatibleSettingsVersion: string;
  }): Promise<SendingStateRow | null> {
    const isNewer = sql`${versionNumber(settingsVersion)} > ${versionNumber(sending_states.settings_version)}`;
    const isHigherMinimum = sql`${versionNumber(minimumCompatibleSettingsVersion)} > ${versionNumber(sending_states.minimum_compatible_settings_version)}`;
    const rows = await this.db()
      .update(sending_states)
      .set({
        settings_version: sql`CASE WHEN ${isNewer} THEN ${settingsVersion} ELSE ${sending_states.settings_version} END`,
        settings_version_since: sql`CASE WHEN ${isNewer} THEN now() ELSE ${sending_states.settings_version_since} END`,
        minimum_compatible_settings_version: sql`CASE WHEN ${isHigherMinimum} THEN ${minimumCompatibleSettingsVersion} ELSE ${sending_states.minimum_compatible_settings_version} END`,
        updated_at: sql`now()`,
      })
      .where(eq(sending_states.id, SENDING_STATE_ROW_ID))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Lowers the minimum compatible settings version (P95's rollback step, run by an operator before
   * rolling back past an incompatible release). Returns the row, or `null` when there is none.
   */
  async setMinimumCompatibleSettingsVersion(
    minimumCompatibleSettingsVersion: string,
  ): Promise<SendingStateRow | null> {
    const rows = await this.db()
      .update(sending_states)
      .set({ minimum_compatible_settings_version: minimumCompatibleSettingsVersion })
      .where(eq(sending_states.id, SENDING_STATE_ROW_ID))
      .returning();
    return rows[0] ?? null;
  }

  /** Records Meta's app-level usage, keeping the newer reading (S13). */
  async writeAppUsage({
    usagePercent,
    readAt,
  }: {
    usagePercent: number;
    readAt: Date;
  }): Promise<void> {
    await this.db()
      .update(sending_states)
      .set({ app_usage_percent: usagePercent, app_usage_read_at: readAt, updated_at: sql`now()` })
      .where(
        and(
          eq(sending_states.id, SENDING_STATE_ROW_ID),
          or(
            isNull(sending_states.app_usage_read_at),
            lt(sending_states.app_usage_read_at, readAt),
          ),
        ),
      );
  }

  /** The row locked until the unit of work ends (the app-limit decision, plan §33.6). */
  async lockRow(): Promise<SendingStateRow | null> {
    const rows = await this.db()
      .select()
      .from(sending_states)
      .where(eq(sending_states.id, SENDING_STATE_ROW_ID))
      .for('update');
    return rows[0] ?? null;
  }

  /** Records one account's app-limit answer (plan §33.6). */
  async recordAppLimitSeen({ channelAccountId }: { channelAccountId: number }): Promise<void> {
    await this.db()
      .update(sending_states)
      .set({
        app_limit_channel_account_id: channelAccountId,
        app_limit_seen_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(eq(sending_states.id, SENDING_STATE_ROW_ID));
  }

  /** Starts the all-accounts `app_limit` stop until `stopUntil` and counts it (plan §33.6). */
  async startAppLimitStop({ stopUntil }: { stopUntil: Date }): Promise<void> {
    await this.db()
      .update(sending_states)
      .set({
        all_stop_reason: 'app_limit',
        all_stop_until: stopUntil,
        all_stop_count: sql`${sending_states.all_stop_count} + 1`,
        app_limit_channel_account_id: null,
        app_limit_seen_at: null,
        updated_at: sql`now()`,
      })
      .where(eq(sending_states.id, SENDING_STATE_ROW_ID));
  }
}
