import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { getEnv } from '@/shared/config/env.config.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { runAppTableCleanUpJob } from '@/domains/app/workers/app-table-clean-up.processor.js';
import { runAutomationTombstoneRetentionJob } from '@/domains/app/sub-domains/automation/workers/automation-tombstone-retention.processor.js';
import { RecordingSendingPort } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/recording-sending-port.factory.js';
import { readRunRow } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  CONTACTS_PATH,
  contactPath,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { organizationChannelAccountPath } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import {
  mockInstagramUnsubscribe,
  readStagedAuditRows,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { insertInstagramMessage } from '@/domains/app/sub-domains/instagram-sending/instagram-message/__tests__/factories/instagram-message.factory.js';
import {
  FORM_CONTENT_TYPE,
  META_DATA_DELETION_PATH,
  buildMetaSignedRequest,
  metaCallbackFormBody,
  metaIssuedAtAfterConnections,
  metaSignedRequestPayload,
} from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection-meta-callback.factory.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import {
  type InjectHttpResult,
  injectAuthenticated,
  injectRoute,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  type ConnectedInstagramTeam,
  JORDAN,
  MORGAN,
  connectInstagramTeam,
  deleteContactAsOwner,
  historyAutomations,
  mockInstagramConversation,
  personalValuesOf,
  readAppRowsOfOrganization,
  readRowsOfContact,
  writeBroadcastHistory,
  writeHistory,
  writeSegmentHistory,
} from './instagram-retention-erasure.helper.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** `POST /app/segments/audience-count` (route 79). */
const AUDIENCE_COUNT_PATH = testApiPath('/app/segments/audience-count');

/** The tables a contact erase and Meta's data deletion leave as they were (AC-26.6). */
const KEPT_HISTORY_TABLES = [
  'automations',
  'contacts',
  'automation_runs',
  'automation_run_events',
  'automation_comment_logs',
  'contact_tag_events',
] as const;

/**
 * Flow F26 — Meta's data deletion and a contact erase, end to end (feat-instagram-dm-sending
 * ROUTE R61, AC-26.1–AC-26.7): people write to a connected account over Meta's signed webhook, the
 * real processing and run engine work with them (Instagram mocked at the network with nock), and
 * then a contact delete (route 23), a disconnect (route 8), Meta's signed data-deletion callback
 * (route 17, signed once so a repeat is the same request) and an organization delete are each checked
 * on the whole `app` schema — and R50's hourly clean-ups, run with their injectable `now`, never
 * bring a person back or remove an erased row.
 */
describe('Meta data deletion and contact erase flow (e2e, AC-26)', () => {
  let app: FastifyInstance;
  /** Instagram's real sending port (R19) — the one whose waiting messages an erase cancels. */
  let instagramSendingPort: NonNullable<
    FastifyInstance['appDomain']['channelSendingPorts']['instagram']
  >;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    const realPort = app.appDomain.channelSendingPorts.instagram;
    if (realPort === undefined) throw new Error('the app wired no Instagram sending port');
    instagramSendingPort = realPort;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    // The history is written with the run engine's sends recorded (as the retention suite does);
    // a test that checks real waiting messages puts Instagram's port back first.
    app.appDomain.channelSendingPorts.instagram = new RecordingSendingPort();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    nock.cleanAll();
    await metaGraphCircuit.reset();
  });

  /** Meta's signed data-deletion form for an Instagram user id — sign once, post it as often as Meta does. */
  function signDataDeletion(userId: string): string {
    return metaCallbackFormBody(
      buildMetaSignedRequest({
        payload: metaSignedRequestPayload({ userId, issuedAt: metaIssuedAtAfterConnections() }),
        appSecret: getEnv().META_APP_SECRET ?? '',
      }),
    );
  }

  function postDataDeletion(payload: string): Promise<InjectHttpResult> {
    return injectRoute(app, {
      method: 'POST',
      url: META_DATA_DELETION_PATH,
      headers: { 'content-type': FORM_CONTENT_TYPE },
      payload,
    });
  }

  async function readLaneStates(organizationId: number): Promise<string[]> {
    const rows = await operatorQuery<Array<{ state: string }>>`
      SELECT state FROM app.instagram_send_lanes WHERE organization_id = ${organizationId}
      ORDER BY id`;
    return rows.map((row) => row.state);
  }

  /** The rows of the history tables, to compare before and after (AC-26.6). */
  async function readKeptHistory(organizationId: number) {
    const rows = await readAppRowsOfOrganization(organizationId);
    return Object.fromEntries(KEPT_HISTORY_TABLES.map((table) => [table, rows[table]]));
  }

  /** Disconnects the organization's account through route 8 as its Owner. */
  async function disconnectAccount(team: ConnectedInstagramTeam): Promise<void> {
    mockInstagramUnsubscribe({ instagramUserId: team.profile.id });
    const response = await injectAuthenticated(app, {
      method: 'DELETE',
      url: await organizationChannelAccountPath(team.organization.id),
      token: team.ownerToken,
    });
    expect(response.statusCode).toBe(204);
  }

  describe('a contact erase (route 23)', () => {
    it('clears her data, keeps the row, cancels her runs and waiting messages, drops her tag events and her copies, and answers contact_not_found everywhere after (AC-26.1–AC-26.3, AC-26.7)', async () => {
      const team = await connectInstagramTeam(app);
      mockInstagramConversation({ instagramAppUserId: team.profile.id, people: [JORDAN, MORGAN] });
      const automations = await historyAutomations({ team });
      const jordan = await writeHistory({ app, team, person: JORDAN, automations });
      const morgan = await writeHistory({ app, team, person: MORGAN, automations });
      await operatorQuery`
        UPDATE app.contacts SET note = 'Jordan Privateperson asked about sizes'
        WHERE id = ${jordan.contact.id}`;
      const channelAccountId = Number(jordan.contact.channel_account_id);
      const waitingMessage = await insertInstagramMessage({
        run: jordan.waitingRun,
        channelAccountId,
        message_type: 'opening_message',
        message_number: null,
        lane: 'slow',
        channel: 'private_reply',
        status: 'waiting',
        reason: null,
      });
      const morganMessage = await insertInstagramMessage({
        run: morgan.waitingRun,
        channelAccountId,
        message_type: 'opening_message',
        message_number: null,
        lane: 'slow',
        channel: 'private_reply',
        status: 'waiting',
        reason: null,
      });
      await writeSegmentHistory(team.organization.id);
      await writeBroadcastHistory(team.organization.id);
      const morganBefore = await readRowsOfContact({ team, contact: morgan.contact });
      app.appDomain.channelSendingPorts.instagram = instagramSendingPort;

      const response = await deleteContactAsOwner({
        app,
        team,
        contactPublicId: jordan.contact.public_id,
      });

      expect(response.statusCode).toBe(204);
      // AC-26.1 — the row stays with every personal column cleared.
      const [contactRow] = await operatorQuery<Array<Record<string, unknown>>>`
        SELECT username, full_name, profile_picture_url, email, phone, note, instagram_user_id,
               tags, deleted_at
        FROM app.contacts WHERE id = ${jordan.contact.id}`;
      expect(contactRow).toMatchObject({
        username: null,
        full_name: null,
        profile_picture_url: null,
        email: null,
        phone: null,
        note: null,
        instagram_user_id: null,
        tags: [],
      });
      expect(contactRow?.deleted_at).not.toBeNull();
      // Her open runs cancelled, her waiting message cancelled; Morgan's stays waiting.
      for (const run of [jordan.waitingRun, jordan.runningRun]) {
        expect(await readRunRow(run.id)).toMatchObject({
          status: 'cancelled',
          cancel_reason: 'contact_deleted',
        });
      }
      const messages = await operatorQuery<Array<{ id: string; status: string; reason: string }>>`
        SELECT id::text, status, reason FROM app.instagram_messages
        WHERE id IN (${waitingMessage.id}, ${morganMessage.id}) ORDER BY id`;
      expect(messages.map((row) => [row.status, row.reason])).toEqual([
        ['cancelled', 'contact_deleted'],
        ['waiting', null],
      ]);
      // Her tag events are gone; Morgan's stay.
      const tagEvents = await operatorQuery<Array<{ contact_id: string }>>`
        SELECT contact_id::text FROM app.contact_tag_events
        WHERE organization_id = ${team.organization.id}`;
      expect(tagEvents.map((row) => Number(row.contact_id))).toEqual([Number(morgan.contact.id)]);
      // AC-26.2 — her copies in comment logs and runs are erased in the same step.
      const herRows = JSON.stringify(await readRowsOfContact({ team, contact: jordan.contact }));
      for (const value of [...personalValuesOf(JORDAN), ...jordan.texts]) {
        expect(herRows).not.toContain(value);
      }
      expect(await readRowsOfContact({ team, contact: morgan.contact })).toEqual(morganBefore);
      // Her waiting broadcast recipient is skipped (AC-26.3: in no broadcast).
      const recipients = await operatorQuery<Array<{ status: string; reason: string | null }>>`
        SELECT status, reason FROM app.broadcast_recipients
        WHERE organization_id = ${team.organization.id} AND contact_id = ${jordan.contact.id}`;
      expect(recipients).toEqual([{ status: 'skipped', reason: 'contact_deleted' }]);

      // AC-26.3 — contact_not_found, in no list and no segment count.
      const read = await injectAuthenticated(app, {
        url: contactPath(jordan.contact.public_id),
        token: team.ownerToken,
      });
      expect(read.statusCode).toBe(404);
      expect((read.json() as { error: { reason?: string } }).error.reason).toBe(
        'contact_not_found',
      );
      const list = await injectAuthenticated(app, {
        url: `${CONTACTS_PATH}?channel_account_id=${team.account.public_id}&limit=100`,
        token: team.ownerToken,
      });
      expect(list.statusCode).toBe(200);
      expect((list.json() as { data: Array<{ id: string }> }).data.map((item) => item.id)).toEqual([
        morgan.contact.public_id,
      ]);
      const count = await injectAuthenticated(app, {
        method: 'POST',
        url: AUDIENCE_COUNT_PATH,
        token: team.ownerToken,
        headers: { 'x-idempotency-key': randomUUID() },
        payload: {
          channel_account_id: team.account.public_id,
          conditions: { op: 'and', items: [{ field: 'details', has: 'email' }] },
        },
      });
      expect(count.statusCode).toBe(200);
      expect((count.json() as { data: { matched: number } }).data.matched).toBe(1);
      const repeat = await deleteContactAsOwner({
        app,
        team,
        contactPublicId: jordan.contact.public_id,
      });
      expect(repeat.statusCode).toBe(404);

      // AC-26.7 — one audit entry, holding no email, phone or name.
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.contact.delete',
      });
      expect(audit).toHaveLength(1);
      const auditText = JSON.stringify(audit);
      for (const value of [JORDAN.email, JORDAN.phone, JORDAN.fullName, JORDAN.username]) {
        expect(auditText).not.toContain(value);
      }

      // R50's hourly clean-ups, a year on, never remove the erased row nor bring her back (AC-5.13).
      const aYearOn = new Date(Date.now() + 365 * MILLISECONDS_PER_DAY);
      await runAppTableCleanUpJob({ now: aYearOn });
      await runAutomationTombstoneRetentionJob({ now: aYearOn });
      const [kept] = await operatorQuery<Array<{ username: string | null }>>`
        SELECT username FROM app.contacts WHERE id = ${jordan.contact.id}`;
      expect(kept).toEqual({ username: null });
    });
  });

  describe("Meta's data deletion (route 17)", () => {
    it('erases the token, profile and posts in every organization holding the account, keeps the history a disconnect kept, and answers the same code again (AC-26.4, AC-26.6)', async () => {
      const formerTeam = await connectInstagramTeam(app);
      mockInstagramConversation({
        instagramAppUserId: formerTeam.profile.id,
        people: [JORDAN, MORGAN],
      });
      const formerAutomations = await historyAutomations({ team: formerTeam });
      await writeHistory({ app, team: formerTeam, person: JORDAN, automations: formerAutomations });
      const formerHistory = await readKeptHistory(formerTeam.organization.id);

      // AC-26.6 — a disconnect without a deletion keeps the automations, contacts and history.
      await disconnectAccount(formerTeam);
      expect(await readKeptHistory(formerTeam.organization.id)).toEqual(formerHistory);
      const formerAfterDisconnect = await readAppRowsOfOrganization(formerTeam.organization.id);
      expect(formerAfterDisconnect.channel_accounts).toEqual([
        expect.objectContaining({ connection_status: 'revoked' }),
      ]);

      // The same Instagram account, now live in another organization.
      const team = await connectInstagramTeam(app, formerTeam.profile);
      const automations = await historyAutomations({ team });
      await writeHistory({ app, team, person: MORGAN, automations });
      const bystander = await connectInstagramTeam(app);
      const bystanderBefore = await readAppRowsOfOrganization(bystander.organization.id);
      const before = await readAppRowsOfOrganization(team.organization.id);
      expect(before.channel_connection_tokens).toHaveLength(1);
      expect(before.instagram_media?.length).toBeGreaterThan(0);
      expect(await readLaneStates(team.organization.id)).toEqual([
        'ready',
        'ready',
        'ready',
        'ready',
      ]);
      const history = await readKeptHistory(team.organization.id);

      const signed = signDataDeletion(team.profile.id);
      const response = await postDataDeletion(signed);

      expect(response.statusCode).toBe(200);
      const answer = response.json() as { url: string; confirmation_code: string };
      expect(answer.confirmation_code).toMatch(/^[a-z0-9]{21}$/);
      for (const organizationId of [team.organization.id, formerTeam.organization.id]) {
        const rows = await readAppRowsOfOrganization(organizationId);
        expect(rows.instagram_accounts).toEqual([
          expect.objectContaining({ username: null, profile_erased_at: expect.any(String) }),
        ]);
        expect(rows.channel_accounts).toEqual([
          expect.objectContaining({ connection_status: 'revoked' }),
        ]);
        expect(rows.channel_connection_tokens).toEqual([]);
        expect(rows.instagram_media).toEqual([]);
        const audit = await readStagedAuditRows({
          organizationPublicId: (organizationId === team.organization.id ? team : formerTeam)
            .organization.public_id,
          action: 'app.channel_connection.data_deletion',
        });
        expect(audit).toHaveLength(1);
      }
      // The live organization's lanes stop with the revoke; its history stays (D24).
      expect(await readLaneStates(team.organization.id)).toEqual([
        'stopped',
        'stopped',
        'stopped',
        'stopped',
      ]);
      expect(await readKeptHistory(team.organization.id)).toEqual(history);
      expect(await readKeptHistory(formerTeam.organization.id)).toEqual(formerHistory);
      expect(await readAppRowsOfOrganization(bystander.organization.id)).toEqual(bystanderBefore);

      // Meta repeats the same signed request: the same code, nothing changes, no second entry.
      const after = await readAppRowsOfOrganization(team.organization.id);
      const repeat = await postDataDeletion(signed);
      expect(repeat.statusCode).toBe(200);
      expect(repeat.json()).toEqual(answer);
      expect(await readAppRowsOfOrganization(team.organization.id)).toEqual(after);
      expect(
        await readStagedAuditRows({
          organizationPublicId: team.organization.public_id,
          action: 'app.channel_connection.data_deletion',
        }),
      ).toHaveLength(1);
    });

    it('answers a confirmation code for an unmatched id and emails the team (AC-26.5)', async () => {
      const team = await connectInstagramTeam(app);
      const before = await readAppRowsOfOrganization(team.organization.id);
      const unmatchedId = '17841499999990001';

      const response = await postDataDeletion(signDataDeletion(unmatchedId));

      expect(response.statusCode).toBe(200);
      expect((response.json() as { confirmation_code: string }).confirmation_code).toMatch(
        /^[a-z0-9]{21}$/,
      );
      const alerts = await operatorQuery<Array<{ dedupe_key: string }>>`
        SELECT dedupe_key FROM auth.mail_outbox
        WHERE dedupe_key LIKE ${`team-alert:meta-callback-unmatched:data_deletion:meta:${unmatchedId}:%`}`;
      expect(alerts.length).toBeGreaterThan(0);
      expect(await readAppRowsOfOrganization(team.organization.id)).toEqual(before);
    });
  });

  describe('an organization delete', () => {
    it("erases the organization's Instagram data and stops its lanes; another organization's stay ready (carry-over, CA8)", async () => {
      const team = await connectInstagramTeam(app);
      const otherTeam = await connectInstagramTeam(app);
      expect(await readLaneStates(team.organization.id)).toEqual([
        'ready',
        'ready',
        'ready',
        'ready',
      ]);
      const token = await generateTestToken({
        userId: team.owner.public_id,
        organizationPublicId: team.organization.public_id,
        stepUp: true,
      });
      mockInstagramUnsubscribe({ instagramUserId: team.profile.id });

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath('/tenancy/organization'),
        token,
      });

      expect(response.statusCode).toBe(204);
      const rows = await readAppRowsOfOrganization(team.organization.id);
      expect(rows.channel_accounts).toEqual([
        expect.objectContaining({ connection_status: 'revoked' }),
      ]);
      expect(rows.channel_connection_tokens).toEqual([]);
      expect(await readLaneStates(team.organization.id)).toEqual([
        'stopped',
        'stopped',
        'stopped',
        'stopped',
      ]);
      expect(await readLaneStates(otherTeam.organization.id)).toEqual([
        'ready',
        'ready',
        'ready',
        'ready',
      ]);
    });
  });
});
