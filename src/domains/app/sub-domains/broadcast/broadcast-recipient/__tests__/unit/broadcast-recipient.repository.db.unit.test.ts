import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { broadcasts } from '@/domains/app/sub-domains/broadcast/broadcast.schema.js';
import { BroadcastRecipientRepository } from '@/domains/app/sub-domains/broadcast/broadcast-recipient/broadcast-recipient.repository.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HOUR = 60 * 60 * 1000;

/**
 * `app.broadcast_recipients` against the database (routes-final § 7.C — BC16, BC17): one row per
 * person and broadcast (a second insert is left out), each status move a guarded update a repeat
 * misses (`waiting` → result, `owner_chat` → `waiting`, her erasure, a cancel's piece by `limit`),
 * her reply set once on rows sent before it, and the broadcast's numbers added in the caller's
 * commit. Every statement runs in the organization's job scope (`pnpm test:rls-role` safe).
 */
describe('BroadcastRecipientRepository (database)', () => {
  let organizationId: number;
  let organizationPublicId: string;
  let channelAccountId: number;
  let instagramAccountId: number;
  let broadcastId: number;
  let otherBroadcastId: number;

  function inUnit<T>(
    callback: (repository: BroadcastRecipientRepository) => Promise<T>,
  ): Promise<T> {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId }),
      callback: (databaseHandle) =>
        callback(new BroadcastRecipientRepository(databaseHandle as RequestScopedPostgresDatabase)),
    });
  }

  async function insertBroadcast(): Promise<number> {
    const [row] = await getOperatorDatabase()
      .insert(broadcasts)
      .values({
        public_id: generatePublicId('broadcast'),
        organization_id: organizationId,
        channel_account_id: channelAccountId,
        name: 'Drop',
        status: 'sending',
        mode: 'now',
        conditions: { op: 'and', items: [{ field: 'tags', match: 'any', values: ['lead'] }] },
        messages: [{ kind: 'text' as const, wait_minutes: 0, text: 'Hello' }],
        started_at: new Date(),
      })
      .returning({ id: broadcasts.id });
    return row!.id;
  }

  async function newContact(): Promise<number> {
    return (await insertContact({ organizationId, instagramAccountId, tags: ['lead'] })).id;
  }

  const keyOf = (contactId: number, id = broadcastId) => ({
    organizationId,
    broadcastId: id,
    contactId,
  });

  beforeEach(async () => {
    await cleanupDatabase();
    const organization = await createTestOrganization({
      ownerUserId: (await createTestUser({ email: 'recipient-repository@example.com' })).id,
    });
    organizationId = organization.id;
    organizationPublicId = organization.public_id;
    const account = await insertInstagramAccount({ organizationId });
    channelAccountId = account.channel_account_id;
    instagramAccountId = account.id;
    broadcastId = await insertBroadcast();
    otherBroadcastId = await insertBroadcast();
  });

  it('makes one waiting row per person and broadcast; a second insert is left out', async () => {
    const first = await newContact();
    const second = await newContact();
    const made = await inUnit((repository) =>
      repository.insertWaiting({
        organizationId,
        channelAccountId,
        broadcastId,
        contactIds: [first, second],
      }),
    );
    expect(made.map((row) => row.status)).toEqual(['waiting', 'waiting']);
    const again = await inUnit((repository) =>
      repository.insertWaiting({
        organizationId,
        channelAccountId,
        broadcastId,
        contactIds: [first],
      }),
    );
    expect(again).toEqual([]);
    expect(
      await inUnit((repository) =>
        repository.insertWaiting({ organizationId, channelAccountId, broadcastId, contactIds: [] }),
      ),
    ).toEqual([]);
  });

  it('settles a waiting row once and brings an owner_chat skip back to waiting', async () => {
    const contactId = await newContact();
    await inUnit((repository) =>
      repository.insertWaiting({
        organizationId,
        channelAccountId,
        broadcastId,
        contactIds: [contactId],
      }),
    );
    const at = new Date();
    const sent = await inUnit((repository) =>
      repository.settleWaiting({ key: keyOf(contactId), status: 'sent', reason: 'ignored', at }),
    );
    expect(sent).toMatchObject({ status: 'sent', reason: null });
    expect(sent?.sent_at?.getTime()).toBe(at.getTime());
    expect(
      await inUnit((repository) =>
        repository.settleWaiting({ key: keyOf(contactId), status: 'failed', reason: 'x', at }),
      ),
    ).toBeNull();
    // Not an owner_chat skip: nothing comes back.
    expect(await inUnit((repository) => repository.reopenOwnerChat(keyOf(contactId)))).toBeNull();

    const other = await newContact();
    await inUnit((repository) =>
      repository.insertWaiting({
        organizationId,
        channelAccountId,
        broadcastId,
        contactIds: [other],
      }),
    );
    await inUnit((repository) =>
      repository.settleWaiting({ key: keyOf(other), status: 'skipped', reason: 'owner_chat', at }),
    );
    expect(await inUnit((repository) => repository.reopenOwnerChat(keyOf(other)))).toMatchObject({
      status: 'waiting',
      reason: null,
    });
  });

  it("skips her waiting rows of every broadcast, and a cancel's piece up to its limit", async () => {
    const her = await newContact();
    const others = [await newContact(), await newContact(), await newContact()];
    await inUnit(async (repository) => {
      await repository.insertWaiting({
        organizationId,
        channelAccountId,
        broadcastId,
        contactIds: [her, ...others],
      });
      await repository.insertWaiting({
        organizationId,
        channelAccountId,
        broadcastId: otherBroadcastId,
        contactIds: [her],
      });
    });
    const skippedOf = await inUnit((repository) =>
      repository.skipWaitingOfContact({
        organizationId,
        contactId: her,
        reason: 'contact_deleted',
      }),
    );
    expect(skippedOf.sort()).toEqual([broadcastId, otherBroadcastId].sort());
    expect(
      await inUnit((repository) =>
        repository.skipWaitingOfBroadcast({
          organizationId,
          broadcastId,
          reason: 'cancelled',
          limit: 2,
        }),
      ),
    ).toBe(2);
    expect(
      await inUnit((repository) =>
        repository.skipWaitingOfBroadcast({
          organizationId,
          broadcastId,
          reason: 'cancelled',
          limit: 2,
        }),
      ),
    ).toBe(1);
    expect(await inUnit((repository) => repository.find(keyOf(her)))).toMatchObject({
      status: 'skipped',
      reason: 'contact_deleted',
    });
  });

  it('sets her reply once on rows sent before it', async () => {
    const contactId = await newContact();
    await inUnit((repository) =>
      repository.insertWaiting({
        organizationId,
        channelAccountId,
        broadcastId,
        contactIds: [contactId],
      }),
    );
    await inUnit((repository) =>
      repository.settleWaiting({
        key: keyOf(contactId),
        status: 'sent',
        reason: null,
        at: new Date(Date.now() - HOUR),
      }),
    );
    expect(
      await inUnit((repository) =>
        repository.recordReply({
          organizationId,
          contactId,
          repliedAt: new Date(Date.now() - 2 * HOUR),
        }),
      ),
    ).toEqual([]);
    const repliedAt = new Date();
    expect(
      await inUnit((repository) =>
        repository.recordReply({ organizationId, contactId, repliedAt }),
      ),
    ).toEqual([broadcastId]);
    expect(
      await inUnit((repository) =>
        repository.recordReply({ organizationId, contactId, repliedAt }),
      ),
    ).toEqual([]);
  });

  it("adds to the broadcast's numbers, leaving zero changes out", async () => {
    await inUnit(async (repository) => {
      await repository.addToBroadcastNumbers({
        organizationId,
        broadcastId,
        change: { matched: 3, sent: 1, failed: 0 },
      });
      await repository.addToBroadcastNumbers({
        organizationId,
        broadcastId,
        change: { sent: 1, skipped: 1, replies: 1 },
      });
      await repository.addToBroadcastNumbers({ organizationId, broadcastId, change: {} });
    });
    const [row] = await getOperatorDatabase()
      .select()
      .from(broadcasts)
      .where(eq(broadcasts.id, broadcastId));
    expect(row).toMatchObject({ matched: 3, sent: 2, skipped: 1, failed: 0, replies: 1 });
  });
});
