import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';
import {
  INSTAGRAM_WEBHOOK_EVENT_ATTEMPTS_EXHAUSTED_ERROR,
  InstagramWebhookEventRepository,
  type InstagramWebhookEventClaimKey,
  type NewInstagramWebhookEvent,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import {
  type TestInstagramAccount,
  insertTestInstagramAccount,
  insertTestInstagramWebhookEvent,
  readTestInstagramWebhookEvent,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/__tests__/factories/instagram-webhook-event.factory.js';

/**
 * `app.instagram_webhook_events` through its repository (launch § 4.B.3, 4.B.10 — WH10, WH12, WH14;
 * keyed by the channel account and split by day since feat-instagram-dm-sending R16): the insert
 * (the repeat guard moved to the key table — `instagram-webhook-event-store.db.unit.test.ts`), the
 * `queued` mark, the claim of the account's head (strict
 * order, the lease, spent attempts), the claim-guarded marks and release. Every statement runs
 * inside the organization's own context — the receiver's verified scope, processing's job scope —
 * so the suite also holds under `pnpm test:rls-role`.
 */

const MAX_ATTEMPTS = 5;
const LEASE_MINUTES = 5;

type TestOrganization = { id: number; public_id: string };

function inOrganization<T>(organization: TestOrganization, callback: () => Promise<T>): Promise<T> {
  return withAppDatabaseContext({
    scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id }),
    callback,
  });
}

function newEvent(overrides: Partial<NewInstagramWebhookEvent> = {}): NewInstagramWebhookEvent {
  return {
    instagramUserId: '17841400000000001',
    contactInstagramUserId: '17841400000000777',
    eventKind: 'comment',
    eventKey: 'comment:18000000000000001',
    skipReason: null,
    payload: { field: 'comments', value: { id: '18000000000000001', text: 'Price?' } },
    occurredAt: new Date('2026-11-21T09:00:00.000Z'),
    ...overrides,
  };
}

