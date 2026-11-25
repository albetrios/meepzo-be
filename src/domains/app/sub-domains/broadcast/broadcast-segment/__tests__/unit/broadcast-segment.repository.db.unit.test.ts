import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '@/infrastructure/database/connection.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { MILLISECONDS_PER_DAY, MILLISECONDS_PER_HOUR } from '@/shared/constants/ttl.constants.js';
import {
  BroadcastSegmentRepository,
  type SegmentAutomationIds,
} from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.repository.js';
import type {
  SegmentCondition,
  SegmentConditions,
} from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationCommentLog,
  insertAutomationRun,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

/** A time `milliseconds` ago. */
function ago(milliseconds: number): Date {
  return new Date(Date.now() - milliseconds);
}

/** A one-condition `and` tree. */
function only(condition: SegmentCondition): SegmentConditions {
  return { op: 'and', items: [condition] };
}

/**
 * The audience builder against the database (routes-final § 7.B, BC12, BC13; BCC8): each of the
 * eight condition fields against seeded contacts, the always-left-out rules (opted out, paused,
 * deleted, a broadcast in the last 24 hours), the open-window count, groups, and the automation
 * check of the tree's ids.
 */
describe('BroadcastSegmentRepository audience (database)', () => {
  const repository = new BroadcastSegmentRepository(
    drizzle({ client: pool }) as unknown as RequestScopedPostgresDatabase,
  );
  let organizationId: number;
  let channelAccountId: number;
  let instagramAccountId: number;
  let automationIds: SegmentAutomationIds;
  let automationPublicId: string;
  const postId = '18030000000000777';

  beforeEach(async () => {
    await cleanupDatabase();
    const organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    organizationId = organization.id;
    const account = await insertInstagramAccount({ organizationId });
    channelAccountId = account.channel_account_id;
    instagramAccountId = account.id;
    const automation = await insertAutomation({ organizationId, instagramAccountId });
    automationPublicId = automation.public_id;
    automationIds = new Map([[automation.public_id, automation.id]]);
    const contact = (
      overrides: Omit<Parameters<typeof insertContact>[0], 'organizationId' | 'instagramAccountId'>,
    ) => insertContact({ organizationId, instagramAccountId, ...overrides });

    // Avery: chat open, email, a finished run, a tapped hello, three comments.
    const avery = await contact({
      username: 'avery',
      tags: ['vip'],
      email: 'avery@example.com',
      email_collected_at: new Date(),
      came_in_via: 'comment',
      first_automation_id: automation.id,
      last_message_received_at: ago(MILLISECONDS_PER_HOUR),
      last_direct_message_received_at: ago(MILLISECONDS_PER_HOUR),
      last_comment_at: ago(MILLISECONDS_PER_HOUR),
      comment_count: 3,
    });
    await insertAutomationRun({
      organizationId,
      automationId: automation.id,
      contactId: avery.id,
      status: 'completed',
      current_step: 'messages',
      last_message_number: 2,
      waiting_for: null,
      waiting_since_at: null,
      completed_at: new Date(),
    });
    await insertAutomationCommentLog({
      organizationId,
      automationId: automation.id,
      contactId: avery.id,
      instagram_media_id: postId,
      comment_text: 'Price please',
      button_clicked_at: new Date(),
    });
    // Blake: chat closed, phone, an open run, a story reply, came in from an ad.
    await contact({
      username: 'blake',
      tags: ['vip', 'buyer'],
      phone: '+14155550123',
      phone_collected_at: new Date(),
      came_in_via: 'ad_comment',
      last_message_received_at: ago(2 * MILLISECONDS_PER_DAY),
      last_direct_message_received_at: ago(2 * MILLISECONDS_PER_DAY),
      last_story_activity_at: ago(MILLISECONDS_PER_DAY),
    }).then((blake) =>
      insertAutomationRun({ organizationId, automationId: automation.id, contactId: blake.id }),
    );
    // Gray: no details, a broadcast 3 days ago, came in through a ref link.
    await contact({
      username: 'gray',
      tags: ['vip'],
      came_in_via: 'ref_link',
      came_in_ref: 'spring',
      last_message_received_at: ago(30 * MILLISECONDS_PER_DAY),
      last_direct_message_received_at: ago(30 * MILLISECONDS_PER_DAY),
      last_broadcast_at: ago(3 * MILLISECONDS_PER_DAY),
    });
    // Always left out: opted out, paused, deleted, a broadcast in the last 24 hours.
    await contact({ username: 'opted', tags: ['vip'], opted_out_at: new Date() });
    await contact({ username: 'paused', tags: ['vip'], automations_off_at: new Date() });
    await contact({ tags: [], deleted_at: new Date(), instagram_user_id: null });
    await contact({
      username: 'recent',
      tags: ['vip'],
      last_broadcast_at: ago(MILLISECONDS_PER_HOUR),
    });
  });

  /** The two numbers of one tree. */
  async function count(
    conditions: SegmentConditions,
  ): Promise<{ matched: number; canReceiveNow: number }> {
    const result = await repository.countAudience({
      organizationId,
      channelAccountId,
      conditions,
      automationIds,
    });
    return { matched: result.matched, canReceiveNow: result.canReceiveNow };
  }

  it('leaves out opted-out, paused, deleted and recently-broadcast contacts, and counts open chats (AC-9.3)', async () => {
    expect(await count(only({ field: 'tags', match: 'any', values: ['vip'] }))).toEqual({
      matched: 3,
      canReceiveNow: 1,
    });
  });

  it('tags: any, all and none', async () => {
    expect(
      (await count(only({ field: 'tags', match: 'all', values: ['vip', 'buyer'] }))).matched,
    ).toBe(1);
    expect((await count(only({ field: 'tags', match: 'none', values: ['buyer'] }))).matched).toBe(
      2,
    );
  });

  it('details: email, phone, neither, follows the account', async () => {
    expect((await count(only({ field: 'details', has: 'email' }))).matched).toBe(1);
    expect((await count(only({ field: 'details', has: 'phone' }))).matched).toBe(1);
    expect((await count(only({ field: 'details', has: 'neither' }))).matched).toBe(1);
    expect((await count(only({ field: 'details', has: 'follows_account' }))).matched).toBe(0);
  });

  it('automation: every state over the runs of the last 90 days', async () => {
    const state = async (
      value: Extract<SegmentCondition, { field: 'automation' }>['state'],
      messageNumber?: number,
    ) =>
      (
        await count(
          only({
            field: 'automation',
            automation_id: automationPublicId,
            state: value,
            ...(messageNumber === undefined ? {} : { message_number: messageNumber }),
          }),
        )
      ).matched;
    expect(await state('started')).toBe(2);
    expect(await state('finished')).toBe(1);
    expect(await state('in_progress')).toBe(1);
    expect(await state('never')).toBe(1);
    expect(await state('tapped_hello')).toBe(1);
    expect(await state('got_message', 1)).toBe(1);
    expect(await state('got_message', 2)).toBe(1);
    expect(await state('got_message', 3)).toBe(0);
  });

  it('came_in: the first automation, an ad, a ref with and without its value, a story mention', async () => {
    expect(
      (await count(only({ field: 'came_in', via: 'first_automation', value: automationPublicId })))
        .matched,
    ).toBe(1);
    expect((await count(only({ field: 'came_in', via: 'ad' }))).matched).toBe(1);
    expect((await count(only({ field: 'came_in', via: 'ref' }))).matched).toBe(1);
    expect((await count(only({ field: 'came_in', via: 'ref', value: 'spring' }))).matched).toBe(1);
    expect((await count(only({ field: 'came_in', via: 'ref', value: 'autumn' }))).matched).toBe(0);
    expect((await count(only({ field: 'came_in', via: 'story_mention' }))).matched).toBe(0);
  });

  it('commented: any post in a window, a post, a keyword, at least N comments', async () => {
    expect((await count(only({ field: 'commented', post: 'any', days: 7 }))).matched).toBe(1);
    expect((await count(only({ field: 'commented', post: postId }))).matched).toBe(1);
    expect((await count(only({ field: 'commented', post: 'any', keyword: 'PRICE' }))).matched).toBe(
      1,
    );
    expect(
      (await count(only({ field: 'commented', post: 'any', keyword: 'refund' }))).matched,
    ).toBe(0);
    expect((await count(only({ field: 'commented', post: 'any', at_least: 3 }))).matched).toBe(1);
    expect((await count(only({ field: 'commented', post: 'any', at_least: 4 }))).matched).toBe(0);
  });

  it('active, story activity and no broadcast', async () => {
    expect((await count(only({ field: 'active', last_message_within_hours: 2 }))).matched).toBe(1);
    expect((await count(only({ field: 'active', last_message_within_days: 3 }))).matched).toBe(2);
    expect((await count(only({ field: 'active', first_seen_within_days: 1 }))).matched).toBe(3);
    expect((await count(only({ field: 'story_activity', days: 7 }))).matched).toBe(1);
    expect((await count(only({ field: 'no_broadcast', days: 7 }))).matched).toBe(2);
  });

  it('groups: or, and a second level inside and', async () => {
    const emailOrPhone = {
      op: 'or' as const,
      items: [
        { field: 'details' as const, has: 'email' as const },
        { field: 'details' as const, has: 'phone' as const },
      ],
    };
    expect((await count(emailOrPhone)).matched).toBe(2);
    expect(
      (
        await count({
          op: 'and',
          items: [{ field: 'tags', match: 'all', values: ['vip', 'buyer'] }, emailOrPhone],
        })
      ).matched,
    ).toBe(1);
  });

  it("resolves only the account's automations (another account's id is absent)", async () => {
    const other = await insertInstagramAccount({ organizationId });
    const foreign = await insertAutomation({ organizationId, instagramAccountId: other.id });
    const found = await repository.findAccountAutomationIds({
      organizationId,
      channelAccountId,
      automationPublicIds: [automationPublicId, foreign.public_id],
    });
    expect([...found.keys()]).toEqual([automationPublicId]);
  });
});
