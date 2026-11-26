/**
 * Policy test: the reference seed's plan catalog holds what the billing migrations write (routes-final
 * § 2.10 of change-plan-gates — a fresh database (seed) and an existing one (migration) agree).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLANS,
  FREE_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import type { PlanFeatures } from '@/domains/billing/sub-domains/plan/plan.types.js';

const thisDirectoryPath = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(thisDirectoryPath, '..', '..', '..', '..', '..', '..', '..');

function readMigration(fileName: string): string {
  return readFileSync(path.join(projectRoot, 'migrations', fileName), 'utf8');
}

/** The one capture of `pattern` in `source`, failing loudly when the migration changed shape. */
function captureOnce({ source, pattern }: { source: string; pattern: RegExp }): string {
  const match = pattern.exec(source);
  expect(match, `pattern ${pattern} not found`).not.toBeNull();
  return match?.[1] ?? '';
}

const flowdmPlansMigration = readMigration('20261124060244_billing_flowdm_plans.sql');
const freeSwitchesMigration = readMigration(
  '20261126140000_billing_free_plan_segments_broadcasts.sql',
);

/** Free's features as `20261124060244_billing_flowdm_plans.sql` wrote them (the `ELSE` branch). */
const flowdmFreeFeatures = JSON.parse(
  captureOnce({ source: flowdmPlansMigration, pattern: /ELSE '(\{.*\})'::jsonb/ }),
) as PlanFeatures;

/** The switches `20261126140000_billing_free_plan_segments_broadcasts.sql` merges in. */
const mergedSwitches = JSON.parse(
  captureOnce({ source: freeSwitchesMigration, pattern: /\|\| '(\{.*\})'::jsonb/ }),
) as Partial<PlanFeatures['feature_switches']>;

/** The plan names the Free-switches migration updates. */
const updatedPlanNames = captureOnce({
  source: freeSwitchesMigration,
  pattern: /WHERE name IN \(([^)]*)\)/,
})
  .split(',')
  .map((name) => name.trim().replace(/^'|'$/g, ''));

describe('plan catalog — seed pinned to the migrations (change-plan-gates P13, P27)', () => {
  it("Free's seed features equal what the migrations leave in the Free row", () => {
    const migratedFree: PlanFeatures = {
      ...flowdmFreeFeatures,
      feature_switches: { ...flowdmFreeFeatures.feature_switches, ...mergedSwitches },
    };
    expect(FREE_PLAN_FEATURES).toEqual(migratedFree);
  });

  it('turns exactly broadcasts and segments on', () => {
    expect(mergedSwitches).toEqual({ broadcasts: true, segments: true });
    expect(FREE_PLAN_FEATURES.feature_switches.broadcasts).toBe(true);
    expect(FREE_PLAN_FEATURES.feature_switches.segments).toBe(true);
  });

  it("updates Free and the switched-off rows that carry Free's features, never Creator or Studio", () => {
    expect([...updatedPlanNames].sort()).toEqual(['Free', 'Growth', 'Pro', 'Starter']);
    for (const plan of DEFAULT_PLANS) {
      expect(plan.features === FREE_PLAN_FEATURES, plan.name).toBe(
        updatedPlanNames.includes(plan.name),
      );
    }
  });
});
