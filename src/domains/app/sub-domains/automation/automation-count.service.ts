import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type {
  AutomationCountIncrement,
  AutomationCountRepository,
  AutomationCountRow,
} from './automation-count.repository.js';
import type { AutomationCountsOutput } from './automation.types.js';
import { emptyAutomationCounts } from './automation.serializer.js';

/** `(taps + typed answers) / runs` as a percent with one decimal; `null` before the first run (D61). */
function tappedPercent({
  runsStarted,
  answered,
}: {
  runsStarted: number;
  answered: number;
}): number | null {
  if (runsStarted === 0) return null;
  return Math.round((answered / runsStarted) * 1000) / 10;
}

/**
 * Sums the 16 slot rows of each automation into its counts (AU19, D61): totals, `% tapped` and the
 * per-version numbers (`{ "hello.1": { runs_started, taps, typed_answers } }`).
 *
 * @remarks
 * Pure. A version key present in one counter only shows 0 for the others.
 */
export function sumAutomationCounts(
  rows: readonly AutomationCountRow[],
): Map<number, AutomationCountsOutput> {
  const byAutomation = new Map<number, AutomationCountsOutput>();
  for (const row of rows) {
    const counts = byAutomation.get(row.automation_id) ?? emptyAutomationCounts();
    counts.runs_started += Number(row.runs_started);
    counts.taps += Number(row.taps);
    counts.typed_answers += Number(row.typed_answers);
    for (const [counter, values] of [
      ['runs_started', row.runs_by_version],
      ['taps', row.taps_by_version],
      ['typed_answers', row.typed_by_version],
    ] as const) {
      for (const [versionKey, value] of Object.entries(values)) {
        const version = counts.by_version[versionKey] ?? {
          runs_started: 0,
          taps: 0,
          typed_answers: 0,
        };
        version[counter] += Number(value);
        counts.by_version[versionKey] = version;
      }
    }
    byAutomation.set(row.automation_id, counts);
  }
  for (const counts of byAutomation.values()) {
    counts.tapped_percent = tappedPercent({
      runsStarted: counts.runs_started,
      answered: counts.taps + counts.typed_answers,
    });
  }
  return byAutomation;
}

/**
 * The automation count service (feat-instagram-dm-sending routes-final § 4.A, AU19): the `+1` the
 * run engine writes in the event's commit (ROUTE row R14 calls {@link AutomationCountService.increment}
 * on its unit's handle) and the summed counts routes 27 and 29 show.
 *
 * @remarks
 * Algorithm: reads in the caller's organization scope (`withAppDatabaseContext` joins an open unit);
 * the sums are {@link sumAutomationCounts}. Failure modes: none of its own. Side effects: the
 * increment writes one slot row. Notes: the counts survive the 90-day run delete — no run key.
 */
export class AutomationCountService {
  constructor(private readonly repository: AutomationCountRepository) {}

  /**
   * Adds one to a counter in the caller's unit of work, last in its lock order (AU19).
   *
   * @remarks
   * Algorithm: one upsert. Failure modes: as the repository. Side effects: one slot row.
   */
  async increment({
    scope,
    increment,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    increment: AutomationCountIncrement;
  }): Promise<void> {
    await withAppDatabaseContext({
      scope,
      callback: () => this.repository.increment(increment),
    });
  }

  /**
   * Each automation's summed counts, in the caller's unit; an automation without rows is absent.
   *
   * @remarks
   * Algorithm: one read, then {@link sumAutomationCounts}. Failure modes: none. Side effects: none.
   */
  async readCounts({
    scope,
    organizationId,
    automationIds,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    automationIds: readonly number[];
  }): Promise<Map<number, AutomationCountsOutput>> {
    const rows = await withAppDatabaseContext({
      scope,
      callback: () => this.repository.listForAutomations({ organizationId, automationIds }),
    });
    return sumAutomationCounts(rows);
  }

  /**
   * The runs one account's automations started, all time (route 27's top bar), in the caller's unit.
   *
   * @remarks
   * Algorithm: one sum. Failure modes: none. Side effects: none.
   */
  async readAccountRunsStarted({
    scope,
    organizationId,
    channelAccountId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    channelAccountId: number;
  }): Promise<number> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.repository.sumRunsStartedOfAccount({ organizationId, channelAccountId }),
    });
  }
}
