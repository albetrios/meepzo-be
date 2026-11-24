import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { runInstagramWebhookReclaimJob } from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook-reclaim.processor.js';
import type { InstagramWebhookAccountProcessingRequest } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  insertTestInstagramWebhookEvent,
  readChannelAccountPublicIdOfInstagramAccount,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/__tests__/factories/instagram-webhook-event.factory.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The stuck-event pick-up against the real table (routes-final § 4.A WH15, worker-changes WC-2):
 * one read across organizations under the retention context finds the accounts with an event still
 * `received` / `queued` more than 5 minutes after it arrived and not claimed in the last 5 minutes —
 * each account once, oldest waiting first, live organizations only — and adds each account's job
 * with its organization (K8).
 */

const MINUTE_MILLISECONDS = 60 * 1000;

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * MINUTE_MILLISECONDS);
}

type TestAccount = {
  organizationPublicId: string;
  id: number;
  public_id: string;
  /** `cha_…` — what the pick-up's jobs carry (R17, WHC4). */
  channelAccountPublicId: string;
  organizationId: number;
};

async function teamAccount(): Promise<TestAccount> {
  const organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
  const account = await insertInstagramAccount({ organizationId: organization.id });
  return {
    ...account,
    channelAccountPublicId: await readChannelAccountPublicIdOfInstagramAccount(account.id),
    organizationId: organization.id,
    organizationPublicId: organization.public_id,
  };
}

async function waitingEvent({
  account,
  receivedMinutesAgo,
  status = 'queued',
  lastAttemptedMinutesAgo = null,
}: {
  account: TestAccount;
  receivedMinutesAgo: number;
  status?: string;
  lastAttemptedMinutesAgo?: number | null;
}): Promise<void> {
  const event = await insertTestInstagramWebhookEvent({
    organizationId: account.organizationId,
    account: { id: account.id, instagramUserId: '9000000000000001' },
    status,
    receivedAt: minutesAgo(receivedMinutesAgo),
  });
  if (lastAttemptedMinutesAgo !== null) {
    await operatorQuery`
      UPDATE app.instagram_webhook_events
      SET attempt_count = 1, last_attempted_at = ${minutesAgo(lastAttemptedMinutesAgo)}
      WHERE id = ${event.id}`;
  }
}

async function runPickUp(): Promise<InstagramWebhookAccountProcessingRequest[]> {
  const added: InstagramWebhookAccountProcessingRequest[] = [];
  await runInstagramWebhookReclaimJob({
    requestId: 'reclaim-job-1',
    enqueue: async (request) => {
      added.push(request);
    },
  });
  return added;
}

describe('runInstagramWebhookReclaimJob (database)', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('hands back each account with an event waiting 5 minutes, once, oldest waiting first', async () => {
    const older = await teamAccount();
    const newer = await teamAccount();
    await waitingEvent({ account: newer, receivedMinutesAgo: 7 });
    await waitingEvent({ account: older, receivedMinutesAgo: 20, status: 'received' });
    await waitingEvent({ account: older, receivedMinutesAgo: 9 });

    expect(await runPickUp()).toEqual([
      {
        organizationPublicId: older.organizationPublicId,
        channelAccountPublicId: older.channelAccountPublicId,
        requestId: 'reclaim-job-1',
      },
      {
        organizationPublicId: newer.organizationPublicId,
        channelAccountPublicId: newer.channelAccountPublicId,
        requestId: 'reclaim-job-1',
      },
    ]);
  });

  it('leaves an event that arrived less than 5 minutes ago, or was claimed in the last 5', async () => {
    const fresh = await teamAccount();
    const leased = await teamAccount();
    const leaseOver = await teamAccount();
    await waitingEvent({ account: fresh, receivedMinutesAgo: 2 });
    await waitingEvent({ account: leased, receivedMinutesAgo: 30, lastAttemptedMinutesAgo: 2 });
    await waitingEvent({ account: leaseOver, receivedMinutesAgo: 30, lastAttemptedMinutesAgo: 6 });

    expect((await runPickUp()).map((request) => request.channelAccountPublicId)).toEqual([
      leaseOver.channelAccountPublicId,
    ]);
  });

  it('never hands back final events, or the events of a deleted organization', async () => {
    const finished = await teamAccount();
    const deleted = await teamAccount();
    for (const status of ['processed', 'skipped', 'failed']) {
      await waitingEvent({ account: finished, receivedMinutesAgo: 30, status });
    }
    await waitingEvent({ account: deleted, receivedMinutesAgo: 30 });
    await operatorQuery`
      UPDATE tenancy.organizations SET deleted_at = now() WHERE id = ${deleted.organizationId}`;

    expect(await runPickUp()).toEqual([]);
  });
});
