import { and, eq, inArray, sql } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { AUTOMATION_COUNT_SLOTS } from './automation.constants.js';
import { automations } from './automation.schema.js';
import { type AutomationCountsByVersion, automation_counts } from './automation-count.schema.js';

/** One slot row of `app.automation_counts` as Drizzle reads it. */
export type AutomationCountRow = typeof automation_counts.$inferSelect;

/** One `+1` of an automation's counters (AU19), with the step version it counts for. */
export interface AutomationCountIncrement {
  organizationId: number;
  automationId: number;
  /** The run's `id` — its slot is `id mod 16`. */
  automationRunId: number;
  counter: 'runs_started' | 'taps' | 'typed_answers';
  /** The step version (`hello.1`), or `null` for the total alone. */
  versionKey: string | null;
}

/** The by-version column of each counter. */
const BY_VERSION_COLUMN = {
  runs_started: 'runs_by_version',
  taps: 'taps_by_version',
  typed_answers: 'typed_by_version',
} as const;

/**
 * Drizzle access to `app.automation_counts` (feat-instagram-dm-sending routes-final § 4.A.3, AU19):
 * the `+1` the run engine writes in the event's commit (ROUTE row R14) and the slot rows the list and
 * the read sum.
 *
 * @remarks
 * - **Algorithm:** one `INSERT … ON CONFLICT (organization_id, automation_id, slot) DO UPDATE` per
 *   increment, the per-version object merged in SQL (`jsonb_set`); reads return the slot rows and
 *   the caller sums them (at most 16 per automation).
 * - **Failure modes:** a missing automation throws the composite key's 23503.
 * - **Side effects:** writes `app.automation_counts`; reads `app.automations` for an account total.
 */
export class AutomationCountRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** Adds one to a counter (and its version) in the run's slot row. */
  async increment(input: AutomationCountIncrement): Promise<void> {
    const slot = input.automationRunId % AUTOMATION_COUNT_SLOTS;
    const byVersion = BY_VERSION_COLUMN[input.counter];
    const versionPatch: AutomationCountsByVersion =
      input.versionKey === null ? {} : { [input.versionKey]: 1 };
    await this.db()
      .insert(automation_counts)
      .values({
        organization_id: input.organizationId,
        automation_id: input.automationId,
        slot,
        [input.counter]: 1,
        [byVersion]: versionPatch,
      })
      .onConflictDoUpdate({
        target: [
          automation_counts.organization_id,
          automation_counts.automation_id,
          automation_counts.slot,
        ],
        set: {
          [input.counter]: sql`${automation_counts[input.counter]} + 1`,
          ...(input.versionKey === null
            ? {}
            : {
                [byVersion]: sql`jsonb_set(${automation_counts[byVersion]}, ARRAY[${input.versionKey}]::text[], to_jsonb(coalesce((${automation_counts[byVersion]} ->> ${input.versionKey})::bigint, 0) + 1))`,
              }),
          updated_at: sql`now()`,
        },
      });
  }

  /** The slot rows of the given automations (route 27's page, route 29's one). */
  async listForAutomations({
    organizationId,
    automationIds,
  }: {
    organizationId: number;
    automationIds: readonly number[];
  }): Promise<AutomationCountRow[]> {
    if (automationIds.length === 0) return [];
    return this.db()
      .select()
      .from(automation_counts)
      .where(
        and(
          eq(automation_counts.organization_id, organizationId),
          inArray(automation_counts.automation_id, [...automationIds]),
        ),
      );
  }

  /** The runs started by one account's live automations, all time (route 27's `meta.totals`). */
  async sumRunsStartedOfAccount({
    organizationId,
    channelAccountId,
  }: {
    organizationId: number;
    channelAccountId: number;
  }): Promise<number> {
    const [row] = await this.db()
      .select({ total: sql<string>`coalesce(sum(${automation_counts.runs_started}), 0)::text` })
      .from(automation_counts)
      .innerJoin(
        automations,
        and(
          eq(automations.organization_id, automation_counts.organization_id),
          eq(automations.id, automation_counts.automation_id),
        ),
      )
      .where(
        and(
          eq(automation_counts.organization_id, organizationId),
          eq(automations.channel_account_id, channelAccountId),
          sql`${automations.deleted_at} IS NULL`,
        ),
      );
    return Number(row?.total ?? 0);
  }
}

/** {@link AutomationCountRepository} bound to a job's organization handle (the run engine, R14). */
export function createWorkerAutomationCountRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationCountRepository {
  assertWorkerDatabaseContext(['organization']);
  return new AutomationCountRepository(databaseHandle);
}
