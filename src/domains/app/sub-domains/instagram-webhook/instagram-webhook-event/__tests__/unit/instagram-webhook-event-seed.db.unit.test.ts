import { faker } from '@faker-js/faker';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { database } from '@/infrastructure/database/connection.js';
import { PROFILES } from '@/scripts/seed/bulk-config.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';
import { createSeedRegistry } from '@/scripts/seed/seed-registry.js';
import { appSeedModule } from '@/domains/app/seed/index.js';
import { instagram_webhook_events } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.schema.js';
import {
  INSTAGRAM_WEBHOOK_EVENT_KINDS,
  INSTAGRAM_WEBHOOK_EVENT_SKIP_REASONS,
  INSTAGRAM_WEBHOOK_EVENT_STATUSES,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.constants.js';

/**
 * The Instagram webhook event bulk seed (WHC16) against the real schema, through the app domain's
 * seed module (accounts first, then their events): every seeded account gets events of every kind,
 * every status and every skip reason, all received within the 30-day window — and a second run
 * writes nothing new.
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

function eventsOf(organizationId: number) {
  return database
    .select()
    .from(instagram_webhook_events)
    .where(eq(instagram_webhook_events.organization_id, organizationId));
}

describe('Instagram webhook event bulk seed (database)', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('gives every seeded account events of every kind, status and skip reason', async () => {
    const organization = await seedOrganization();

    await appSeedModule.seedBulk?.(seedContext([organization]));

    const events = await eventsOf(organization.id);
    expect(events).toHaveLength(13);
    expect(new Set(events.map((event) => event.event_kind))).toEqual(
      new Set(INSTAGRAM_WEBHOOK_EVENT_KINDS),
    );
    expect(new Set(events.map((event) => event.status))).toEqual(
      new Set(INSTAGRAM_WEBHOOK_EVENT_STATUSES),
    );
    expect(new Set(events.map((event) => event.skip_reason).filter(Boolean))).toEqual(
      new Set(INSTAGRAM_WEBHOOK_EVENT_SKIP_REASONS),
    );
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(events.every((event) => event.created_at.getTime() > thirtyDaysAgo)).toBe(true);
    // The DM carries an example.com email, so the list's masking has something to mask.
    expect(JSON.stringify(events.map((event) => event.payload))).toContain('@example.com');
  });

  it('writes nothing new on a second run', async () => {
    const organization = await seedOrganization();
    const context = seedContext([organization]);

    await appSeedModule.seedBulk?.(context);
    await appSeedModule.seedBulk?.(context);

    expect(await eventsOf(organization.id)).toHaveLength(13);
  });

  it('warns and writes nothing when the registry has no organizations', async () => {
    const context = seedContext([]);

    await appSeedModule.seedBulk?.(context);

    expect(context.logger.warn).toHaveBeenCalled();
  });
});
