import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { segmentConditionsSchema } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';
import { hashConditions } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.service.js';
import { runSegmentCountTask } from '@/domains/app/sub-domains/broadcast/broadcast-segment/workers/broadcast-segment-count.processor.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { getOperatorDatabase, operatorQuery } from '@/tests/helpers/operator-database.js';
import { broadcasts } from '@/domains/app/sub-domains/broadcast/broadcast.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import {
  injectAuthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  createInstagramTeam,
  type InstagramTeamFixture,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';

const AUDIENCE_COUNT_PATH = testApiPath('/app/segments/audience-count');

/** A one-condition tree: she shared her email. */
const EMAIL_CONDITIONS = segmentConditionsSchema.parse({
  op: 'and',
  items: [{ field: 'details', has: 'email' }],
});

/**
 * The background count's Redis copy (routes-final § 7.B BC14, WC-39 — ROUTE row R46,
 * `broadcast-segment-count.cache.ts`) over HTTP — be-read-cache-guard's five tests: a warm copy
 * serves a number Postgres has since changed; nothing invalidates it (every contact write moves the
 * count and none can name the hash — a changed tree is a new key); two organizations' copies never
 * cross; the route's own gates refuse while the copy is warm; Redis down falls back to the inline
 * count.
 */
describe('Segment count copy (route 82, BC14)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A Creator team with one account and `emails` contacts that shared an email. */
  async function teamWithContacts(emails: number): Promise<{
    team: InstagramTeamFixture;
    account: { id: number; public_id: string; channel_account_id: number };
  }> {
    const team = await createInstagramTeam();
    const plan = await createTestPlan({
      features: CREATOR_PLAN_FEATURES,
      priceMonthly: '29.00',
      priceYearly: '276.00',
    });
    await createTestSubscription({
      organizationId: team.organization.id,
      planId: plan.id,
      status: 'ACTIVE',
    });
    const account = await insertInstagramAccount({ organizationId: team.organization.id });
    for (let index = 0; index < emails; index += 1) {
      await addEmailContact({
        organizationId: team.organization.id,
        instagramAccountId: account.id,
      });
    }
    return { team, account };
  }

  function addEmailContact(input: { organizationId: number; instagramAccountId: number }) {
    return insertContact({
      ...input,
      email: `${randomUUID()}@example.com`,
      email_collected_at: new Date(),
    });
  }

  /** The `segment-count` task's preview count, as the worker runs it — it writes the copy. */
  async function warmCopy({
    team,
    account,
    conditions = EMAIL_CONDITIONS,
  }: {
    team: InstagramTeamFixture;
    account: { public_id: string };
    conditions?: typeof EMAIL_CONDITIONS;
  }): Promise<void> {
    await runSegmentCountTask({
      segmentService: app.appDomain.broadcastSegmentService,
      broadcastService: app.appDomain.broadcastService,
      organizationPublicId: team.organization.public_id,
      taskInput: {
        kind: 'preview',
        channelAccountPublicId: account.public_id,
        conditionsHash: hashConditions(conditions),
        conditions,
      },
      runInDatabaseSlot: (callback) => callback(),
    });
  }

  function count({
    team,
    account,
    conditions = EMAIL_CONDITIONS,
    token = team.ownerToken,
  }: {
    team: InstagramTeamFixture;
    account: { public_id: string };
    conditions?: unknown;
    token?: string;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'POST',
      url: AUDIENCE_COUNT_PATH,
      token,
      payload: { channel_account_id: account.public_id, conditions },
      headers: { 'x-idempotency-key': randomUUID() },
    });
  }

  const matchedOf = (response: InjectHttpResult) =>
    (response.json() as { data: { matched: number } }).data.matched;

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
  });

  it('serves the copy over a number Postgres has since changed; a changed tree is another key (tests 1–2)', async () => {
    const { team, account } = await teamWithContacts(2);
    await warmCopy({ team, account });
    // Written straight to Postgres: no write path names the copy, so it stays until its 60 s.
    await addEmailContact({ organizationId: team.organization.id, instagramAccountId: account.id });

    const served = await count({ team, account });
    expect(served.statusCode).toBe(200);
    expect(matchedOf(served)).toBe(2);

    // Other conditions hash to another key: counted inline, the new contact included.
    const phoneOrEmail = segmentConditionsSchema.parse({
      op: 'or',
      items: [
        { field: 'details', has: 'email' },
        { field: 'details', has: 'phone' },
      ],
    });
    const fresh = await count({ team, account, conditions: phoneOrEmail });
    expect(fresh.statusCode).toBe(200);
    expect(matchedOf(fresh)).toBe(3);
  });

  it("keeps two organizations' copies apart (test 3)", async () => {
    const first = await teamWithContacts(1);
    const second = await teamWithContacts(3);
    await warmCopy(first);
    await warmCopy(second);
    await addEmailContact({
      organizationId: first.team.organization.id,
      instagramAccountId: first.account.id,
    });

    expect(matchedOf(await count(first))).toBe(1);
    expect(matchedOf(await count(second))).toBe(3);
    // One organization asking for the other's account never reaches its copy.
    const crossed = await count({ team: first.team, account: second.account });
    expect(crossed.statusCode).toBe(404);
  });

  it("refuses with the route's own gates while the copy is warm (test 4)", async () => {
    const { team, account } = await teamWithContacts(2);
    await warmCopy({ team, account });

    const anonymous = await app.inject({
      method: 'POST',
      url: AUDIENCE_COUNT_PATH,
      payload: { channel_account_id: account.public_id, conditions: EMAIL_CONDITIONS },
      headers: { 'x-idempotency-key': randomUUID() },
    });
    expect(anonymous.statusCode).toBe(401);

    // A move down to Free: the segments switch is off, the warm copy is not served (P76).
    const free = await createTestPlan({
      features: FREE_PLAN_FEATURES,
      priceMonthly: '0.00',
      priceYearly: '0.00',
    });
    await operatorQuery`
      UPDATE billing.subscriptions SET plan_id = ${free.id}
      WHERE organization_id = ${team.organization.id}`;
    const refused = await count({ team, account });
    expect(refused.statusCode).toBe(403);
  });

  it('counts inline in Postgres while Redis is down for the copy (test 5)', async () => {
    const { team, account } = await teamWithContacts(2);
    const isCopyKey = (key: unknown) => String(key).startsWith('app:segment_count');
    const originalGet = redisConnection.get.bind(redisConnection);
    const originalSet = redisConnection.set.bind(redisConnection);
    vi.spyOn(redisConnection, 'get').mockImplementation(((key: string) =>
      isCopyKey(key)
        ? Promise.reject(new Error('ECONNREFUSED'))
        : originalGet(key)) as typeof redisConnection.get);
    vi.spyOn(redisConnection, 'set').mockImplementation(((key: string, ...rest: unknown[]) =>
      isCopyKey(key)
        ? Promise.reject(new Error('ECONNREFUSED'))
        : (originalSet as (...args: unknown[]) => Promise<unknown>)(
            key,
            ...rest,
          )) as typeof redisConnection.set);

    await warmCopy({ team, account });
    const counted = await count({ team, account });
    expect(counted.statusCode).toBe(200);
    expect((counted.json() as { data: Record<string, unknown> }).data).toMatchObject({
      matched: 2,
      is_counting: false,
    });
  });

  it("fills matched of a 'when her chat opens' broadcast from its own copy of the conditions (BC10, WC-39)", async () => {
    const { team, account } = await teamWithContacts(2);
    const insertBroadcast = async (status: 'waiting_for_chats' | 'cancelled') => {
      const [row] = await getOperatorDatabase()
        .insert(broadcasts)
        .values({
          public_id: generatePublicId('broadcast'),
          organization_id: team.organization.id,
          channel_account_id: account.channel_account_id,
          name: 'When she writes',
          status,
          mode: 'when_chat_opens',
          conditions: EMAIL_CONDITIONS,
          messages: [{ kind: 'text' as const, wait_minutes: 0, text: 'Hello' }],
          started_at: new Date(),
          ends_at: new Date(Date.now() + 24 * 3_600_000),
          cancelled_at: status === 'cancelled' ? new Date() : null,
          cancel_reason: status === 'cancelled' ? 'owner' : null,
        })
        .returning();
      return row!;
    };
    const waiting = await insertBroadcast('waiting_for_chats');
    const cancelled = await insertBroadcast('cancelled');
    for (const broadcast of [waiting, cancelled]) {
      await runSegmentCountTask({
        segmentService: app.appDomain.broadcastSegmentService,
        broadcastService: app.appDomain.broadcastService,
        organizationPublicId: team.organization.public_id,
        taskInput: { kind: 'broadcast', broadcastPublicId: broadcast.public_id },
        runInDatabaseSlot: (callback) => callback(),
      });
    }
    const matchedOfRow = async (broadcastId: number) =>
      (
        await getOperatorDatabase()
          .select({ matched: broadcasts.matched })
          .from(broadcasts)
          .where(eq(broadcasts.id, broadcastId))
      )[0]?.matched;
    expect(await matchedOfRow(waiting.id)).toBe(2);
    expect(await matchedOfRow(cancelled.id)).toBe(0);
  });
});
