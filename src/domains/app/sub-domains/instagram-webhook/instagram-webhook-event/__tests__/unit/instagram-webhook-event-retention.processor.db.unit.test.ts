import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { runInstagramWebhookEventRetentionJob } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/workers/instagram-webhook-event-retention.processor.js';
import {
  insertTestInstagramAccount,
  insertTestInstagramWebhookEvent,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/__tests__/factories/instagram-webhook-event.factory.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The 30-day clean-up against the real table (WH19, WHC15): every event received more than 30
 * days ago goes — any status, every organization — and every younger one stays. It runs under the
 * retention context (`runGlobalRetentionWorkerJob`), the table's `USING` sweep arm.
 */

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-21T03:00:00.000Z');

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MILLISECONDS);
}

async function remainingEventIds(): Promise<number[]> {
  const rows = await operatorQuery<Array<{ id: string }>>`
    SELECT id FROM app.instagram_webhook_events ORDER BY id`;
  return rows.map((row) => Number(row.id));
}

describe('runInstagramWebhookEventRetentionJob (database)', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('deletes the events received more than 30 days ago, any status, in every organization', async () => {
    const kept: number[] = [];
    const deleted: number[] = [];
    for (let index = 0; index < 2; index += 1) {
      const organization = await createTestOrganization({
        ownerUserId: (await createTestUser()).id,
      });
      const account = await insertTestInstagramAccount(organization.id);
      for (const status of ['received', 'queued', 'processed', 'skipped', 'failed']) {
        const old = await insertTestInstagramWebhookEvent({
          organizationId: organization.id,
          account,
          status,
          receivedAt: daysBefore(31),
        });
        deleted.push(old.id);
        const young = await insertTestInstagramWebhookEvent({
          organizationId: organization.id,
          account,
          status,
          receivedAt: daysBefore(29),
        });
        kept.push(young.id);
      }
    }

    const result = await runInstagramWebhookEventRetentionJob(NOW);

    expect(result).toMatchObject({ deletedCount: deleted.length, blockedCount: 0, hasMore: false });
    expect(await remainingEventIds()).toEqual([...kept].sort((left, right) => left - right));
  });

  it('keeps an event received exactly at the cutoff, and deletes one a second older', async () => {
    const organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    const account = await insertTestInstagramAccount(organization.id);
    const atCutoff = await insertTestInstagramWebhookEvent({
      organizationId: organization.id,
      account,
      receivedAt: daysBefore(30),
    });
    await insertTestInstagramWebhookEvent({
      organizationId: organization.id,
      account,
      receivedAt: new Date(daysBefore(30).getTime() - 1000),
    });

    await runInstagramWebhookEventRetentionJob(NOW);

    expect(await remainingEventIds()).toEqual([atCutoff.id]);
  });

  it('is safe to run twice — the second run deletes nothing', async () => {
    const organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    const account = await insertTestInstagramAccount(organization.id);
    await insertTestInstagramWebhookEvent({
      organizationId: organization.id,
      account,
      receivedAt: daysBefore(40),
    });

    await runInstagramWebhookEventRetentionJob(NOW);
    const second = await runInstagramWebhookEventRetentionJob(NOW);

    expect(second.deletedCount).toBe(0);
    expect(await remainingEventIds()).toEqual([]);
  });
});
