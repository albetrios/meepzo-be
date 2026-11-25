import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { runInstagramWebhookReclaimJob } from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook-reclaim.processor.js';
import type { InstagramWebhookIntakeRequest } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  insertTestInstagramWebhookEvent,
  readChannelAccountPublicIdOfInstagramAccount,
  readTestInstagramWebhookEvent,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/__tests__/factories/instagram-webhook-event.factory.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The stuck-event pick-up against the real table (feat-instagram-dm-sending § 5.A WH17, WH21,
 * worker-changes WC-12; AC-16.20): one read across organizations under the retention context finds
 * the accounts with an event still `received` / `queued` more than 1 minute after it arrived and not
 * claimed in the last 5 minutes (intake's lease) — each account once, oldest waiting first, live
 * organizations only — and adds each account's job with its organization (K8); a `failed` event
 * whose hourly retry is due goes back to `received` (its 5 tries again) while it is under 7 days
 * old, else it stays `failed` for good.
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

async function runPickUp(): Promise<InstagramWebhookIntakeRequest[]> {
  const added: InstagramWebhookIntakeRequest[] = [];
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

  it('hands back each account with an event waiting over 1 minute, once, oldest waiting first', async () => {
    const older = await teamAccount();
    const newer = await teamAccount();
    await waitingEvent({ account: newer, receivedMinutesAgo: 7 });
    await waitingEvent({ account: older, receivedMinutesAgo: 20, status: 'received' });
    await waitingEvent({ account: older, receivedMinutesAgo: 9 });

    expect(await runPickUp()).toEqual([
      {
        organizationPublicId: older.organizationPublicId,
        channelAccountPublicId: older.channelAccountPublicId,
        intakeKind: 'comments',
        requestId: 'reclaim-job-1',
      },
      {
        organizationPublicId: newer.organizationPublicId,
        channelAccountPublicId: newer.channelAccountPublicId,
        intakeKind: 'comments',
        requestId: 'reclaim-job-1',
      },
    ]);
  });

  it('leaves an event that arrived under a minute ago, or was claimed in the last 5', async () => {
    const fresh = await teamAccount();
    const leased = await teamAccount();
    const leaseOver = await teamAccount();
    await waitingEvent({ account: fresh, receivedMinutesAgo: 0.5 });
    const stuck = await teamAccount();
    await waitingEvent({ account: stuck, receivedMinutesAgo: 2 });
    await waitingEvent({ account: leased, receivedMinutesAgo: 30, lastAttemptedMinutesAgo: 2 });
    await waitingEvent({ account: leaseOver, receivedMinutesAgo: 30, lastAttemptedMinutesAgo: 6 });

    expect((await runPickUp()).map((request) => request.channelAccountPublicId)).toEqual([
      leaseOver.channelAccountPublicId,
      stuck.channelAccountPublicId,
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

  it('sends a due failed event back to received with its tries from 0 while under 7 days old (AC-16.20)', async () => {
    const account = await teamAccount();
    const due = await insertTestInstagramWebhookEvent({
      organizationId: account.organizationId,
      account: { id: account.id, instagramUserId: '9000000000000001' },
      status: 'failed',
      attemptCount: 5,
      nextAttemptAt: minutesAgo(1),
      receivedAt: minutesAgo(3 * 24 * 60),
    });
    const notYet = await insertTestInstagramWebhookEvent({
      organizationId: account.organizationId,
      account: { id: account.id, instagramUserId: '9000000000000001' },
      status: 'failed',
      attemptCount: 5,
      nextAttemptAt: new Date(Date.now() + 30 * MINUTE_MILLISECONDS),
      receivedAt: minutesAgo(60),
    });

    expect(await runPickUp()).toEqual([
      {
        organizationPublicId: account.organizationPublicId,
        channelAccountPublicId: account.channelAccountPublicId,
        intakeKind: 'comments',
        requestId: 'reclaim-job-1',
      },
    ]);
    expect(await readTestInstagramWebhookEvent(due.id)).toMatchObject({
      status: 'received',
      attempt_count: 0,
      error_message: null,
      processed_at: null,
      next_attempt_at: null,
    });
    expect(await readTestInstagramWebhookEvent(notYet.id)).toMatchObject({
      status: 'failed',
      attempt_count: 5,
    });
    // Now waiting again, the next minute hands it to intake as any stuck event — never retried twice.
    expect(await runPickUp()).toEqual([
      expect.objectContaining({ channelAccountPublicId: account.channelAccountPublicId }),
    ]);
  });

  it('keeps a failed event older than 7 days failed for good — its retry time empties', async () => {
    const account = await teamAccount();
    const old = await insertTestInstagramWebhookEvent({
      organizationId: account.organizationId,
      account: { id: account.id, instagramUserId: '9000000000000001' },
      status: 'failed',
      attemptCount: 5,
      nextAttemptAt: minutesAgo(1),
      receivedAt: minutesAgo(7.5 * 24 * 60),
    });

    expect(await runPickUp()).toEqual([]);
    expect(await readTestInstagramWebhookEvent(old.id)).toMatchObject({
      status: 'failed',
      attempt_count: 5,
      next_attempt_at: null,
    });
  });
});
