import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { env } from '@/shared/config/env.config.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  injectAuthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  createInstagramTeam,
  createPersonalOrganizationWithInstagramCodes,
  endTrialWithoutPaying,
  readStagedAuditRows,
  type InstagramTeamFixture,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  CONTACTS_PATH,
  contactPath,
  type ContactFixtureRow,
  insertContact,
  insertInstagramAccount,
  readContactRow,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  automationPath,
  insertAutomation,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';

/**
 * Routes 9 and 10 of the contacts (routes-final § 2, ROUTE R8) over HTTP: every filter, every sort
 * in both directions across pages, the search, paging and the estimated total; the erase clearing
 * every personal column, its audit entry and a repeat; team-only (CT3), the Editor role (D23), the
 * erase open on a read-only plan (D27) and another organization's contacts (K1). The database,
 * auth, permissions and audit are real.
 */
describe('Contact routes (list, erase)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  let account: { id: number; public_id: string };

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

  function list({
    token = team.ownerToken,
    query = '',
  }: {
    token?: string;
    query?: string;
  } = {}): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'GET',
      url: query === '' ? CONTACTS_PATH : `${CONTACTS_PATH}?${query}`,
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
  async function listedIds(query = '', token = team.ownerToken): Promise<string[]> {
    const response = await list({
      token,
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

  describe('GET /app/contacts (route 9)', () => {
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
        instagram_account_id: account.public_id,
        instagram_user_id: older.instagram_user_id,
        username: 'jordan.lee',
        full_name: 'Jordan Lee',
        email: 'jordan.lee@example.com',
        phone: '+15550100123',
        is_following_account: true,
        tags: ['vip'],
        first_seen_at: older.first_seen_at.toISOString(),
        last_message_received_at: older.last_message_received_at.toISOString(),
      });
      expect(body.data[1]).not.toHaveProperty('deleted_at');
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
      expect(await listedIds('', otherTeam.ownerToken)).toEqual([foreign.public_id]);
    });

    it('answers 404 team_organization_required on a personal organization (CT3)', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes({
        permissionCodes: [APP_PERMISSIONS.CONTACT_READ],
      });

      const response = await list({ token: personal.token });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('team_organization_required');
    });

    describe('filters (CT4, CT13)', () => {
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

      it('instagram_account_id: one account each — the same person is a contact per account (AC-4.7)', async () => {
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

        expect((await listedIds()).sort()).toEqual([first.public_id, second.public_id].sort());
        expect(await listedIds(`instagram_account_id=${account.public_id}`)).toEqual([
          first.public_id,
        ]);
        expect(await listedIds(`instagram_account_id=${secondAccount.public_id}`)).toEqual([
          second.public_id,
        ]);
        const listed = bodyOf(
          await list({ query: `instagram_account_id=${secondAccount.public_id}` }),
        );
        expect(listed.data[0]?.instagram_account_id).toBe(secondAccount.public_id);
      });

      it("gives an empty page for an unknown or another organization's account", async () => {
        await contactOfTeam();
        const otherTeam = await createInstagramTeam();
        const otherAccount = await insertInstagramAccount({
          organizationId: otherTeam.organization.id,
        });

        expect(
          await listedIds(`instagram_account_id=${generatePublicId('instagramAccount')}`),
        ).toEqual([]);
        expect(await listedIds(`instagram_account_id=${otherAccount.public_id}`)).toEqual([]);
      });
    });

    describe('search q (CT4)', () => {
      it('finds every word anywhere in username, full name or email, in any case (AC-4.2)', async () => {
        const jordan = await contactOfTeam({
          username: 'jordan.lee',
          full_name: 'Jordan Lee',
          email: 'jl.orders@example.com',
          email_collected_at: day(1),
        });
        const sam = await contactOfTeam({ username: 'sam_rivera', full_name: 'Sam Rivera' });

        expect(await listedIds('q=JORDAN')).toEqual([jordan.public_id]);
        expect(await listedIds('q=lee%20jordan')).toEqual([jordan.public_id]);
        expect(await listedIds('q=orders@example')).toEqual([jordan.public_id]);
        expect(await listedIds('q=rivera')).toEqual([sam.public_id]);
        expect(await listedIds('q=jordan%20rivera')).toEqual([]);
        expect(await listedIds('q=50%25_off')).toEqual([]);
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
        ['instagram_account_id=con_k7x9m2pqr4w8n1v3a1b2c', 'instagram_account_id'],
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
      it.each([['search=jordan', 'search']])(
        'refuses the unknown parameter %s',
        async (query, field) => {
          const response = await list({ query });
          expect(response.statusCode).toBe(400);
          expect(errorOf(response).errors?.map((item) => item.field)).toContain(
            `querystring.${field}`,
          );
        },
      );
    });
  });

  describe('DELETE /app/contacts/{contact_id} (route 10)', () => {
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
        last_direct_message_received_at: day(1),
        last_message_sent_at: day(1),
      });

      const response = await erase({ contactPublicId: contact.public_id });

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      const row = await readContactRow(contact.id);
      expect(row).toMatchObject({
        public_id: contact.public_id,
        instagram_account_id: account.id,
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

  describe('a read-only plan (D27, AC-4.16)', () => {
    const enforced = env.BILLING_READ_ONLY_ENFORCED;

    afterEach(() => {
      env.BILLING_READ_ONLY_ENFORCED = enforced;
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
      await endTrialWithoutPaying(team.organization.id);
      env.BILLING_READ_ONLY_ENFORCED = true;

      const response = await erase({ contactPublicId: contact.public_id });

      expect(response.statusCode).toBe(204);
      const row = await readContactRow(contact.id);
      expect(row).toMatchObject({ username: null, email: null, instagram_user_id: null });
      expect(row?.deleted_at).toBeInstanceOf(Date);
      expect(await listedIds()).toEqual([]);

      // The plan is read-only all along: an automation edit is refused.
      const refused = await injectAuthenticated(app, {
        method: 'PATCH',
        url: automationPath(automation.public_id),
        token: team.ownerToken,
        payload: { name: 'Blocked' },
      });
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused).reason).toBe('organization_read_only');
    });
  });
});
