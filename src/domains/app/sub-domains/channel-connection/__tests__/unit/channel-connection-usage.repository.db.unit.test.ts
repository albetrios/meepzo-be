import { beforeEach, describe, expect, it } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { ChannelConnectionUsageRepository } from '@/domains/app/sub-domains/channel-connection/channel-connection-usage.repository.js';
import { createChannelConnectionUsagePostgresStore } from '@/domains/app/sub-domains/channel-connection/channel-connection-usage.service.js';
import { insertChannelConnection } from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';

/**
 * The Postgres store of Meta's usage per connection (routes-final § 1 MC19, S13, P107): one row per
 * (connection, asset, type), the newer reading wins, an older one is dropped, and another
 * organization's scope reads nothing and writes nothing. Runs in the organization's own scope, so
 * the suite also holds under `pnpm test:rls-role`.
 */

type TestOrganization = { id: number; public_id: string };

describe('ChannelConnectionUsage Postgres store (database)', () => {
  const store = createChannelConnectionUsagePostgresStore(new ChannelConnectionUsageRepository());
  let organization: TestOrganization;
  let otherOrganization: TestOrganization;
  let channelConnectionPublicId: string;

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    otherOrganization = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    channelConnectionPublicId = (await insertChannelConnection({ organizationId: organization.id }))
      .public_id;
  });

  const targetOf = (target: TestOrganization) => ({
    scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: target.public_id }),
    channelConnectionPublicId,
  });

  it('keeps one reading per asset and type, the newer one winning', async () => {
    const older = new Date('2026-11-24T10:00:00.000Z');
    const newer = new Date('2026-11-24T10:05:00.000Z');
    await store.writeConnectionUsageEntries({
      ...targetOf(organization),
      entries: [
        { assetId: '178414', type: 'instagram', usagePercent: 40, waitUntil: null, readAt: newer },
        { assetId: '178415', type: 'instagram', usagePercent: 10, waitUntil: null, readAt: newer },
      ],
    });
    // An older reading of the same asset and type is dropped.
    await store.writeConnectionUsageEntries({
      ...targetOf(organization),
      entries: [
        { assetId: '178414', type: 'instagram', usagePercent: 99, waitUntil: null, readAt: older },
      ],
    });

    const entries = await store.readConnectionUsageEntries(targetOf(organization));
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.assetId === '178414')).toMatchObject({
      usagePercent: 40,
      readAt: newer,
    });

    const later = new Date('2026-11-24T10:10:00.000Z');
    const waitUntil = new Date('2026-11-24T10:25:00.000Z');
    await store.writeConnectionUsageEntries({
      ...targetOf(organization),
      entries: [
        { assetId: '178414', type: 'instagram', usagePercent: 96, waitUntil, readAt: later },
      ],
    });
    const updated = await store.readConnectionUsageEntries(targetOf(organization));
    expect(updated.find((entry) => entry.assetId === '178414')).toMatchObject({
      usagePercent: 96,
      waitUntil,
      readAt: later,
    });
  });

  it("reads nothing and writes nothing under another organization's scope", async () => {
    await store.writeConnectionUsageEntries({
      ...targetOf(otherOrganization),
      entries: [
        {
          assetId: '178414',
          type: 'instagram',
          usagePercent: 50,
          waitUntil: null,
          readAt: new Date(),
        },
      ],
    });
    await expect(store.readConnectionUsageEntries(targetOf(organization))).resolves.toEqual([]);
    await expect(store.readConnectionUsageEntries(targetOf(otherOrganization))).resolves.toEqual(
      [],
    );
  });
});
