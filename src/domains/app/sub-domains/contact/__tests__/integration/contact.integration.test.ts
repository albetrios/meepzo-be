import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { env } from '@/shared/config/env.config.js';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { INSTAGRAM_DATABASE_TASKS_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-database-tasks.queue.js';
import { CONTACT_BULK_ACTION_JOB_NAME } from '@/domains/app/sub-domains/contact/queues/contact-bulk-action.job.schema.js';
import type { InstagramSendTicketContext } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { contact_tag_events } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.schema.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  injectAuthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  createInstagramTeam,
  createPersonalOrganizationWithInstagramCodes,
  endPaidPlanWithoutPaying,
  readStagedAuditRows,
  type InstagramTeamFixture,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  CONTACT_BULK_ACTIONS_PATH,
  CONTACT_TAGS_PATH,
  CONTACTS_PATH,
  contactPath,
  type ContactFixtureRow,
  insertContact,
  insertInstagramAccount,
  readContactRow,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  automationActionPath,
  insertAutomation,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationRun,
  readRunRow,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { captureLogLines } from '@/domains/app/__tests__/e2e/instagram-retention-erasure.helper.js';

/**
 * Routes 18–23 of the contacts (routes-final § 3.A, ROUTE R10; launch R8) over HTTP: the list of one
 * account with every filter, every sort in both directions across pages, the search (≥ 3
 * characters), paging and the estimated total; open one; the owner's note, tags and pause; the bulk
 * action's validation; the tag list with counts; the erase clearing every personal column, its
 * audit entry and a repeat; team-only (3.5), the Viewer and Editor gates (AC-5.11), the erase open
 * on a read-only plan (D27) and another organization's contacts (K1). The database, auth,
 * permissions and audit are real.
 */
describe('Contact routes (list, open, update, bulk, tags, erase)', () => {
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

  /** A contact of the team's account. */
  function contactOfTeam(
    overrides: Partial<
      Omit<ContactFixtureRow, 'id' | 'organization_id' | 'instagram_account_id'>
    > = {},
  ): Promise<ContactFixtureRow> {
    return insertContact({
      organizationId: team.organization.id,
      instagramAccountId: account.id,
      ...overrides,
    });
  }

  /** Route 18 — of the team's account unless `accountPublicId` names another (`null`: none). */
  function list({
    token = team.ownerToken,
    query = '',
    accountPublicId = account.public_id,
  }: {
    token?: string;
    query?: string;
    accountPublicId?: string | null;
  } = {}): Promise<InjectHttpResult> {
    const parts = [
      accountPublicId === null ? '' : `channel_account_id=${accountPublicId}`,
      query,
    ].filter((part) => part !== '');
    return injectAuthenticated(app, {
      method: 'GET',
      url: parts.length === 0 ? CONTACTS_PATH : `${CONTACTS_PATH}?${parts.join('&')}`,
      token,
    });
  }

  function erase({
    contactPublicId,
    token = team.ownerToken,
  }: {
    contactPublicId: string;
    token?: string;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, { method: 'DELETE', url: contactPath(contactPublicId), token });
  }

  type ListBody = {
    data: Array<Record<string, unknown> & { id: string }>;
    meta: {
      pagination: {
        per_page: number;
        next: string | null;
        has_more: boolean;
        estimated_total?: number;
      };
    };
  };

  function bodyOf(response: InjectHttpResult): ListBody {
    return response.json() as ListBody;
  }

  /** The contact public ids `query` lists (one page of 100). */
  async function listedIds(
    query = '',
    token = team.ownerToken,
    accountPublicId: string = account.public_id,
  ): Promise<string[]> {
    const response = await list({
      token,
      accountPublicId,
      query: query === '' ? 'limit=100' : `${query}&limit=100`,
    });
    expect(response.statusCode).toBe(200);
    return bodyOf(response).data.map((contact) => contact.id);
  }

  /** Every page of `query`, `limit` at a time, as one list of public ids. */
  async function pagedIds(query: string, limit: number): Promise<string[]> {
    const ids: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const cursor: string = after === null ? '' : `&after=${encodeURIComponent(after)}`;
      const response = await list({ query: `${query}&limit=${limit}${cursor}` });
      expect(response.statusCode).toBe(200);
      const body = bodyOf(response);
      ids.push(...body.data.map((contact) => contact.id));
      if (!body.meta.pagination.has_more) return ids;
      after = body.meta.pagination.next;
    }
    throw new Error('paging did not end');
  }

  function errorOf(response: InjectHttpResult): {
    code?: string;
    reason?: string;
    errors?: Array<{ field: string }>;
  } {
    return (response.json() as { error: Record<string, never> }).error;
  }

  const day = (daysAgo: number) => new Date(Date.now() - daysAgo * MILLISECONDS_PER_DAY);

  describe('GET /app/contacts (route 18)', () => {
    it('lists each live contact with its account and every field, newest last message first (AC-4.1)', async () => {
      const older = await contactOfTeam({
        username: 'jordan.lee',
        full_name: 'Jordan Lee',
        email: 'jordan.lee@example.com',
        email_collected_at: day(1),
        phone: '+15550100123',
        phone_collected_at: day(1),
        is_following_account: true,
        follow_checked_at: day(1),
        tags: ['vip'],
        first_seen_at: day(5),
        last_message_received_at: day(2),
      });
      const newer = await contactOfTeam({
        username: 'sam.rivera',
        last_message_received_at: day(1),
      });

      const response = await list();

      expect(response.statusCode).toBe(200);
      const body = bodyOf(response);
      expect(body.data.map((contact) => contact.id)).toEqual([newer.public_id, older.public_id]);
      expect(body.data[1]).toMatchObject({
        id: older.public_id,
        channel_account_id: account.public_id,
        channel: 'instagram',
        instagram_user_id: older.instagram_user_id,
        username: 'jordan.lee',
        full_name: 'Jordan Lee',
        email: 'jordan.lee@example.com',
        phone: '+15550100123',
        is_following_account: true,
        tags: ['vip'],
        is_opted_out: false,
        is_automations_paused: false,
        came_in_via: null,
        first_automation_id: null,
        first_message_at: null,
        last_comment_at: null,
        comment_count: 0,
        first_seen_at: older.first_seen_at.toISOString(),
        last_message_received_at: older.last_message_received_at.toISOString(),
      });
      expect(body.data[1]).not.toHaveProperty('deleted_at');
      expect(body.data[1]).not.toHaveProperty('note');
      expect(body.data[1]).not.toHaveProperty('organization_id');
      expect(body.meta.pagination).toMatchObject({ per_page: 25, has_more: false, next: null });
      expect(body.meta.pagination.estimated_total).toBe(2);
    });

    it('shows an Editor the emails and phones (AC-4.15) and an Admin the same list', async () => {
      const contact = await contactOfTeam({
        email: 'member.view@example.com',
        email_collected_at: day(1),
        phone: '+919825012345',
        phone_collected_at: day(1),
      });

      for (const token of [team.editorToken, team.adminToken]) {
        const response = await list({ token });
        expect(response.statusCode).toBe(200);
        expect(bodyOf(response).data).toEqual([
          expect.objectContaining({
            id: contact.public_id,
            email: 'member.view@example.com',
            phone: '+919825012345',
          }),
        ]);
      }
    });

    it("never lists an erased contact or another organization's contacts (K1, CT9)", async () => {
      const live = await contactOfTeam();
      await contactOfTeam({
        instagram_user_id: null,
        deleted_at: new Date(),
      });
      const otherTeam = await createInstagramTeam();
      const otherAccount = await insertInstagramAccount({
        organizationId: otherTeam.organization.id,
      });
      const foreign = await insertContact({
        organizationId: otherTeam.organization.id,
        instagramAccountId: otherAccount.id,
      });

      expect(await listedIds()).toEqual([live.public_id]);
      expect(await listedIds('', otherTeam.ownerToken, otherAccount.public_id)).toEqual([
        foreign.public_id,
      ]);
    });

    it('refuses a list without the account, or with a malformed one (CT2, AC-5.1)', async () => {
      for (const accountPublicId of [null, 'cha_short']) {
        const response = await list({ accountPublicId });
        expect(response.statusCode).toBe(400);
        expect(errorOf(response).errors?.map((item) => item.field)).toContain(
          'querystring.channel_account_id',
        );
      }
    });

    it('answers 404 team_organization_required on a personal organization (CT3)', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes({
        permissionCodes: [APP_PERMISSIONS.CONTACT_READ],
      });

      const response = await list({ token: personal.token });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('team_organization_required');
    });

    describe('filters (CT12)', () => {
      it('is_opted_out, is_automations_paused, came_in_via and first_automation_id', async () => {
        const automation = await insertAutomation({
          organizationId: team.organization.id,
          instagramAccountId: account.id,
        });
        const optedOut = await contactOfTeam({ opted_out_at: day(1) });
        const paused = await contactOfTeam({ automations_off_at: day(1) });
        const cameIn = await contactOfTeam({
          first_automation_id: automation.id,
          came_in_via: 'dm_keyword',
        });

        expect(await listedIds('is_opted_out=true')).toEqual([optedOut.public_id]);
        expect(await listedIds('is_automations_paused=true')).toEqual([paused.public_id]);
        expect((await listedIds('is_automations_paused=false')).sort()).toEqual(
          [optedOut.public_id, cameIn.public_id].sort(),
        );
        expect(await listedIds('came_in_via=comment,dm_keyword')).toEqual([cameIn.public_id]);
        expect(await listedIds(`first_automation_id=${automation.public_id}`)).toEqual([
          cameIn.public_id,
        ]);
        expect(await listedIds(`first_automation_id=${generatePublicId('automation')}`)).toEqual(
          [],
        );
        const shown = bodyOf(await list({ query: 'came_in_via=dm_keyword' })).data[0];
        expect(shown).toMatchObject({
          came_in_via: 'dm_keyword',
          first_automation_id: automation.public_id,
        });
      });

      it('tags: the contact holds every one given, exact text', async () => {
        const both = await contactOfTeam({ tags: ['vip', 'giveaway', 'catalog'] });
        await contactOfTeam({ tags: ['vip'] });
        await contactOfTeam({ tags: ['VIP', 'giveaway'] });

        expect(await listedIds('tags=vip,giveaway')).toEqual([both.public_id]);
        expect(await listedIds('tags=vip')).toHaveLength(2);
      });

      it('has_email and has_phone, both ways', async () => {
        const withEmail = await contactOfTeam({
          email: 'has.email@example.com',
          email_collected_at: day(1),
          last_message_received_at: day(2),
        });
        const withPhone = await contactOfTeam({
          phone: '+15550100999',
          phone_collected_at: day(1),
          last_message_received_at: day(1),
        });

        expect(await listedIds('has_email=true')).toEqual([withEmail.public_id]);
        expect(await listedIds('has_email=false')).toEqual([withPhone.public_id]);
        expect(await listedIds('has_phone=true')).toEqual([withPhone.public_id]);
        expect(await listedIds('has_phone=false')).toEqual([withEmail.public_id]);
      });

      it('is_following_account: a never-checked contact matches neither value', async () => {
        const following = await contactOfTeam({
          is_following_account: true,
          follow_checked_at: day(1),
        });
        const notFollowing = await contactOfTeam({
          is_following_account: false,
          follow_checked_at: day(1),
        });
        const neverChecked = await contactOfTeam();

        expect(await listedIds('is_following_account=true')).toEqual([following.public_id]);
        expect(await listedIds('is_following_account=false')).toEqual([notFollowing.public_id]);
        expect(await listedIds()).toContain(neverChecked.public_id);
      });

      it('first_seen_from is inclusive and first_seen_to exclusive', async () => {
        const boundary = new Date('2026-11-10T00:00:00.000Z');
        const atStart = await contactOfTeam({ first_seen_at: boundary });
        const before = await contactOfTeam({
          first_seen_at: new Date('2026-11-09T23:59:59.000Z'),
        });
        const atEnd = await contactOfTeam({ first_seen_at: new Date('2026-11-12T00:00:00.000Z') });

        const inRange = await listedIds(
          'first_seen_from=2026-11-10T00:00:00Z&first_seen_to=2026-11-12T00:00:00Z',
        );
        expect(inRange).toEqual([atStart.public_id]);
        expect(await listedIds('first_seen_to=2026-11-10T00:00:00Z')).toEqual([before.public_id]);
        expect(await listedIds('first_seen_from=2026-11-12T00:00:00Z')).toEqual([atEnd.public_id]);
      });

      it('channel_account_id: one account each — the same person is a contact per account (AC-4.7)', async () => {
        const instagramUserId = '17841499900000001';
        const first = await contactOfTeam({ instagram_user_id: instagramUserId });
        const secondAccount = await insertInstagramAccount({
          organizationId: team.organization.id,
          connectionStatus: 'revoked',
        });
        const second = await insertContact({
          organizationId: team.organization.id,
          instagramAccountId: secondAccount.id,
          instagram_user_id: instagramUserId,
        });

        expect(await listedIds()).toEqual([first.public_id]);
        expect(await listedIds('', team.ownerToken, secondAccount.public_id)).toEqual([
          second.public_id,
        ]);
        const listed = bodyOf(await list({ accountPublicId: secondAccount.public_id }));
        expect(listed.data[0]?.channel_account_id).toBe(secondAccount.public_id);
      });

      it("gives an empty page for an unknown or another organization's account", async () => {
        await contactOfTeam();
        const otherTeam = await createInstagramTeam();
        const otherAccount = await insertInstagramAccount({
          organizationId: otherTeam.organization.id,
        });

        expect(await listedIds('', team.ownerToken, generatePublicId('channelAccount'))).toEqual(
          [],
        );
        expect(await listedIds('', team.ownerToken, otherAccount.public_id)).toEqual([]);
      });
    });

    describe('search q (CT12, S6)', () => {
      it('finds every word anywhere in username, full name, email or phone, in any case (AC-5.2)', async () => {
        const jordan = await contactOfTeam({
          username: 'jordan.lee',
          full_name: 'Jordan Lee',
          email: 'jl.orders@example.com',
          email_collected_at: day(1),
          phone: '+15550100123',
          phone_collected_at: day(1),
        });
        const sam = await contactOfTeam({ username: 'sam_rivera', full_name: 'Sam Rivera' });

        expect(await listedIds('q=JORDAN')).toEqual([jordan.public_id]);
        expect(await listedIds('q=lee%20jordan')).toEqual([jordan.public_id]);
        expect(await listedIds('q=orders@example')).toEqual([jordan.public_id]);
        expect(await listedIds('q=rivera')).toEqual([sam.public_id]);
        expect(await listedIds('q=jordan%20rivera')).toEqual([]);
        expect(await listedIds('q=50%25_off')).toEqual([]);
        expect(await listedIds('q=0100123')).toEqual([jordan.public_id]);
      });

      it('refuses a search under 3 characters (S6, AC-5.2)', async () => {
        const response = await list({ query: 'q=jo' });
        expect(response.statusCode).toBe(400);
        expect(errorOf(response).errors?.map((item) => item.field)).toContain('querystring.q');
      });
    });

    describe('sorts across pages, both directions (CT6, CQ2, AC-4.5)', () => {
      it('last_message_received_at: newest first by default, oldest first with order=asc', async () => {
        const rows = [];
        for (let index = 0; index < 5; index += 1) {
          rows.push(await contactOfTeam({ last_message_received_at: day(10 - index) }));
        }
        const oldestFirst = rows.map((row) => row.public_id);

        expect(await pagedIds('sort=last_message_received_at', 2)).toEqual(
          [...oldestFirst].reverse(),
        );
        expect(await pagedIds('order=desc', 2)).toEqual([...oldestFirst].reverse());
        expect(await pagedIds('sort=last_message_received_at&order=asc', 2)).toEqual(oldestFirst);
      });

      it('first_seen_at: newest first by default, oldest first with order=asc; ties by id', async () => {
        const tie = day(3);
        const rows = [
          await contactOfTeam({ first_seen_at: day(9) }),
          await contactOfTeam({ first_seen_at: tie }),
          await contactOfTeam({ first_seen_at: tie }),
          await contactOfTeam({ first_seen_at: day(1) }),
        ];
        const [oldest, tiedFirst, tiedSecond, newest] = rows.map((row) => row.public_id);

        expect(await pagedIds('sort=first_seen_at', 1)).toEqual([
          newest,
          tiedSecond,
          tiedFirst,
          oldest,
        ]);
        expect(await pagedIds('sort=first_seen_at&order=asc', 1)).toEqual([
          oldest,
          tiedFirst,
          tiedSecond,
          newest,
        ]);
      });

      it('username: A→Z by default and Z→A, contacts without a username last either way', async () => {
        const zed = await contactOfTeam({ username: 'zed.shop' });
        const withoutFirst = await contactOfTeam({ username: null });
        const amy = await contactOfTeam({ username: 'amy.k' });
        const withoutSecond = await contactOfTeam({ username: null });
        const mia = await contactOfTeam({ username: 'mia_r' });

        const ascending = [amy, mia, zed, withoutFirst, withoutSecond].map((row) => row.public_id);
        const descending = [zed, mia, amy, withoutFirst, withoutSecond].map((row) => row.public_id);
        for (const limit of [1, 2, 3]) {
          expect(await pagedIds('sort=username', limit)).toEqual(ascending);
          expect(await pagedIds('sort=username&order=desc', limit)).toEqual(descending);
        }
      });
    });

    describe('paging (K2, AC-4.6)', () => {
      it('carries the estimated total on the first page only and continues from the cursor', async () => {
        for (let index = 0; index < 3; index += 1) {
          await contactOfTeam({ last_message_received_at: day(index + 1) });
        }

        const first = bodyOf(await list({ query: 'limit=2' }));
        expect(first.data).toHaveLength(2);
        expect(first.meta.pagination).toMatchObject({ per_page: 2, has_more: true });
        expect(first.meta.pagination.estimated_total).toBe(3);

        const second = bodyOf(
          await list({
            query: `limit=2&after=${encodeURIComponent(first.meta.pagination.next as string)}`,
          }),
        );
        expect(second.data).toHaveLength(1);
        expect(second.meta.pagination.has_more).toBe(false);
        expect(second.meta.pagination.estimated_total).toBeUndefined();
      });

      it('restarts at the first page when a cursor is reused under another filter (sec-U12)', async () => {
        for (let index = 0; index < 3; index += 1) {
          await contactOfTeam({ tags: ['vip'], last_message_received_at: day(index + 1) });
        }
        const first = bodyOf(await list({ query: 'limit=1' }));
        const reused = bodyOf(
          await list({
            query: `limit=1&tags=vip&after=${encodeURIComponent(first.meta.pagination.next as string)}`,
          }),
        );
        expect(reused.data[0]?.id).toBe(first.data[0]?.id);
      });
    });

    describe('400 on a bad query (2.9)', () => {
      it.each([
        ['limit=0', 'limit'],
        ['limit=101', 'limit'],
        ['sort=email', 'sort'],
        ['order=up', 'order'],
        ['has_email=yes', 'has_email'],
        ['is_following_account=maybe', 'is_following_account'],
        ['first_seen_from=2026-11-10', 'first_seen_from'],
        ['came_in_via=carrier_pigeon', 'came_in_via'],
        ['is_opted_out=maybe', 'is_opted_out'],
        ['automation_id=con_k7x9m2pqr4w8n1v3a1b2c', 'automation_id'],
        ['tags=a,b,c,d,e,f,g,h,i,j,k', 'tags'],
        [
          'first_seen_from=2026-11-12T00:00:00Z&first_seen_to=2026-11-10T00:00:00Z',
          'first_seen_from',
        ],
      ])('refuses %s naming querystring.%s', async (query, field) => {
        const response = await list({ query });
        expect(response.statusCode).toBe(400);
        // Fastify's schema validation names a query parameter `querystring.<name>`.
        expect(errorOf(response).errors?.map((item) => item.field)).toContain(
          `querystring.${field}`,
        );
      });

      // The drop's `search` is `q` (CT4). The automation filter (CT5) is covered with the runs it
      // reads, in automation-run.integration.test.ts.
      it.each([
        ['search=jordan', 'search'],
        [`instagram_account_id=${generatePublicId('channelAccount')}`, 'instagram_account_id'],
      ])('refuses the unknown parameter %s', async (query, field) => {
        const response = await list({ query });
        expect(response.statusCode).toBe(400);
        expect(errorOf(response).errors?.map((item) => item.field)).toContain(
          `querystring.${field}`,
        );
      });
    });
  });

  describe('DELETE /app/contacts/{contact_id} (route 23)', () => {
    it('erases every personal column, keeps the row, writes the audit entry and never lists it again (AC-4.10, AC-4.14)', async () => {
      const contact = await contactOfTeam({
        username: 'jordan.lee',
        full_name: 'Jordan Lee',
        profile_picture_url: 'https://scontent.cdninstagram.com/v/jordan.jpg',
        followers_count: 812,
        is_following_account: true,
        follow_checked_at: day(1),
        email: 'jordan.lee@example.com',
        email_collected_at: day(1),
        phone: '+15550100123',
        phone_collected_at: day(1),
        tags: ['vip', 'giveaway'],
        note: 'Asked about sizes',
        opted_out_at: day(1),
        automations_off_at: day(1),
        automations_off_by_user_id: team.owner.id,
        came_in_ref: 'SPRING',
        last_direct_message_received_at: day(1),
        last_message_sent_at: day(1),
        last_comment_at: day(1),
        comment_count: 4,
      });

      const response = await erase({ contactPublicId: contact.public_id });

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      const row = await readContactRow(contact.id);
      expect(row).toMatchObject({
        public_id: contact.public_id,
        channel_account_id: account.channel_account_id,
        instagram_user_id: null,
        username: null,
        full_name: null,
        profile_picture_url: null,
        followers_count: null,
        is_following_account: null,
        follow_checked_at: null,
        email: null,
        email_collected_at: null,
        phone: null,
        phone_collected_at: null,
        tags: [],
        note: null,
        opted_out_at: null,
        automations_off_at: null,
        automations_off_by_user_id: null,
        came_in_ref: null,
        // Her activity row is deleted with the erase (CT11, S5).
        last_message_received_at: null,
        last_comment_at: null,
        comment_count: null,
      });
      expect(row?.deleted_at).toBeInstanceOf(Date);
      expect(await listedIds()).toEqual([]);

      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.contact.delete',
      });
      expect(audit).toEqual([
        {
          severity: 'WARNING',
          resource_type: 'contact',
          metadata: { contact_public_id: contact.public_id },
        },
      ]);
      expect(JSON.stringify(audit)).not.toContain('jordan');
    });

    it('lets an Admin erase too', async () => {
      const contact = await contactOfTeam();
      expect(
        (await erase({ contactPublicId: contact.public_id, token: team.adminToken })).statusCode,
      ).toBe(204);
    });

    it('refuses an Editor with 403 missing_permission and erases nothing (AC-4.12, D23)', async () => {
      const contact = await contactOfTeam({ username: 'still.here' });

      const response = await erase({ contactPublicId: contact.public_id, token: team.editorToken });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).reason).toBe('missing_permission');
      expect((await readContactRow(contact.id))?.username).toBe('still.here');
    });

    it("answers 404 contact_not_found on a repeat, an unknown id and another organization's contact (AC-4.11)", async () => {
      const contact = await contactOfTeam();
      expect((await erase({ contactPublicId: contact.public_id })).statusCode).toBe(204);

      const repeat = await erase({ contactPublicId: contact.public_id });
      expect(repeat.statusCode).toBe(404);
      expect(errorOf(repeat).reason).toBe('contact_not_found');

      const unknown = await erase({ contactPublicId: generatePublicId('contact') });
      expect(unknown.statusCode).toBe(404);
      expect(errorOf(unknown).reason).toBe('contact_not_found');

      const otherTeam = await createInstagramTeam();
      const otherAccount = await insertInstagramAccount({
        organizationId: otherTeam.organization.id,
      });
      const foreign = await insertContact({
        organizationId: otherTeam.organization.id,
        instagramAccountId: otherAccount.id,
        username: 'foreign.contact',
      });
      const crossOrganization = await erase({ contactPublicId: foreign.public_id });
      expect(crossOrganization.statusCode).toBe(404);
      expect(errorOf(crossOrganization).reason).toBe('contact_not_found');
      expect((await readContactRow(foreign.id))?.username).toBe('foreign.contact');
    });

    it('answers 400 contact_id on a malformed id', async () => {
      const response = await erase({ contactPublicId: 'not-a-public-id' });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).errors?.map((item) => item.field)).toContain('contact_id');
    });

    it('answers 422 on a personal organization (CT3)', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes({
        permissionCodes: [APP_PERMISSIONS.CONTACT_DELETE],
      });

      const response = await erase({
        contactPublicId: generatePublicId('contact'),
        token: personal.token,
      });

      expect(response.statusCode).toBe(422);
      expect(errorOf(response).code).toBe('unprocessable_entity');
    });
  });

  /** One owner change (route 20). */
  function update({
    contactPublicId,
    payload,
    token = team.ownerToken,
  }: {
    contactPublicId: string;
    payload: unknown;
    token?: string;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'PATCH',
      url: contactPath(contactPublicId),
      token,
      payload,
    });
  }

  /** Route 22 of the team's account unless another is named. */
  function tagList({
    accountPublicId = account.public_id,
    token = team.ownerToken,
  }: {
    accountPublicId?: string | null;
    token?: string;
  } = {}): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'GET',
      url:
        accountPublicId === null
          ? CONTACT_TAGS_PATH
          : `${CONTACT_TAGS_PATH}?channel_account_id=${accountPublicId}`,
      token,
    });
  }

  function dataOf(response: InjectHttpResult): Record<string, unknown> {
    return (response.json() as { data: Record<string, unknown> }).data;
  }

  describe('GET /app/contacts/{contact_id} (route 19)', () => {
    it('opens one contact with her note, pause, first automation and open runs (AC-5.3)', async () => {
      const automation = await insertAutomation({
        organizationId: team.organization.id,
        instagramAccountId: account.id,
      });
      const contact = await contactOfTeam({
        username: 'jordan.lee',
        email: 'jordan+shop@example.com',
        email_collected_at: day(1),
        phone: '+15550100123',
        phone_collected_at: day(1),
        tags: ['vip'],
        note: 'Asked about sizes',
        automations_off_at: day(1),
        automations_off_by_user_id: team.owner.id,
        first_automation_id: automation.id,
        came_in_via: 'comment',
        last_opening_message_at: day(1),
      });
      await insertAutomationRun({
        organizationId: team.organization.id,
        automationId: automation.id,
        contactId: contact.id,
      });

      for (const token of [team.ownerToken, team.viewerToken]) {
        const response = await injectAuthenticated(app, {
          method: 'GET',
          url: contactPath(contact.public_id),
          token,
        });
        expect(response.statusCode).toBe(200);
        expect(dataOf(response)).toMatchObject({
          id: contact.public_id,
          email: 'jordan+shop@example.com',
          phone: '+15550100123',
          tags: ['vip'],
          note: 'Asked about sizes',
          is_opted_out: false,
          is_automations_paused: true,
          automations_paused_by_user_id: team.owner.public_id,
          first_automation: { id: automation.public_id, name: automation.name },
          came_in_via: 'comment',
          open_run_count: 1,
        });
      }
    });

    it("answers 404 contact_not_found for another organization's or an erased contact", async () => {
      const otherTeam = await createInstagramTeam();
      const otherAccount = await insertInstagramAccount({
        organizationId: otherTeam.organization.id,
      });
      const foreign = await insertContact({
        organizationId: otherTeam.organization.id,
        instagramAccountId: otherAccount.id,
      });
      const erased = await contactOfTeam();
      await erase({ contactPublicId: erased.public_id });

      for (const contactPublicId of [foreign.public_id, erased.public_id]) {
        const response = await injectAuthenticated(app, {
          method: 'GET',
          url: contactPath(contactPublicId),
          token: team.ownerToken,
        });
        expect(response.statusCode).toBe(404);
        expect(errorOf(response).reason).toBe('contact_not_found');
      }
    });
  });

  describe('PATCH /app/contacts/{contact_id} (route 20)', () => {
    it('sets and clears the note, sends nothing, and audits field names only (AC-5.4, AC-5.14)', async () => {
      const contact = await contactOfTeam();

      const saved = await update({
        contactPublicId: contact.public_id,
        payload: { note: 'Prefers size M' },
      });
      expect(saved.statusCode).toBe(200);
      expect(dataOf(saved).note).toBe('Prefers size M');

      const cleared = await update({ contactPublicId: contact.public_id, payload: { note: null } });
      expect(dataOf(cleared).note).toBeNull();

      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.contact.update',
      });
      expect(audit).toHaveLength(2);
      expect(audit[0]).toMatchObject({
        severity: 'INFO',
        resource_type: 'contact',
        metadata: { contact_public_id: contact.public_id, changed_fields: ['note'] },
      });
      expect(JSON.stringify(audit)).not.toContain('size M');
    });

    it('refuses a note over 2,000 characters, an empty body and a tag in both lists with 400', async () => {
      const contact = await contactOfTeam();
      for (const payload of [
        { note: 'x'.repeat(2001) },
        {},
        { add_tags: ['vip'], remove_tags: ['vip'] },
        { opted_out: false },
      ]) {
        const response = await update({ contactPublicId: contact.public_id, payload });
        expect(response.statusCode).toBe(400);
      }
    });

    it('adds and removes tags, and the tag list counts them at once (CT5, S7)', async () => {
      const jordan = await contactOfTeam({ tags: ['lead'] });
      const avery = await contactOfTeam();

      await update({
        contactPublicId: jordan.public_id,
        payload: { add_tags: ['vip', 'spring,sale'], remove_tags: ['lead'] },
      });
      const second = await update({
        contactPublicId: avery.public_id,
        payload: { add_tags: ['vip'] },
      });

      expect(dataOf(second).tags).toEqual(['vip']);
      expect((await readContactRow(jordan.id))?.tags).toEqual(['vip', 'spring sale']);
      const tags = await tagList();
      expect(tags.statusCode).toBe(200);
      expect(dataOf(tags)).toEqual([
        { tag: 'vip', contact_count: 2 },
        { tag: 'spring sale', contact_count: 1 },
      ]);
    });

    it('writes one tag event per change in the commit, and the erase deletes them (AC-5.5, CT16, CT11)', async () => {
      const contact = await contactOfTeam({ tags: ['lead'] });
      const tagEvents = () =>
        getOperatorDatabase()
          .select({
            tag: contact_tag_events.tag,
            kind: contact_tag_events.kind,
            source: contact_tag_events.source,
            chain_number: contact_tag_events.chain_number,
          })
          .from(contact_tag_events)
          .where(eq(contact_tag_events.contact_id, contact.id))
          .orderBy(asc(contact_tag_events.id));

      const response = await update({
        contactPublicId: contact.public_id,
        payload: { add_tags: ['vip'], remove_tags: ['lead'] },
      });
      const refused = await update({
        contactPublicId: contact.public_id,
        payload: {
          add_tags: ['late'],
          expected_updated_at: '2000-01-01T00:00:00.000Z',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(refused.statusCode).toBe(409);
      // Exactly one event per change; the refused change rolled back and wrote none.
      expect(await tagEvents()).toEqual([
        { tag: 'vip', kind: 'added', source: 'owner', chain_number: 0 },
        { tag: 'lead', kind: 'removed', source: 'owner', chain_number: 0 },
      ]);
      expect((await erase({ contactPublicId: contact.public_id })).statusCode).toBe(204);
      expect(await tagEvents()).toEqual([]);
    });

    it('refuses a 51st tag with 422 contact_tag_limit', async () => {
      const contact = await contactOfTeam({
        tags: Array.from({ length: 50 }, (_, index) => `tag${index}`),
      });

      const response = await update({
        contactPublicId: contact.public_id,
        payload: { add_tags: ['one-more'] },
      });

      expect(response.statusCode).toBe(422);
      expect(errorOf(response).reason).toBe('contact_tag_limit');
    });

    it('answers 409 record_changed for an older expected_updated_at', async () => {
      const contact = await contactOfTeam();

      const response = await update({
        contactPublicId: contact.public_id,
        payload: {
          note: 'late',
          expected_updated_at: new Date(contact.updated_at.getTime() - 60_000).toISOString(),
        },
      });

      expect(response.statusCode).toBe(409);
      expect(errorOf(response).reason).toBe('record_changed');
    });

    it('a pause cancels her open runs (contact_excluded); switching it off restarts nothing (AC-5.8, AC-5.9)', async () => {
      const automation = await insertAutomation({
        organizationId: team.organization.id,
        instagramAccountId: account.id,
      });
      const contact = await contactOfTeam();
      const run = await insertAutomationRun({
        organizationId: team.organization.id,
        automationId: automation.id,
        contactId: contact.id,
      });

      const paused = await update({
        contactPublicId: contact.public_id,
        payload: { is_automations_paused: true },
        token: team.editorToken,
      });

      expect(paused.statusCode).toBe(200);
      expect(dataOf(paused)).toMatchObject({
        is_automations_paused: true,
        automations_paused_by_user_id: team.editor.public_id,
        open_run_count: 0,
      });
      expect(await readRunRow(run.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'contact_excluded',
      });
      const pauseAudit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.contact.automations_pause',
      });
      expect(pauseAudit).toEqual([
        {
          severity: 'WARNING',
          resource_type: 'contact',
          metadata: { contact_public_id: contact.public_id },
        },
      ]);

      const resumed = await update({
        contactPublicId: contact.public_id,
        payload: { is_automations_paused: false },
      });
      expect(dataOf(resumed)).toMatchObject({
        is_automations_paused: false,
        automations_paused_by_user_id: null,
      });
      expect((await readRunRow(run.id))?.status).toBe('cancelled');
      expect(
        await readStagedAuditRows({
          organizationPublicId: team.organization.public_id,
          action: 'app.contact.automations_resume',
        }),
      ).toHaveLength(1);
    });

    it("answers 404 contact_not_found for another organization's contact and changes nothing (K1)", async () => {
      const otherTeam = await createInstagramTeam();
      const otherAccount = await insertInstagramAccount({
        organizationId: otherTeam.organization.id,
      });
      const foreign = await insertContact({
        organizationId: otherTeam.organization.id,
        instagramAccountId: otherAccount.id,
      });

      const response = await update({ contactPublicId: foreign.public_id, payload: { note: 'x' } });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('contact_not_found');
      expect((await readContactRow(foreign.id))?.note).toBeNull();
    });

    it('refuses a Viewer with 403 missing_permission (AC-5.11)', async () => {
      const contact = await contactOfTeam();

      const response = await update({
        contactPublicId: contact.public_id,
        payload: { note: 'hi' },
        token: team.viewerToken,
      });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).reason).toBe('missing_permission');
    });

    it('answers 422 on a personal organization', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes({
        permissionCodes: [APP_PERMISSIONS.CONTACT_UPDATE],
      });

      const response = await update({
        contactPublicId: generatePublicId('contact'),
        payload: { note: 'hi' },
        token: personal.token,
      });

      expect(response.statusCode).toBe(422);
    });
  });

  describe('POST /app/contacts/bulk-actions (route 21)', () => {
    function bulk({
      payload,
      token = team.ownerToken,
      idempotencyKey = `bulk-${randomUUID()}`,
    }: {
      payload: Record<string, unknown>;
      token?: string;
      idempotencyKey?: string | null;
    }): Promise<InjectHttpResult> {
      return injectAuthenticated(app, {
        method: 'POST',
        url: CONTACT_BULK_ACTIONS_PATH,
        token,
        payload: { channel_account_id: account.public_id, ...payload },
        headers: idempotencyKey === null ? {} : { 'x-idempotency-key': idempotencyKey },
      });
    }

    const ids = (count: number) =>
      Array.from({ length: count }, (_, index) => `con_${String(index).padStart(21, '0')}`);

    it('refuses more than 500 ids, neither selection, or both, with 400 (AC-5.6)', async () => {
      for (const payload of [
        { action: 'add_tag', tag: 'vip', contact_ids: ids(501) },
        { action: 'add_tag', tag: 'vip' },
        { action: 'add_tag', tag: 'vip', contact_ids: ids(1), filter: {} },
        { action: 'pause_automations', tag: 'vip', contact_ids: ids(1) },
      ]) {
        expect((await bulk({ payload })).statusCode).toBe(400);
      }
    });

    it('needs X-Idempotency-Key (it starts background work)', async () => {
      const response = await bulk({
        payload: { action: 'add_tag', tag: 'vip', contact_ids: ids(1) },
        idempotencyKey: null,
      });
      expect(response.statusCode).toBe(422);
    });

    it("answers 404 channel_account_not_found for another organization's account", async () => {
      const otherTeam = await createInstagramTeam();
      const otherAccount = await insertInstagramAccount({
        organizationId: otherTeam.organization.id,
      });

      const response = await bulk({
        payload: {
          channel_account_id: otherAccount.public_id,
          action: 'add_tag',
          tag: 'vip',
          contact_ids: ids(1),
        },
      });

      expect(response.statusCode, response.body).toBe(404);
      expect(errorOf(response).reason).toBe('channel_account_not_found');
    });

    it('counts a good selection, answers at once and queues the bulk job, which changes the contacts (AC-5.6, R46)', async () => {
      const tasks = new Queue(INSTAGRAM_DATABASE_TASKS_QUEUE_NAME, {
        connection: getBullMQConnectionOptions(),
        prefix: getBullMQKeyPrefix(),
      });
      try {
        await tasks.obliterate({ force: true });
        const vip = await contactOfTeam({ tags: ['vip'] });
        const other = await contactOfTeam({ tags: ['other'] });

        const response = await bulk({
          payload: { action: 'pause_automations', filter: { tags: 'vip' } },
        });

        expect(response.statusCode).toBe(200);
        expect(dataOf(response)).toEqual({
          action: 'pause_automations',
          matched_count: 1,
          is_queued: true,
        });
        // Nothing changed yet: the job does it (WC-36).
        expect((await readContactRow(vip.id))?.automations_off_at).toBeNull();
        const [job] = await tasks.getJobs(['waiting', 'prioritized']);
        expect(job?.name).toBe(CONTACT_BULK_ACTION_JOB_NAME);
        expect(job?.data).toMatchObject({
          organizationPublicId: team.organization.public_id,
          taskInput: {
            pieceNumber: 1,
            channelAccountPublicId: account.public_id,
            action: 'pause_automations',
            contactPublicIds: null,
            filter: { tags: ['vip'] },
            afterContactPublicId: null,
          },
        });

        // The worker's handler, as the database-heavy task worker runs it.
        const handler = app.appDomain.instagramSendWork.taskHandlers[CONTACT_BULK_ACTION_JOB_NAME];
        const context: InstagramSendTicketContext = {
          jobId: String(job?.id),
          runInDatabaseSlot: (callback) => callback(),
          returnTicket: async () => {
            throw new Error('not returned');
          },
        };
        await handler?.run({
          organizationPublicId: team.organization.public_id,
          taskInput: handler.inputSchema.parse(job?.data.taskInput),
          context,
        });
        expect((await readContactRow(vip.id))?.automations_off_at).toBeInstanceOf(Date);
        expect((await readContactRow(other.id))?.automations_off_at).toBeNull();
      } finally {
        await tasks.obliterate({ force: true });
        await tasks.close();
      }
    });

    it('refuses a Viewer with 403 missing_permission (AC-5.11)', async () => {
      const response = await bulk({
        payload: { action: 'add_tag', tag: 'vip', contact_ids: ids(1) },
        token: team.viewerToken,
      });
      expect(response.statusCode).toBe(403);
      expect(errorOf(response).reason).toBe('missing_permission');
    });
  });

  describe('GET /app/contact-tags (route 22)', () => {
    it("refuses a list without the account with 400, and another organization's with 404 (AC-5.7)", async () => {
      const missing = await tagList({ accountPublicId: null });
      expect(missing.statusCode).toBe(400);

      const otherTeam = await createInstagramTeam();
      const otherAccount = await insertInstagramAccount({
        organizationId: otherTeam.organization.id,
      });
      const foreign = await tagList({ accountPublicId: otherAccount.public_id });
      expect(foreign.statusCode).toBe(404);
      expect(errorOf(foreign).reason).toBe('channel_account_not_found');
    });

    it("drops an erased contact's tags from the counts", async () => {
      const contact = await contactOfTeam();
      await update({ contactPublicId: contact.public_id, payload: { add_tags: ['vip'] } });
      expect(dataOf(await tagList({ token: team.viewerToken }))).toEqual([
        { tag: 'vip', contact_count: 1 },
      ]);

      await erase({ contactPublicId: contact.public_id });

      expect(dataOf(await tagList())).toEqual([]);
    });
  });

  describe('a read-only plan (D27, AC-4.16)', () => {
    const enforced = env.LAPSED_PLAN_READ_ONLY_ENABLED;

    afterEach(() => {
      env.LAPSED_PLAN_READ_ONLY_ENABLED = enforced;
    });

    it('leaves the contact delete open — a team can still honour an erase request', async () => {
      const contact = await contactOfTeam({
        username: 'jordan.lee',
        email: 'jordan.lee@example.com',
        email_collected_at: day(1),
      });
      const automation = await insertAutomation({
        organizationId: team.organization.id,
        instagramAccountId: account.id,
      });
      await endPaidPlanWithoutPaying(team.organization.id);
      env.LAPSED_PLAN_READ_ONLY_ENABLED = true;

      const response = await erase({ contactPublicId: contact.public_id });

      expect(response.statusCode).toBe(204);
      const row = await readContactRow(contact.id);
      expect(row).toMatchObject({ username: null, email: null, instagram_user_id: null });
      expect(row?.deleted_at).toBeInstanceOf(Date);
      expect(await listedIds()).toEqual([]);

      // The plan is read-only all along: an automation's go-live is refused (only go-live, P10).
      const refused = await injectAuthenticated(app, {
        method: 'POST',
        url: automationActionPath({ automationPublicId: automation.public_id, action: 'go-live' }),
        token: team.ownerToken,
      });
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused).reason).toBe('organization_read_only');
    });
  });

  describe('audit entries and log lines of routes 20–23 (AC-5.14, CT4, CT10)', () => {
    /** Her personal values — none may reach an audit entry or a log line. */
    const jordanEmail = 'jordan.private+orders@example.com';
    const jordanPhone = '+15550109876';

    it('a tag change leaves one app.contact.update entry with the field name only; a pause and a resume one each', async () => {
      const contact = await contactOfTeam({
        email: jordanEmail,
        email_collected_at: day(1),
        phone: jordanPhone,
        phone_collected_at: day(1),
      });

      for (const payload of [
        { add_tags: ['vip'] },
        { is_automations_paused: true },
        { is_automations_paused: false },
      ]) {
        const response = await update({ contactPublicId: contact.public_id, payload });
        expect(response.statusCode, response.body).toBe(200);
      }

      const organizationPublicId = team.organization.public_id;
      const updates = await readStagedAuditRows({
        organizationPublicId,
        action: 'app.contact.update',
      });
      expect(updates).toEqual([
        {
          severity: 'INFO',
          resource_type: 'contact',
          metadata: { contact_public_id: contact.public_id, changed_fields: ['tags'] },
        },
      ]);
      const pauses = await readStagedAuditRows({
        organizationPublicId,
        action: 'app.contact.automations_pause',
      });
      const resumes = await readStagedAuditRows({
        organizationPublicId,
        action: 'app.contact.automations_resume',
      });
      for (const entries of [pauses, resumes]) {
        expect(entries).toEqual([
          {
            severity: 'WARNING',
            resource_type: 'contact',
            metadata: { contact_public_id: contact.public_id },
          },
        ]);
      }
      const written = JSON.stringify([updates, pauses, resumes]);
      for (const value of [jordanEmail, jordanPhone, 'vip']) {
        expect(written).not.toContain(value);
      }
    });

    it('no log line of routes 20–23 holds her email or phone — a success, a refusal, the bulk action and the erase', async () => {
      const contact = await contactOfTeam({
        username: 'jordan.lee',
        email: jordanEmail,
        email_collected_at: day(1),
        phone: jordanPhone,
        phone_collected_at: day(1),
      });

      const captured = captureLogLines(app);
      const statuses: number[] = [];
      try {
        // Route 20: a note quoting her email and phone, a refused body quoting them, a pause.
        for (const payload of [
          { note: `Reach her at ${jordanEmail} or ${jordanPhone}`, add_tags: ['vip'] },
          { note: jordanEmail, opted_out: false },
          { is_automations_paused: true },
        ]) {
          statuses.push((await update({ contactPublicId: contact.public_id, payload })).statusCode);
        }
        // Route 21: a search filter holding her email (queued for the bulk job, R46).
        const bulk = await injectAuthenticated(app, {
          method: 'POST',
          url: CONTACT_BULK_ACTIONS_PATH,
          token: team.ownerToken,
          payload: {
            channel_account_id: account.public_id,
            action: 'add_tag',
            tag: 'vip',
            filter: { q: jordanEmail },
          },
          headers: { 'x-idempotency-key': `bulk-${randomUUID()}` },
        });
        statuses.push(bulk.statusCode);
        // Route 22, then route 23.
        statuses.push((await tagList()).statusCode);
        statuses.push((await erase({ contactPublicId: contact.public_id })).statusCode);
      } finally {
        captured.restore();
      }

      expect(statuses).toEqual([200, 400, 200, 200, 200, 204]);
      const written = captured.lines.join('\n');
      // The capture saw every request: one `request.complete` line each, by route pattern.
      const completed = captured.lines
        .map((line) => JSON.parse(line) as { msg?: string; route?: string; statusCode?: number })
        .filter((line) => line.msg === 'request.complete')
        .map((line) => `${line.statusCode} ${line.route?.replace(/^.*\/app\//, '')}`);
      expect(completed).toEqual([
        '200 contacts/:contact_id',
        '400 contacts/:contact_id',
        '200 contacts/:contact_id',
        '200 contacts/bulk-actions',
        '200 contact-tags',
        '204 contacts/:contact_id',
      ]);
      for (const value of [
        jordanEmail,
        encodeURIComponent(jordanEmail),
        jordanPhone,
        jordanPhone.slice(1),
      ]) {
        expect(written).not.toContain(value);
      }
    });
  });
});
