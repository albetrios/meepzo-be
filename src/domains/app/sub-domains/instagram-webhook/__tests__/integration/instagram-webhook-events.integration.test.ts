import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { NOTIFY_PERMISSIONS } from '@/domains/notify/notify.permissions.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedAllPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import { insertChannelAccount } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import {
  createInstagramTeam,
  type InstagramTeamFixture,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  INSTAGRAM_WEBHOOK_EVENTS_PATH,
  TEST_CONTACT_INSTAGRAM_USER_ID,
  type TestInstagramAccount,
  createPersonalOrganizationWithWebhookEventRead,
  insertTestInstagramAccount,
  insertTestInstagramWebhookEvent,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/__tests__/factories/instagram-webhook-event.factory.js';

/**
 * Route 62 (launch route 18), `GET /app/social/instagram/webhook-events` (launch § 4.B, ROUTE R12;
 * feat-instagram-dm-sending § 5.B, ROUTE R16 — WH23, AC-16.24) over HTTP: newest first, every filter
 * (the channel account too), keyset pages with the cursor bound to the filters, the masked payload
 * (WH17), the gate (`instagram-webhook-event:read` — Owner and Admin, never Editor, and never the
 * outgoing webhooks' `webhook:read`, D4), team-only (`404 team_organization_required`, K1) and
 * another organization's events never listed. The database, auth and permissions are real.
 */

interface EventListBody {
  data: Array<Record<string, unknown> & { id: string; payload: Record<string, unknown> }>;
  meta: {
    request_id: string;
    pagination: {
      per_page: number;
      next: string | null;
      has_more: boolean;
      estimated_total?: number;
    };
  };
}

function bodyOf(response: InjectHttpResult): EventListBody {
  return response.json() as EventListBody;
}

function errorOf(response: InjectHttpResult): {
  reason?: string;
  errors?: Array<{ field: string }>;
} {
  return (response.json() as { error: Record<string, never> }).error;
}

/** A time `hoursAgo` hours before a fixed reference instant (whole seconds — no rounding). */
const REFERENCE = new Date('2026-11-21T12:00:00.000Z');
function hoursBefore(hoursAgo: number): Date {
  return new Date(REFERENCE.getTime() - hoursAgo * 60 * 60 * 1000);
}

