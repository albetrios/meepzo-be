import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { SegmentConditions } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';
import {
  BroadcastRepository,
  type BroadcastRow,
} from '@/domains/app/sub-domains/broadcast/broadcast.repository.js';
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const CONDITIONS: SegmentConditions = {
  op: 'and',
  items: [{ field: 'tags', match: 'any', values: ['vip'] }],
};

/**
 * `app.broadcasts` against the database (routes-final § 7.A — BC1–BC11): a draft is made with the
 * account's channel and read back with its account's public id, only a draft is edited or sent (a
 * second send misses), a sending broadcast is cancelled once and cannot be deleted while active, a
 * deleted one is gone from every read, the list filters by status with its total, and only a live
 * automation of the account can start one. Every statement runs in the organization's verified
 * scope (`pnpm test:rls-role` safe).
 */
describe('BroadcastRepository (database)', () => {
  let organizationId: number;
  let organizationPublicId: string;
  let account: { id: number; public_id: string; channel_account_id: number };

  function inUnit<T>(callback: (repository: BroadcastRepository) => Promise<T>): Promise<T> {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId }),
      callback: (databaseHandle) =>
        callback(new BroadcastRepository(databaseHandle as RequestScopedPostgresDatabase)),
    });
  }

  function insertDraft(name = 'Spring drop'): Promise<BroadcastRow> {
    return inUnit((repository) =>
      repository.insert({
        organizationId,
        channelAccount: { id: account.channel_account_id, channel: 'instagram' },
        name,
        values: {
          conditions: CONDITIONS,
          messages: [{ kind: 'text', wait_minutes: 0, text: 'Hello' }],
        },
        createdByUserId: null,
      }),
    );
  }

  function sendNow(broadcastId: number): Promise<boolean> {
    return inUnit((repository) =>
      repository.markSent({
        organizationId,
        broadcastId,
        values: {
          status: 'sending',
          mode: 'now',
          conditions: CONDITIONS,
          scheduledAt: null,
          endsAt: null,
          isStarted: true,
        },
        updatedByUserId: null,
      }),
    );
  }

  beforeEach(async () => {
    await cleanupDatabase();
    const organization = await createTestOrganization({
      ownerUserId: (await createTestUser({ email: 'broadcast-repository@example.com' })).id,
    });
    organizationId = organization.id;
    organizationPublicId = organization.public_id;
    account = await insertInstagramAccount({ organizationId });
  });

  it("makes a draft on the account's channel and reads it back with the account's public id", async () => {
    const draft = await insertDraft();
    expect(draft).toMatchObject({ status: 'draft', channel: 'instagram', name: 'Spring drop' });
    expect(draft.public_id).toMatch(/^brc_[a-z0-9]{21}$/);
    const view = await inUnit((repository) =>
      repository.findLiveByPublicId({ organizationId, broadcastPublicId: draft.public_id }),
    );
    expect(view).toMatchObject({
      id: draft.id,
      channel_account_public_id: account.public_id,
      segment_public_id: null,
      start_automation_public_id: null,
    });
  });

  it('edits and sends only a draft; a second send misses', async () => {
    const draft = await insertDraft();
    expect(
      await inUnit((repository) =>
        repository.updateDraft({
          organizationId,
          broadcastId: draft.id,
          values: { name: 'Renamed' },
          updatedByUserId: null,
        }),
      ),
    ).toBe(true);
    expect(await sendNow(draft.id)).toBe(true);
    expect(await sendNow(draft.id)).toBe(false);
    expect(
      await inUnit((repository) =>
        repository.updateDraft({
          organizationId,
          broadcastId: draft.id,
          values: { name: 'Too late' },
          updatedByUserId: null,
        }),
      ),
    ).toBe(false);
    const view = await inUnit((repository) =>
      repository.findLiveView({ organizationId, broadcastId: draft.id }),
    );
    expect(view).toMatchObject({
      name: 'Renamed',
      status: 'sending',
      started_at: expect.any(Date),
    });
  });

  it('cancels a sending broadcast once; an active one is not deleted, a cancelled one is', async () => {
    const draft = await insertDraft();
    await sendNow(draft.id);
    const key = { organizationId, broadcastId: draft.id, updatedByUserId: null };
    expect(await inUnit((repository) => repository.softDelete(key))).toBe(false);
    expect(await inUnit((repository) => repository.cancelByOwner(key))).toBe(true);
    expect(await inUnit((repository) => repository.cancelByOwner(key))).toBe(false);
    expect(await inUnit((repository) => repository.softDelete(key))).toBe(true);
    expect(
      await inUnit((repository) =>
        repository.findLiveView({ organizationId, broadcastId: draft.id }),
      ),
    ).toBeNull();
  });

  it('lists the account broadcasts by status with the total', async () => {
    const first = await insertDraft('Alpha');
    await insertDraft('Beta');
    await sendNow(first.id);
    const query = {
      channelAccountId: account.channel_account_id,
      statuses: [] as string[],
      sort: 'name' as const,
      order: 'asc' as const,
      limit: 10,
    };
    const all = await inUnit((repository) =>
      repository.list({ organizationId, query: query as never }),
    );
    expect(all.items.map((row) => row.name)).toEqual(['Alpha', 'Beta']);
    expect(all.total).toBe(2);
    const drafts = await inUnit((repository) =>
      repository.list({ organizationId, query: { ...query, statuses: ['draft'] } as never }),
    );
    expect(drafts.items.map((row) => row.name)).toEqual(['Beta']);
  });

  it('only a live automation of the account can start a broadcast', async () => {
    const live = await insertAutomation({
      organizationId,
      channelAccountId: account.channel_account_id,
      status: 'live',
    });
    const draftAutomation = await insertAutomation({
      organizationId,
      channelAccountId: account.channel_account_id,
      status: 'draft',
    });
    const find = (automationPublicId: string) =>
      inUnit((repository) =>
        repository.findLiveAccountAutomationId({
          organizationId,
          channelAccountId: account.channel_account_id,
          automationPublicId,
        }),
      );
    expect(await find(live.public_id)).toBe(live.id);
    expect(await find(draftAutomation.public_id)).toBeNull();
  });
});
