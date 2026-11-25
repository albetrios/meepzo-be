import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import {
  injectAuthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  createInstagramTeam,
  createPersonalOrganizationWithInstagramCodes,
  readStagedAuditRows,
  type InstagramTeamFixture,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';

const SEGMENTS_PATH = testApiPath('/app/segments');
const AUDIENCE_COUNT_PATH = testApiPath('/app/segments/audience-count');

/** The path of one segment. */
function segmentPath(segmentPublicId: string): string {
  return `${SEGMENTS_PATH}/${segmentPublicId}`;
}

/** A one-condition tree: she shared her email. */
const EMAIL_CONDITIONS = { op: 'and', items: [{ field: 'details', has: 'email' }] };

/** The Segment object as the routes answer it (7.B.6). */
interface SegmentAnswer {
  id: string;
  channel_account_id: string;
  name: string;
  conditions: unknown;
  condition_count: number;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Routes 77–82 of the segments (routes-final § 7.B, ROUTE R21) over HTTP: PRO through the
 * `segments` switch (BC19, P76 — Free `403 plan_lacks_feature` on 78, 80 and 82, open on 77, 79 and
 * 81; a trial's segment still readable after a move down), the tree's limits and an automation of
 * another account (BC12), the audience count with the always-left-out rules and the open window
 * (BC13, BC14), the Viewer's reads and refused writes (AC-9.12), `409 record_changed`, the soft
 * delete, the audit entries, idempotency, team-only, and another organization's segment (K1).
 */
describe('Segment routes (list, save, open, change, delete, count)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  let account: { id: number; public_id: string; channel_account_id: number };

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    team = await createInstagramTeam();
    account = await insertInstagramAccount({ organizationId: team.organization.id });
  });

  /** Gives `organizationId` a plan with these features (P83). */
  async function usePlan({
    features,
    organizationId = team.organization.id,
  }: {
    features: typeof FREE_PLAN_FEATURES;
    organizationId?: number;
  }): Promise<number> {
    const plan = await createTestPlan({ features, priceMonthly: '29.00', priceYearly: '276.00' });
    await createTestSubscription({ organizationId, planId: plan.id, status: 'ACTIVE' });
    return plan.id;
  }

  /** A write with an idempotency key (78, 82). */
  function post({
    url,
    payload,
    token = team.ownerToken,
    idempotencyKey = randomUUID(),
  }: {
    url: string;
    payload: unknown;
    token?: string;
    idempotencyKey?: string | null;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'POST',
      url,
      token,
      payload,
      headers: idempotencyKey === null ? {} : { 'x-idempotency-key': idempotencyKey },
    });
  }

  /** Route 78 on the team's account. */
  function create({
    name = 'Email people',
    conditions = EMAIL_CONDITIONS as unknown,
    token = team.ownerToken,
    accountPublicId = account.public_id,
  }: {
    name?: string;
    conditions?: unknown;
    token?: string;
    accountPublicId?: string;
  } = {}): Promise<InjectHttpResult> {
    return post({
      url: SEGMENTS_PATH,
      token,
      payload: { channel_account_id: accountPublicId, name, conditions },
    });
  }

  /** Route 78, expecting `200`. */
  async function createSegment(name = 'Email people'): Promise<SegmentAnswer> {
    const response = await create({ name });
    expect(response.statusCode).toBe(200);
    return (response.json() as { data: SegmentAnswer }).data;
  }

  function errorOf(response: InjectHttpResult): { reason?: string; errors?: { field: string }[] } {
    return (response.json() as { error: { reason?: string; errors?: { field: string }[] } }).error;
  }

  describe('on a plan with segments (Creator)', () => {
    beforeEach(async () => {
      await usePlan({ features: CREATOR_PLAN_FEATURES });
    });

    it('saves a segment on its account and answers it (AC-9.2)', async () => {
      const segment = await createSegment('  VIPs  ');
      expect(segment).toMatchObject({
        channel_account_id: account.public_id,
        name: 'VIPs',
        conditions: EMAIL_CONDITIONS,
        condition_count: 1,
        created_by_user_id: team.owner.public_id,
      });
      expect(segment.id).toMatch(/^seg_[a-z0-9]{21}$/);
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.segment.create',
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.metadata).toMatchObject({ segment_public_id: segment.id });
    });

    it('refuses more than 20 conditions or more than 2 levels on conditions (AC-9.2)', async () => {
      const condition = { field: 'details', has: 'email' };
      const tooMany = await create({ conditions: { op: 'and', items: Array(21).fill(condition) } });
      expect(tooMany.statusCode).toBe(400);
      // The route schema answers first, naming the body field (and the path inside it).
      expect(errorOf(tooMany).errors?.[0]?.field).toMatch(/^body\.conditions/);
      const tooDeep = await create({
        conditions: {
          op: 'and',
          items: [{ op: 'or', items: [{ op: 'and', items: [condition] }] }],
        },
      });
      expect(tooDeep.statusCode).toBe(400);
      // The route schema answers first, naming the body field (and the path inside it).
      expect(errorOf(tooDeep).errors?.[0]?.field).toMatch(/^body\.conditions/);
    });

    it('refuses an automation of another account with 400 on conditions (BC12)', async () => {
      const other = await insertInstagramAccount({ organizationId: team.organization.id });
      const foreign = await insertAutomation({
        organizationId: team.organization.id,
        instagramAccountId: other.id,
      });
      const own = await insertAutomation({
        organizationId: team.organization.id,
        instagramAccountId: account.id,
      });
      const refused = await create({
        conditions: {
          op: 'and',
          items: [{ field: 'automation', automation_id: foreign.public_id, state: 'started' }],
        },
      });
      expect(refused.statusCode).toBe(400);
      expect(errorOf(refused).errors?.map((item) => item.field)).toEqual(['conditions']);
      const allowed = await create({
        conditions: {
          op: 'and',
          items: [{ field: 'automation', automation_id: own.public_id, state: 'started' }],
        },
      });
      expect(allowed.statusCode).toBe(200);
    });

    it("answers 404 channel_account_not_found for another organization's account", async () => {
      const otherTeam = await createInstagramTeam();
      const otherAccount = await insertInstagramAccount({
        organizationId: otherTeam.organization.id,
      });
      const refused = await create({ accountPublicId: otherAccount.public_id });
      expect(refused.statusCode).toBe(404);
      expect(errorOf(refused).reason).toBe('channel_account_not_found');
    });

    it('lists one account by name or newest first, pages, and leaves deleted ones out', async () => {
      const beta = await createSegment('Beta');
      await createSegment('Alpha');
      await createSegment('Gamma');
      const byName = await injectAuthenticated(app, {
        method: 'GET',
        url: `${SEGMENTS_PATH}?channel_account_id=${account.public_id}&limit=2`,
        token: team.ownerToken,
      });
      expect(byName.statusCode).toBe(200);
      const page = byName.json() as {
        data: SegmentAnswer[];
        meta: { pagination: { has_more: boolean; next: string | null; estimated_total: number } };
      };
      expect(page.data.map((segment) => segment.name)).toEqual(['Alpha', 'Beta']);
      expect(page.meta.pagination.estimated_total).toBe(3);
      const next = await injectAuthenticated(app, {
        method: 'GET',
        url: `${SEGMENTS_PATH}?channel_account_id=${account.public_id}&limit=2&after=${page.meta.pagination.next}`,
        token: team.ownerToken,
      });
      expect(
        (next.json() as { data: SegmentAnswer[] }).data.map((segment) => segment.name),
      ).toEqual(['Gamma']);
      const deleted = await injectAuthenticated(app, {
        method: 'DELETE',
        url: segmentPath(beta.id),
        token: team.ownerToken,
      });
      expect(deleted.statusCode).toBe(204);
      const newest = await injectAuthenticated(app, {
        method: 'GET',
        url: `${SEGMENTS_PATH}?channel_account_id=${account.public_id}&sort=created_at`,
        token: team.ownerToken,
      });
      expect(
        (newest.json() as { data: SegmentAnswer[] }).data.map((segment) => segment.name),
      ).toEqual(['Gamma', 'Alpha']);
      const missingAccount = await injectAuthenticated(app, {
        method: 'GET',
        url: SEGMENTS_PATH,
        token: team.ownerToken,
      });
      expect(missingAccount.statusCode).toBe(400);
    });

    it('changes the name and conditions, refuses a stale save with 409, and deletes once', async () => {
      const segment = await createSegment('VIPs');
      const changed = await injectAuthenticated(app, {
        method: 'PATCH',
        url: segmentPath(segment.id),
        token: team.editorToken,
        payload: {
          name: 'Phone people',
          conditions: { op: 'and', items: [{ field: 'details', has: 'phone' }] },
          expected_updated_at: segment.updated_at,
        },
      });
      expect(changed.statusCode).toBe(200);
      expect((changed.json() as { data: SegmentAnswer }).data.name).toBe('Phone people');
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.segment.update',
      });
      expect(audit[0]?.metadata).toMatchObject({ changed_fields: ['name', 'conditions'] });
      const stale = await injectAuthenticated(app, {
        method: 'PATCH',
        url: segmentPath(segment.id),
        token: team.ownerToken,
        payload: { name: 'Again', expected_updated_at: segment.updated_at },
      });
      expect(stale.statusCode).toBe(409);
      expect(errorOf(stale).reason).toBe('record_changed');
      const deleted = await injectAuthenticated(app, {
        method: 'DELETE',
        url: segmentPath(segment.id),
        token: team.ownerToken,
      });
      expect(deleted.statusCode).toBe(204);
      const deleteAudit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.segment.delete',
      });
      expect(deleteAudit).toHaveLength(1);
      for (const method of ['GET', 'DELETE'] as const) {
        const gone = await injectAuthenticated(app, {
          method,
          url: segmentPath(segment.id),
          token: team.ownerToken,
        });
        expect(gone.statusCode).toBe(404);
        expect(errorOf(gone).reason).toBe('segment_not_found');
      }
    });

    it('counts how many match and can get it now, leaving out opted-out, paused and deleted contacts (AC-9.3)', async () => {
      const contact = (
        overrides: Omit<
          Parameters<typeof insertContact>[0],
          'organizationId' | 'instagramAccountId'
        >,
      ) =>
        insertContact({
          organizationId: team.organization.id,
          instagramAccountId: account.id,
          ...overrides,
        });
      const now = Date.now();
      await contact({
        email: 'open@example.com',
        email_collected_at: new Date(),
        last_direct_message_received_at: new Date(now),
      });
      await contact({
        email: 'closed@example.com',
        email_collected_at: new Date(),
        last_direct_message_received_at: new Date(now - 2 * 24 * 3_600_000),
      });
      await contact({
        email: 'opted@example.com',
        email_collected_at: new Date(),
        opted_out_at: new Date(),
      });
      await contact({
        email: 'paused@example.com',
        email_collected_at: new Date(),
        automations_off_at: new Date(),
      });
      await contact({ deleted_at: new Date(), instagram_user_id: null });
      await contact({ phone: '+14155550123', phone_collected_at: new Date() });
      const counted = await post({
        url: AUDIENCE_COUNT_PATH,
        payload: { channel_account_id: account.public_id, conditions: EMAIL_CONDITIONS },
      });
      expect(counted.statusCode).toBe(200);
      expect((counted.json() as { data: Record<string, unknown> }).data).toMatchObject({
        matched: 2,
        can_receive_now: 1,
        is_counting: false,
      });
      const segment = await createSegment();
      const saved = await post({
        url: AUDIENCE_COUNT_PATH,
        token: team.viewerToken,
        payload: { channel_account_id: account.public_id, segment_id: segment.id },
      });
      expect(saved.statusCode).toBe(200);
      expect((saved.json() as { data: { matched: number } }).data.matched).toBe(2);
      const other = await insertInstagramAccount({ organizationId: team.organization.id });
      const wrongAccount = await post({
        url: AUDIENCE_COUNT_PATH,
        payload: { channel_account_id: other.public_id, segment_id: segment.id },
      });
      expect(wrongAccount.statusCode).toBe(400);
      expect(errorOf(wrongAccount).errors?.map((item) => item.field)).toEqual(['segment_id']);
      const both = await post({
        url: AUDIENCE_COUNT_PATH,
        payload: {
          channel_account_id: account.public_id,
          segment_id: segment.id,
          conditions: EMAIL_CONDITIONS,
        },
      });
      expect(both.statusCode).toBe(400);
    });

    it('needs X-Idempotency-Key on the save and the count (P89)', async () => {
      for (const [url, payload] of [
        [
          SEGMENTS_PATH,
          { channel_account_id: account.public_id, name: 'x', conditions: EMAIL_CONDITIONS },
        ],
        [
          AUDIENCE_COUNT_PATH,
          { channel_account_id: account.public_id, conditions: EMAIL_CONDITIONS },
        ],
      ] as const) {
        const refused = await post({ url, payload, idempotencyKey: null });
        expect(refused.statusCode).toBe(422);
      }
    });

    it('lets a Viewer list, read and count, and refuses every change with missing_permission (AC-9.12)', async () => {
      const segment = await createSegment();
      for (const url of [
        `${SEGMENTS_PATH}?channel_account_id=${account.public_id}`,
        segmentPath(segment.id),
      ]) {
        const read = await injectAuthenticated(app, {
          method: 'GET',
          url,
          token: team.viewerToken,
        });
        expect(read.statusCode).toBe(200);
      }
      const refusals = [
        await create({ token: team.viewerToken }),
        await injectAuthenticated(app, {
          method: 'PATCH',
          url: segmentPath(segment.id),
          token: team.viewerToken,
          payload: { name: 'No' },
        }),
        await injectAuthenticated(app, {
          method: 'DELETE',
          url: segmentPath(segment.id),
          token: team.viewerToken,
        }),
      ];
      for (const refused of refusals) {
        expect(refused.statusCode).toBe(403);
        expect(errorOf(refused).reason).toBe('missing_permission');
      }
    });

    it("answers 404 segment_not_found for another organization's segment and leaves it unchanged (K1)", async () => {
      const otherTeam = await createInstagramTeam();
      const otherAccount = await insertInstagramAccount({
        organizationId: otherTeam.organization.id,
      });
      await usePlan({ features: CREATOR_PLAN_FEATURES, organizationId: otherTeam.organization.id });
      const foreign = (
        (
          await create({ token: otherTeam.ownerToken, accountPublicId: otherAccount.public_id })
        ).json() as { data: SegmentAnswer }
      ).data;
      const attempts = [
        await injectAuthenticated(app, {
          method: 'GET',
          url: segmentPath(foreign.id),
          token: team.ownerToken,
        }),
        await injectAuthenticated(app, {
          method: 'PATCH',
          url: segmentPath(foreign.id),
          token: team.ownerToken,
          payload: { name: 'Taken' },
        }),
        await injectAuthenticated(app, {
          method: 'DELETE',
          url: segmentPath(foreign.id),
          token: team.ownerToken,
        }),
      ];
      for (const attempt of attempts) {
        expect(attempt.statusCode).toBe(404);
        expect(errorOf(attempt).reason).toBe('segment_not_found');
      }
      const [row] = await operatorQuery<{ name: string; deleted_at: Date | null }[]>`
        SELECT name, deleted_at FROM app.segments WHERE public_id = ${foreign.id}`;
      expect(row).toEqual({ name: 'Email people', deleted_at: null });
    });
  });

  describe('on Free (BC19, P76)', () => {
    it('refuses save, change and count with 403 plan_lacks_feature and leaves list, read and delete open (AC-9.1)', async () => {
      const creatorPlanId = await usePlan({ features: CREATOR_PLAN_FEATURES });
      const segment = await createSegment('Made in the trial');
      // The move down: the subscription's plan becomes Free.
      const freePlan = await createTestPlan({
        features: FREE_PLAN_FEATURES,
        priceMonthly: '0.00',
        priceYearly: '0.00',
      });
      await operatorQuery`
        UPDATE billing.subscriptions SET plan_id = ${freePlan.id}
        WHERE organization_id = ${team.organization.id} AND plan_id = ${creatorPlanId}`;
      const refusals = [
        await create(),
        await injectAuthenticated(app, {
          method: 'PATCH',
          url: segmentPath(segment.id),
          token: team.ownerToken,
          payload: { name: 'Renamed' },
        }),
        await post({
          url: AUDIENCE_COUNT_PATH,
          payload: { channel_account_id: account.public_id, segment_id: segment.id },
        }),
      ];
      for (const refused of refusals) {
        expect(refused.statusCode).toBe(403);
        expect(errorOf(refused).reason).toBe('plan_lacks_feature');
      }
      const list = await injectAuthenticated(app, {
        method: 'GET',
        url: `${SEGMENTS_PATH}?channel_account_id=${account.public_id}`,
        token: team.ownerToken,
      });
      expect(list.statusCode).toBe(200);
      expect((list.json() as { data: SegmentAnswer[] }).data.map((row) => row.id)).toEqual([
        segment.id,
      ]);
      const read = await injectAuthenticated(app, {
        method: 'GET',
        url: segmentPath(segment.id),
        token: team.ownerToken,
      });
      expect(read.statusCode).toBe(200);
      const deleted = await injectAuthenticated(app, {
        method: 'DELETE',
        url: segmentPath(segment.id),
        token: team.ownerToken,
      });
      expect(deleted.statusCode).toBe(204);
    });
  });

  it('is team-only: a personal organization reads 404 team_organization_required and writes 422', async () => {
    const personal = await createPersonalOrganizationWithInstagramCodes({
      permissionCodes: [APP_PERMISSIONS.AUTOMATION_READ, APP_PERMISSIONS.AUTOMATION_CREATE],
    });
    const read = await injectAuthenticated(app, {
      method: 'GET',
      url: `${SEGMENTS_PATH}?channel_account_id=${account.public_id}`,
      token: personal.token,
    });
    expect(read.statusCode).toBe(404);
    expect(errorOf(read).reason).toBe('team_organization_required');
    const write = await create({ token: personal.token });
    expect(write.statusCode).toBe(422);
  });
});