describe('GET /app/social/instagram/webhook-events (route 62)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  let account: TestInstagramAccount;

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
    account = await insertTestInstagramAccount(team.organization.id);
  });

  function list(query = '', token = team.ownerToken): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      url: `${INSTAGRAM_WEBHOOK_EVENTS_PATH}${query}`,
      token,
    });
  }

  /** Five events an hour apart: received, queued, processed, skipped, failed (newest first). */
  async function seedFiveEvents() {
    const statuses = ['failed', 'skipped', 'processed', 'queued', 'received'] as const;
    const events: Array<{ id: number; publicId: string; status: string }> = [];
    for (const [index, status] of statuses.entries()) {
      const event = await insertTestInstagramWebhookEvent({
        organizationId: team.organization.id,
        account,
        status,
        eventKind: status === 'skipped' ? 'echo' : 'comment',
        receivedAt: hoursBefore(5 - index),
      });
      events.push({ ...event, status });
    }
    // Newest first: received (1 h ago) … failed (5 h ago).
    return events.reverse();
  }

  describe('the list', () => {
    it("lists the organization's events newest first, with exactly the 5.B.6 fields", async () => {
      const events = await seedFiveEvents();

      const response = await list();

      expect(response.statusCode).toBe(200);
      const body = bodyOf(response);
      expect(body.data.map((event) => event.id)).toEqual(events.map((event) => event.publicId));
      expect(Object.keys(body.data[0]!).sort()).toEqual(
        [
          'id',
          'channel_account_id',
          'instagram_user_id',
          'contact_instagram_user_id',
          'event_kind',
          'event_key',
          'status',
          'skip_reason',
          'error_message',
          'attempt_count',
          'next_attempt_at',
          'payload',
          'occurred_at',
          'received_at',
          'processed_at',
        ].sort(),
      );
      expect(body.data[0]).toMatchObject({
        channel_account_id: account.channelAccountPublicId,
        instagram_user_id: account.instagramUserId,
        contact_instagram_user_id: TEST_CONTACT_INSTAGRAM_USER_ID,
        status: 'received',
        processed_at: null,
        received_at: hoursBefore(1).toISOString(),
      });
      expect(body.data.at(-1)).toMatchObject({
        status: 'failed',
        error_message: 'instagram_api:2/0',
        next_attempt_at: null,
      });
      // A done event's body is cleared (WH22); a waiting or failed one keeps it, masked.
      expect(body.data.find((event) => event.status === 'processed')?.payload).toBeNull();
      expect(body.data.find((event) => event.status === 'failed')?.payload).not.toBeNull();
      expect(body.meta.pagination).toEqual({ per_page: 25, next: null, has_more: false });
    });

    it('lets an Admin read it (D4)', async () => {
      await seedFiveEvents();

      const response = await list('', team.adminToken);

      expect(response.statusCode).toBe(200);
      expect(bodyOf(response).data).toHaveLength(5);
    });

    it('masks the payload — text cut to 40 characters, email and phone masked, links replaced (WH17)', async () => {
      await insertTestInstagramWebhookEvent({
        organizationId: team.organization.id,
        account,
        eventKind: 'message',
        eventKey: 'message:mid-masking',
        payload: {
          sender: { id: TEST_CONTACT_INSTAGRAM_USER_ID },
          recipient: { id: account.instagramUserId },
          timestamp: 1_732_186_000_000,
          message: {
            mid: 'mid-masking',
            text: 'jane.doe@example.com +91 98765 43234 and some more words after',
            attachments: [{ type: 'image', payload: { url: 'https://cdn.example.com/a.jpg' } }],
          },
        },
      });

      const response = await list();

      expect(response.statusCode).toBe(200);
      const [event] = bodyOf(response).data;
      expect(event?.payload).toEqual({
        sender: { id: TEST_CONTACT_INSTAGRAM_USER_ID },
        recipient: { id: account.instagramUserId },
        timestamp: 1_732_186_000_000,
        message: {
          mid: 'mid-masking',
          text: 'j***@e***.com +91********34 and some mor',
          attachments: [{ type: 'image', payload: { url: '[link]' } }],
        },
      });
      expect(response.body).not.toContain('jane.doe@example.com');
      expect(response.body).not.toContain('98765');
      expect(response.body).not.toContain('cdn.example.com');
    });

    it("never lists another organization's events", async () => {
      await seedFiveEvents();
      const otherTeam = await createInstagramTeam();
      const otherAccount = await insertTestInstagramAccount(otherTeam.organization.id);
      const otherEvent = await insertTestInstagramWebhookEvent({
        organizationId: otherTeam.organization.id,
        account: otherAccount,
      });

      const mine = bodyOf(await list());
      const theirs = bodyOf(await list('', otherTeam.ownerToken));

      expect(mine.data.map((event) => event.id)).not.toContain(otherEvent.publicId);
      expect(mine.data).toHaveLength(5);
      expect(theirs.data.map((event) => event.id)).toEqual([otherEvent.publicId]);
    });

    it('answers an empty page when nothing was received', async () => {
      const response = await list();

      expect(response.statusCode).toBe(200);
      expect(bodyOf(response).data).toEqual([]);
    });
  });

  describe('filters', () => {
    it('filters by one status', async () => {
      const events = await seedFiveEvents();

      const response = await list('?status=skipped');

      expect(response.statusCode).toBe(200);
      expect(bodyOf(response).data.map((event) => event.id)).toEqual([
        events.find((event) => event.status === 'skipped')?.publicId,
      ]);
      expect(bodyOf(response).data[0]).toMatchObject({ skip_reason: 'own_comment' });
    });

    it('filters by one event kind', async () => {
      await seedFiveEvents();

      const response = await list('?event_kind=echo');

      expect(response.statusCode).toBe(200);
      expect(bodyOf(response).data.map((event) => event.event_kind)).toEqual(['echo']);
    });

    it("filters by one channel account (WH23); another organization's account finds nothing", async () => {
      await seedFiveEvents();
      const secondAccount = await insertChannelAccount({
        organizationId: team.organization.id,
        providerAccountId: '17841499999999991',
        displayName: '@second_shop',
      });
      const secondEvent = await insertTestInstagramWebhookEvent({
        organizationId: team.organization.id,
        account: {
          id: 0,
          instagramUserId: '17841499999999991',
          channelAccountId: secondAccount.id,
        },
        receivedAt: hoursBefore(0.5),
      });
      const otherTeam = await createInstagramTeam();
      const otherAccount = await insertTestInstagramAccount(otherTeam.organization.id);

      const second = await list(`?channel_account_id=${secondAccount.public_id}`);
      const first = await list(`?channel_account_id=${account.channelAccountPublicId}`);
      const foreign = await list(`?channel_account_id=${otherAccount.channelAccountPublicId}`);

      expect(second.statusCode).toBe(200);
      expect(bodyOf(second).data.map((event) => event.id)).toEqual([secondEvent.publicId]);
      expect(bodyOf(second).data[0]).toMatchObject({ channel_account_id: secondAccount.public_id });
      expect(bodyOf(first).data).toHaveLength(5);
      expect(foreign.statusCode).toBe(200);
      expect(bodyOf(foreign).data).toEqual([]);
    });

    it('answers 400 on channel_account_id when it is not a cha_ id', async () => {
      const response = await list(
        `?channel_account_id=${account.channelAccountPublicId.replace('cha_', 'iga_')}`,
      );

      expect(response.statusCode).toBe(400);
      // The route's schema rejects the query, so the field carries its `querystring.` location.
      expect(errorOf(response).errors?.map((error) => error.field)).toEqual([
        'querystring.channel_account_id',
      ]);
    });

    it('shows the new kinds and reasons (AC-16.24): a Live comment, a flood skip', async () => {
      const live = await insertTestInstagramWebhookEvent({
        organizationId: team.organization.id,
        account,
        eventKind: 'live_comment',
        eventKey: 'live_comment:18000000000000042',
        status: 'processed',
      });
      await insertTestInstagramWebhookEvent({
        organizationId: team.organization.id,
        account,
        eventKind: 'message',
        eventKey: 'message:mid-flood',
        status: 'skipped',
        skipReason: 'flood',
      });

      const byKind = await list('?event_kind=live_comment');
      const all = bodyOf(await list());

      expect(byKind.statusCode).toBe(200);
      expect(bodyOf(byKind).data.map((event) => event.id)).toEqual([live.publicId]);
      expect(all.data.map((event) => event.skip_reason)).toContain('flood');
      expect((await list('?event_kind=read')).statusCode).toBe(400);
    });

    it('filters by received time — received_from inclusive, received_to exclusive', async () => {
      const events = await seedFiveEvents();
      // Received 4, 3 and 2 hours before the reference: from 4 h (kept) up to 1 h (excluded).
      const from = encodeURIComponent(hoursBefore(4).toISOString());
      const to = encodeURIComponent(hoursBefore(1).toISOString());

      const response = await list(`?received_from=${from}&received_to=${to}`);

      expect(response.statusCode).toBe(200);
      expect(bodyOf(response).data.map((event) => event.id)).toEqual(
        events.slice(1, 4).map((event) => event.publicId),
      );
    });

    it('accepts a time written with another offset', async () => {
      await seedFiveEvents();
      // 13:30+05:30 is 08:00Z — the event received 4 h before noon and later.
      const response = await list(
        `?received_from=${encodeURIComponent('2026-11-21T13:30:00+05:30')}`,
      );

      expect(response.statusCode).toBe(200);
      expect(bodyOf(response).data).toHaveLength(4);
    });

    it.each([
      ['status', '?status=done'],
      ['event_kind', '?event_kind=mention'],
      ['received_from', '?received_from=2026-11-21'],
      ['limit', '?limit=101'],
      ['include_total', '?include_total=yes'],
    ])('answers 400 on a bad %s', async (field, query) => {
      const response = await list(query);

      expect(response.statusCode).toBe(400);
      // The route's schema rejects the query, so the field carries its `querystring.` location.
      expect(errorOf(response).errors?.map((item) => item.field)).toContain(`querystring.${field}`);
    });

    it('answers 400 when received_from is not before received_to', async () => {
      const response = await list(
        `?received_from=${encodeURIComponent('2026-11-21T10:00:00Z')}&received_to=${encodeURIComponent('2026-11-21T10:00:00Z')}`,
      );

      expect(response.statusCode).toBe(400);
    });

    it('answers 400 on an unknown parameter', async () => {
      const response = await list('?organization_id=org_123');

      expect(response.statusCode).toBe(400);
    });
  });

  describe('pages', () => {
    it('walks the events newest first across pages, with no repeat and no gap', async () => {
      const events = await seedFiveEvents();

      const first = bodyOf(await list('?limit=2'));
      expect(first.meta.pagination).toMatchObject({ per_page: 2, has_more: true });
      const second = bodyOf(
        await list(`?limit=2&after=${encodeURIComponent(first.meta.pagination.next ?? '')}`),
      );
      const third = bodyOf(
        await list(`?limit=2&after=${encodeURIComponent(second.meta.pagination.next ?? '')}`),
      );

      expect([...first.data, ...second.data, ...third.data].map((event) => event.id)).toEqual(
        events.map((event) => event.publicId),
      );
      expect(third.meta.pagination).toMatchObject({ has_more: false, next: null });
    });

    it('continues a filtered list with the same filters', async () => {
      await seedFiveEvents();
      await insertTestInstagramWebhookEvent({
        organizationId: team.organization.id,
        account,
        eventKind: 'echo',
        status: 'skipped',
        receivedAt: hoursBefore(6),
      });

      const first = bodyOf(await list('?event_kind=echo&limit=1'));
      const second = await list(
        `?event_kind=echo&limit=1&after=${encodeURIComponent(first.meta.pagination.next ?? '')}`,
      );

      expect(second.statusCode).toBe(200);
      expect(bodyOf(second).data.map((event) => event.event_kind)).toEqual(['echo']);
    });

    it('answers 400 on after when a cursor is reused with other filters', async () => {
      await seedFiveEvents();
      const first = bodyOf(await list('?limit=2'));

      const response = await list(
        `?limit=2&status=failed&after=${encodeURIComponent(first.meta.pagination.next ?? '')}`,
      );

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).errors?.map((item) => item.field)).toEqual(['after']);
    });

    it('answers 400 on after for a cursor this server did not mint', async () => {
      const response = await list('?after=not-a-cursor');

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).errors?.map((item) => item.field)).toEqual(['after']);
    });

    it('lets a continuation change the page size', async () => {
      await seedFiveEvents();
      const first = bodyOf(await list('?limit=2'));

      const response = await list(
        `?limit=3&after=${encodeURIComponent(first.meta.pagination.next ?? '')}`,
      );

      expect(response.statusCode).toBe(200);
      expect(bodyOf(response).data).toHaveLength(3);
    });

    it('adds a capped count only when include_total=true', async () => {
      await seedFiveEvents();

      const counted = bodyOf(await list('?include_total=true&limit=2&status=received'));
      const plain = bodyOf(await list('?limit=2'));

      expect(counted.meta.pagination.estimated_total).toBe(1);
      expect(plain.meta.pagination).not.toHaveProperty('estimated_total');
    });
  });

  describe('who may read it', () => {
    /** The token of a member of the team whose custom role holds this one code and no other. */
    async function tokenOfRoleHolding(permissionCode: string): Promise<string> {
      const user = await createTestUser();
      const role = await createRoleWithPermissions({
        organizationId: team.organization.id,
        permissionCodes: [permissionCode],
      });
      await createMembership({
        userId: user.id,
        organizationId: team.organization.id,
        roleId: role.id,
      });
      return generateTestToken({
        userId: user.public_id,
        organizationPublicId: team.organization.public_id,
      });
    }

    it('refuses an Editor and a Viewer with 403 missing_permission (D4, AC-6.4, AC-16.24)', async () => {
      for (const token of [team.editorToken, team.viewerToken]) {
        const response = await list('', token);

        expect(response.statusCode).toBe(403);
        expect(errorOf(response).reason).toBe('missing_permission');
      }
    });

    it('webhook:read — the outgoing webhooks — does not open it; instagram-webhook-event:read alone does (D4, AC-1.8)', async () => {
      await seedFiveEvents();
      const outgoingWebhookReader = await tokenOfRoleHolding(NOTIFY_PERMISSIONS.WEBHOOK_READ);
      const webhookEventReader = await tokenOfRoleHolding(
        APP_PERMISSIONS.INSTAGRAM_WEBHOOK_EVENT_READ,
      );
      const listOutgoingWebhooks = (token: string) =>
        injectAuthenticated(app, { url: testApiPath('/notify/webhooks'), token });

      const refused = await list('', outgoingWebhookReader);
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused).reason).toBe('missing_permission');
      // The same role reads the outgoing webhooks: its code works, only not here.
      expect((await listOutgoingWebhooks(outgoingWebhookReader)).statusCode).toBe(200);

      const opened = await list('', webhookEventReader);
      expect(opened.statusCode).toBe(200);
      expect(bodyOf(opened).data).toHaveLength(5);
      // And the other way round: `webhook:read` stays the outgoing webhooks' only code.
      const outgoingRefused = await listOutgoingWebhooks(webhookEventReader);
      expect(outgoingRefused.statusCode).toBe(403);
      expect(errorOf(outgoingRefused).reason).toBe('missing_permission');
    });

    it('answers 404 team_organization_required on a personal organization, even with the code (K1)', async () => {
      const personal = await createPersonalOrganizationWithWebhookEventRead();

      const response = await list('', personal.token);

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('team_organization_required');
    });

    it('answers 401 without a token', async () => {
      const response = await injectUnauthenticated(app, { url: INSTAGRAM_WEBHOOK_EVENTS_PATH });

      expect(response.statusCode).toBe(401);
    });
  });
});