describe('InstagramWebhookEventRepository (database)', () => {
  const repository = new InstagramWebhookEventRepository();
  let organization: TestOrganization;
  let otherOrganization: TestOrganization;
  let account: TestInstagramAccount;
  let otherAccount: TestInstagramAccount;

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    otherOrganization = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    account = await insertTestInstagramAccount(organization.id);
    otherAccount = await insertTestInstagramAccount(otherOrganization.id);
  });

  function claim(organizationScope = organization, accountId = account.channelAccountId) {
    return inOrganization(organizationScope, () =>
      repository.claimOldestWaitingEvent({
        organizationId: organizationScope.id,
        channelAccountId: accountId,
        maxProcessingAttempts: MAX_ATTEMPTS,
        claimLeaseMinutes: LEASE_MINUTES,
      }),
    );
  }

  describe('insertEvents (WH10)', () => {
    it('stores a received event and a skipped one — the skipped one final at once', async () => {
      const inserted = await inOrganization(organization, () =>
        repository.insertEvents({
          organizationId: organization.id,
          channelAccountId: account.channelAccountId,
          requestId: 'req-1',
          events: [
            newEvent(),
            newEvent({ eventKey: 'comment:18000000000000002', skipReason: 'own_comment' }),
          ],
        }),
      );

      expect(inserted).toHaveLength(2);
      const [received, skipped] = inserted;
      expect(received?.public_id).toMatch(publicIdPatternFor('instagramWebhookEvent'));
      expect(received).toMatchObject({
        status: 'received',
        skip_reason: null,
        processed_at: null,
        attempt_count: 0,
        request_id: 'req-1',
        organization_id: organization.id,
        channel_account_id: account.channelAccountId,
      });
      expect(skipped).toMatchObject({
        status: 'skipped',
        skip_reason: 'own_comment',
        payload: null,
      });
      expect(skipped?.processed_at).toBeInstanceOf(Date);
    });

    it('inserts every event it is given — the repeat guard is the key table (WH20)', async () => {
      const store = () =>
        inOrganization(organization, () =>
          repository.insertEvents({
            organizationId: organization.id,
            channelAccountId: account.channelAccountId,
            requestId: null,
            events: [newEvent()],
          }),
        );

      expect(await store()).toHaveLength(1);
      expect(await store()).toHaveLength(1);
      const [row] = await operatorQuery<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM app.instagram_webhook_events
        WHERE organization_id = ${organization.id}`;
      expect(row?.count).toBe(2);
    });

    it('keys events per account: the same key on another account is another event', async () => {
      await inOrganization(organization, () =>
        repository.insertEvents({
          organizationId: organization.id,
          channelAccountId: account.channelAccountId,
          requestId: null,
          events: [newEvent()],
        }),
      );
      const other = await inOrganization(otherOrganization, () =>
        repository.insertEvents({
          organizationId: otherOrganization.id,
          channelAccountId: otherAccount.channelAccountId,
          requestId: null,
          events: [newEvent({ instagramUserId: otherAccount.instagramUserId })],
        }),
      );

      expect(other).toHaveLength(1);
    });

    it("refuses an event naming another organization's account (composite key / RLS)", async () => {
      await expect(
        inOrganization(organization, () =>
          repository.insertEvents({
            organizationId: organization.id,
            channelAccountId: otherAccount.channelAccountId,
            requestId: null,
            events: [newEvent()],
          }),
        ),
      ).rejects.toThrow();
    });

    it('writes nothing for an empty entry', async () => {
      const inserted = await inOrganization(organization, () =>
        repository.insertEvents({
          organizationId: organization.id,
          channelAccountId: account.channelAccountId,
          requestId: null,
          events: [],
        }),
      );
      expect(inserted).toEqual([]);
    });
  });

  describe('markQueued (WH10)', () => {
    it('turns received rows queued and leaves other statuses alone', async () => {
      const received = await insertTestInstagramWebhookEvent({
        organizationId: organization.id,
        account,
      });
      const skipped = await insertTestInstagramWebhookEvent({
        organizationId: organization.id,
        account,
        status: 'skipped',
      });

      const turned = await inOrganization(organization, () =>
        repository.markQueued({
          organizationId: organization.id,
          channelAccountId: account.channelAccountId,
          eventIds: [received.id, skipped.id],
        }),
      );

      expect(turned).toBe(1);
      expect((await readTestInstagramWebhookEvent(received.id))?.status).toBe('queued');
      expect((await readTestInstagramWebhookEvent(skipped.id))?.status).toBe('skipped');
    });
  });

  describe('claimOldestWaitingEvent (WH12)', () => {
    it('claims the oldest waiting event, adding an attempt and starting the lease', async () => {
      const older = await insertTestInstagramWebhookEvent({
        organizationId: organization.id,
        account,
        status: 'queued',
        receivedAt: new Date(Date.now() - 60_000),
      });
      await insertTestInstagramWebhookEvent({ organizationId: organization.id, account });

      const result = await claim();

      expect(result?.outcome).toBe('claimed');
      expect(result?.event.id).toBe(older.id);
      expect(result?.event.attempt_count).toBe(1);
      expect(result?.event.last_attempted_at).toBeInstanceOf(Date);
      expect(result?.event.status).toBe('queued');
    });

    it('never skips a leased head — strict order (WQ3)', async () => {
      const head = await insertTestInstagramWebhookEvent({
        organizationId: organization.id,
        account,
        receivedAt: new Date(Date.now() - 60_000),
      });
      await insertTestInstagramWebhookEvent({ organizationId: organization.id, account });

      expect((await claim())?.event.id).toBe(head.id);
      // The head is now leased: a second run claims nothing — not the next event either.
      expect(await claim()).toBeNull();
    });

    it('claims a head again once its 5-minute lease ran out', async () => {
      const head = await insertTestInstagramWebhookEvent({
        organizationId: organization.id,
        account,
      });
      await claim();
      await operatorQuery`
        UPDATE app.instagram_webhook_events
        SET last_attempted_at = now() - interval '6 minutes' WHERE id = ${head.id}`;

      const again = await claim();

      expect(again?.outcome).toBe('claimed');
      expect(again?.event.attempt_count).toBe(2);
    });

    it('fails a head that already used 5 attempts instead of claiming it', async () => {
      const head = await insertTestInstagramWebhookEvent({
        organizationId: organization.id,
        account,
        attemptCount: MAX_ATTEMPTS,
      });

      const result = await claim();

      expect(result?.outcome).toBe('exhausted');
      expect(result?.event).toMatchObject({
        id: head.id,
        status: 'failed',
        error_message: INSTAGRAM_WEBHOOK_EVENT_ATTEMPTS_EXHAUSTED_ERROR,
        attempt_count: MAX_ATTEMPTS,
      });
      expect(result?.event.processed_at).toBeInstanceOf(Date);
    });

    it('answers null when nothing waits, and never claims a final event', async () => {
      await insertTestInstagramWebhookEvent({
        organizationId: organization.id,
        account,
        status: 'processed',
      });

      expect(await claim()).toBeNull();
    });

    it("never claims another organization's events", async () => {
      await insertTestInstagramWebhookEvent({
        organizationId: otherOrganization.id,
        account: otherAccount,
      });

      expect(await claim(organization, otherAccount.channelAccountId)).toBeNull();
      expect(await claim(otherOrganization, otherAccount.channelAccountId)).not.toBeNull();
    });
  });

  describe('marks and release (WH12–WH14)', () => {
    async function claimedKey(): Promise<InstagramWebhookEventClaimKey> {
      const result = await claim();
      if (result === null) throw new Error('nothing claimed');
      return {
        organizationId: organization.id,
        channelAccountId: account.channelAccountId,
        eventId: result.event.id,
        claimedAttemptCount: result.event.attempt_count,
      };
    }

    beforeEach(async () => {
      await insertTestInstagramWebhookEvent({ organizationId: organization.id, account });
    });

    it('marks a claimed event processed and clears its body (WH22)', async () => {
      const key = await claimedKey();
      expect((await readTestInstagramWebhookEvent(key.eventId))?.payload).not.toBeNull();

      expect(await inOrganization(organization, () => repository.markProcessed(key))).toBe(true);
      const row = await readTestInstagramWebhookEvent(key.eventId);
      expect(row?.status).toBe('processed');
      expect(row?.processed_at).toBeInstanceOf(Date);
      expect(row?.payload).toBeNull();
    });

    it('marks a claimed event skipped with its reason and clears its body (WH22)', async () => {
      const key = await claimedKey();

      expect(
        await inOrganization(organization, () =>
          repository.markSkipped({ ...key, skipReason: 'automation_disabled' }),
        ),
      ).toBe(true);
      expect(await readTestInstagramWebhookEvent(key.eventId)).toMatchObject({
        status: 'skipped',
        skip_reason: 'automation_disabled',
        payload: null,
      });
    });

    it('marks a claimed event failed with a code, cut to 2000 characters — its body kept', async () => {
      const key = await claimedKey();

      await inOrganization(organization, () =>
        repository.markFailed({ ...key, errorMessage: `instagram_api:100/${'9'.repeat(2500)}` }),
      );
      const row = await readTestInstagramWebhookEvent(key.eventId);
      expect(row?.status).toBe('failed');
      expect(row?.error_message).toHaveLength(2000);
      expect(row?.payload).not.toBeNull();
    });

    it('changes nothing once another run took the claim over (the attempt count moved on)', async () => {
      const staleKey = await claimedKey();
      await operatorQuery`
        UPDATE app.instagram_webhook_events
        SET last_attempted_at = now() - interval '6 minutes' WHERE id = ${staleKey.eventId}`;
      await claimedKey();

      expect(await inOrganization(organization, () => repository.markProcessed(staleKey))).toBe(
        false,
      );
      expect((await readTestInstagramWebhookEvent(staleKey.eventId))?.status).toBe('received');
    });

    it('releases a claim without spending its attempt, so the next run claims it at once', async () => {
      const key = await claimedKey();

      expect(await inOrganization(organization, () => repository.releaseClaim(key))).toBe(true);
      expect(await readTestInstagramWebhookEvent(key.eventId)).toMatchObject({
        attempt_count: 0,
        last_attempted_at: null,
        status: 'received',
      });
      expect((await claim())?.event.attempt_count).toBe(1);
    });

    it('ends the lease but keeps the attempt after a temporary failure (isAttemptSpent)', async () => {
      const key = await claimedKey();

      expect(
        await inOrganization(organization, () =>
          repository.releaseClaim({ ...key, isAttemptSpent: true }),
        ),
      ).toBe(true);
      expect(await readTestInstagramWebhookEvent(key.eventId)).toMatchObject({
        attempt_count: 1,
        last_attempted_at: null,
        status: 'received',
      });
      // The job's backoff retry claims it at once — its second attempt, not a 5-minute wait.
      expect((await claim())?.event.attempt_count).toBe(2);
    });
  });
});
