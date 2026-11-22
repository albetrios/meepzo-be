import { faker } from '@faker-js/faker';
import { asc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { database } from '@/infrastructure/database/connection.js';
import { PROFILES } from '@/scripts/seed/bulk-config.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';
import { createSeedRegistry } from '@/scripts/seed/seed-registry.js';
import { appSeedModule } from '@/domains/app/seed/index.js';
import { automation_runs } from '@/domains/app/sub-domains/automation/automation-run/automation-run.schema.js';
import { automation_run_events } from '@/domains/app/sub-domains/automation/automation-run/automation-run-event.schema.js';
import { automation_comment_logs } from '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.schema.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The automation-run bulk seed (launch AUC14, R10) against the real schema, run through the app
 * domain's composed seed (the accounts, contacts and automations it reads come first): a run in
 * every status that passes the table's checks, its status events, the comment runs' logs — and a
 * second run writes nothing new.
 */

async function seedOrganization(): Promise<SeededOrg> {
  const owner = await createTestUser();
  const organization = await createTestOrganization({ ownerUserId: owner.id });
  return { id: organization.id, public_id: organization.public_id, ownerUserId: owner.id };
}

function seedContext(organizations: SeededOrg[]): SeedContext {
  const registry = createSeedRegistry();
  for (const organization of organizations) registry.addOrganization(organization);
  return {
    counts: PROFILES.demo,
    faker,
    registry,
    logger: { info: vi.fn(), warn: vi.fn() } as unknown as Logger,
  };
}

async function runsOf(organizationId: number) {
  return database
    .select()
    .from(automation_runs)
    .where(eq(automation_runs.organization_id, organizationId))
    .orderBy(asc(automation_runs.id));
}

describe('automation-run bulk seed (database)', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('seeds a run in every status with its events, and the comment runs’ logs', async () => {
    const organization = await seedOrganization();

    await appSeedModule.seedBulk(seedContext([organization]));

    const runs = await runsOf(organization.id);
    expect(runs.map((run) => run.status).sort()).toEqual([
      'cancelled',
      'completed',
      'failed',
      'running',
      'waiting',
      'waiting',
    ]);
    const events = await database
      .select()
      .from(automation_run_events)
      .where(eq(automation_run_events.organization_id, organization.id));
    for (const run of runs) {
      expect(events.some((event) => event.automation_run_id === run.id)).toBe(true);
    }
    const logs = await database
      .select()
      .from(automation_comment_logs)
      .where(eq(automation_comment_logs.organization_id, organization.id));
    expect(logs.map((log) => log.automation_run_id).sort()).toEqual(
      runs
        .filter((run) => run.trigger_type === 'comment')
        .map((run) => run.id)
        .sort(),
    );
  });

  it('is idempotent: a second run adds nothing', async () => {
    const organization = await seedOrganization();

    await appSeedModule.seedBulk(seedContext([organization]));
    const first = await runsOf(organization.id);
    await appSeedModule.seedBulk(seedContext([organization]));

    expect(await runsOf(organization.id)).toHaveLength(first.length);
  });
});
