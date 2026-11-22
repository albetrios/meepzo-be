import { describe, expect, it } from 'vitest';
import { groupScanRowsByOrganization } from '@/infrastructure/queue/worker-runtime/worker-organization-group.util.js';

/** The scan-then-change sweeps' grouping: one group per organization, the scan's order kept. */
describe('groupScanRowsByOrganization', () => {
  it('groups the rows by organization public id, keeping the order of both', () => {
    const groups = groupScanRowsByOrganization([
      { organizationId: 20, organizationPublicId: 'org_b', rowId: 5 },
      { organizationId: 10, organizationPublicId: 'org_a', rowId: 1 },
      { organizationId: 20, organizationPublicId: 'org_b', rowId: 2 },
      { organizationId: 10, organizationPublicId: 'org_a', rowId: 9 },
    ]);

    expect([...groups.entries()]).toEqual([
      ['org_b', { organizationId: 20, rowIds: [5, 2] }],
      ['org_a', { organizationId: 10, rowIds: [1, 9] }],
    ]);
  });

  it('answers an empty map for an empty scan', () => {
    expect(groupScanRowsByOrganization([]).size).toBe(0);
  });
});
