/**
 * One row a cross-organization scan found: the organization it belongs to (its internal id for
 * the change's `WHERE`, its public id for the job scope) and the internal id of the row itself.
 */
export interface OrganizationScanRow {
  organizationId: number;
  organizationPublicId: string;
  rowId: number;
}

/** One organization's share of a scan: its internal id and the ids of its rows, in scan order. */
export interface OrganizationScanGroup {
  organizationId: number;
  rowIds: number[];
}

/**
 * Groups the rows of a cross-organization scan by organization public id, keeping the scan's
 * order — the step between a sweep's scan (`runGlobalRetentionWorkerJob`) and its
 * per-organization changes (`runOrganizationScopedWorkerJob`, one per group).
 *
 * @remarks
 * - **Algorithm:** one pass; a `Map` keeps the first-seen order of the organizations and, inside
 *   each, the order of the rows.
 * - **Failure modes:** none — pure.
 * - **Side effects:** none.
 * - **Notes:** used by the scan-then-change sweeps (the automation "next post" expiry, the
 *   waiting-run cancel); a group's change re-checks every condition of the scan, since the row may
 *   have moved between the two.
 */
export function groupScanRowsByOrganization(
  rows: readonly OrganizationScanRow[],
): Map<string, OrganizationScanGroup> {
  const groups = new Map<string, OrganizationScanGroup>();
  for (const row of rows) {
    const group = groups.get(row.organizationPublicId) ?? {
      organizationId: row.organizationId,
      rowIds: [],
    };
    group.rowIds.push(row.rowId);
    groups.set(row.organizationPublicId, group);
  }
  return groups;
}
