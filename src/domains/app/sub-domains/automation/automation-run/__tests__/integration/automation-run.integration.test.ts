import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import {
  injectAuthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  INSTAGRAM_ACCOUNT_PATH,
  createInstagramTeam,
  readStagedAuditRows,
  type InstagramTeamFixture,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  CONTACTS_PATH,
  type ContactFixtureRow,
  contactPath,
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  type AutomationFixtureRow,
  automationPath,
  insertAutomation,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationCommentLog,
  insertAutomationRun,
  readCommentLogRows,
  readRunEventTrail,
  readRunRow,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';

/**
 * The run sub-domain where the routes reach it (routes-final § 3.B — AUC13, AU12, AU26, IQ1) over
 * HTTP: the contacts list's `automation_id` filter (CT5 — deleted automations included, an unknown
 * id an empty page), an automation delete cancelling its open runs in the same transaction (route
 * 15, the audit's `cancelled_run_count`), a contact delete erasing the run and comment-log copies
 * (route 10, CT8), and a disconnect cancelling nothing (route 4, IQ1). The database, auth,
 * permissions and audit are real.
 */
describe('Automation runs through the routes', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  let account: { id: number; public_id: string };
  let automation: AutomationFixtureRow;
  let otherAutomation: AutomationFixtureRow;
  let contact: ContactFixtureRow;

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
    automation = await insertAutomation({
      organizationId: team.organization.id,
      instagramAccountId: account.id,
      name: 'Spring giveaway',
      status: 'live',
    });
    otherAutomation = await insertAutomation({
      organizationId: team.organization.id,
      instagramAccountId: account.id,
      name: 'Catalog',
      status: 'live',
    });
    contact = await insertContact({
      organizationId: team.organization.id,
      instagramAccountId: account.id,
      username: 'jordan.lee',
    });
  });

  function contactOfTeam(username: string): Promise<ContactFixtureRow> {
    return insertContact({
      organizationId: team.organization.id,
      instagramAccountId: account.id,
      username,
    });
  }

  async function listedContactIds(query: string): Promise<string[]> {
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: `${CONTACTS_PATH}?${query}&limit=100`,
      token: team.ownerToken,
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { data: Array<{ id: string }> }).data.map((row) => row.id).sort();
  }

  function deleteAutomation(automationPublicId: string): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'DELETE',
      url: `${automationPath(automationPublicId)}?reason=not_needed`,
      token: team.ownerToken,
    });
  }

  describe('GET /app/contacts?automation_id= (CT5, AUC13)', () => {
    it('lists the contacts that had a run of the automation — in any status', async () => {
      const finished = await contactOfTeam('finished.contact');
      const otherOnly = await contactOfTeam('other.only');
      await contactOfTeam('no.runs');
      await insertAutomationRun({
        organizationId: team.organization.id,
        automationId: automation.id,
        contactId: contact.id,
      });
      await insertAutomationRun({
        organizationId: team.organization.id,
        automationId: automation.id,
        contactId: finished.id,
        status: 'completed',
        waiting_for: null,
        waiting_since_at: null,
        completed_at: new Date(),
      });
      await insertAutomationRun({
        organizationId: team.organization.id,
        automationId: otherAutomation.id,
        contactId: otherOnly.id,
      });

      expect(await listedContactIds(`automation_id=${automation.public_id}`)).toEqual(
        [contact.public_id, finished.public_id].sort(),
      );
      expect(await listedContactIds(`automation_id=${otherAutomation.public_id}`)).toEqual([
        otherOnly.public_id,
      ]);
    });

    it("keeps a deleted automation's contacts, and answers an empty page for an unknown or another organization's automation", async () => {
      await insertAutomationRun({
        organizationId: team.organization.id,
        automationId: automation.id,
        contactId: contact.id,
      });
      await getOperatorDatabase()
        .update(automations)
        .set({ deleted_at: new Date(), delete_reason: 'mistake' })
        .where(eq(automations.id, automation.id));

      expect(await listedContactIds(`automation_id=${automation.public_id}`)).toEqual([
        contact.public_id,
      ]);
      expect(await listedContactIds('automation_id=aut_a1b2c3d4e5f6g7h8i9j0k')).toEqual([]);

      const otherTeam = await createInstagramTeam();
      const otherAccount = await insertInstagramAccount({
        organizationId: otherTeam.organization.id,
      });
      const foreign = await insertAutomation({
        organizationId: otherTeam.organization.id,
        instagramAccountId: otherAccount.id,
      });
      expect(await listedContactIds(`automation_id=${foreign.public_id}`)).toEqual([]);
    });

    it('pages a filtered list and combines it with the other filters', async () => {
      const second = await contactOfTeam('second.contact');
      for (const row of [contact, second]) {
        await insertAutomationRun({
          organizationId: team.organization.id,
          automationId: automation.id,
          contactId: row.id,
        });
      }

      const firstPage = await injectAuthenticated(app, {
        method: 'GET',
        url: `${CONTACTS_PATH}?automation_id=${automation.public_id}&limit=1`,
        token: team.ownerToken,
      });
      const body = firstPage.json() as {
        data: Array<{ id: string }>;
        meta: { pagination: { next: string | null; has_more: boolean; estimated_total?: number } };
      };
      expect(body.data).toHaveLength(1);
      expect(body.meta.pagination).toMatchObject({ has_more: true, estimated_total: 2 });
      const secondPage = await injectAuthenticated(app, {
        method: 'GET',
        url: `${CONTACTS_PATH}?automation_id=${automation.public_id}&limit=1&after=${encodeURIComponent(body.meta.pagination.next ?? '')}`,
        token: team.ownerToken,
      });
      expect(secondPage.statusCode).toBe(200);
      expect(
        [...body.data, ...(secondPage.json() as { data: Array<{ id: string }> }).data]
          .map((row) => row.id)
          .sort(),
      ).toEqual([contact.public_id, second.public_id].sort());
      expect(await listedContactIds(`automation_id=${automation.public_id}&q=second`)).toEqual([
        second.public_id,
      ]);
    });
  });

  describe('DELETE /app/automations/{automation_id} cancels its open runs (AU12, AUC7)', () => {
    it('cancels the open runs in the same transaction, counts them in the audit and keeps the final ones', async () => {
      const finished = await contactOfTeam('finished.contact');
      const waiting = await insertAutomationRun({
        organizationId: team.organization.id,
        automationId: automation.id,
        contactId: contact.id,
      });
      const completed = await insertAutomationRun({
        organizationId: team.organization.id,
        automationId: automation.id,
        contactId: finished.id,
        status: 'completed',
        waiting_for: null,
        waiting_since_at: null,
        completed_at: new Date(),
      });
      const othersRun = await insertAutomationRun({
        organizationId: team.organization.id,
        automationId: otherAutomation.id,
        contactId: finished.id,
      });
      await insertAutomationCommentLog({
        organizationId: team.organization.id,
        automationId: automation.id,
        contactId: contact.id,
        automation_run_id: waiting.id,
        overall_status: 'waiting',
        waiting_for: 'email',
      });

      const response = await deleteAutomation(automation.public_id);

      expect(response.statusCode).toBe(204);
      expect(await readRunRow(waiting.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'automation_deleted',
      });
      expect(await readRunEventTrail(waiting.id)).toEqual(['status_changed:cancelled']);
      expect((await readRunRow(completed.id))?.status).toBe('completed');
      expect((await readRunRow(othersRun.id))?.status).toBe('waiting');
      expect((await readCommentLogRows(team.organization.id))[0]?.overall_status).toBe('cancelled');
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.automation.delete',
      });
      expect(audit).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({
            automation_public_id: automation.public_id,
            cancelled_run_count: 1,
          }),
        }),
      ]);
    });
  });

  describe('DELETE /app/contacts/{contact_id} erases the run copies (AU26, CT8)', () => {
    it("cancels the contact's open runs and clears the trigger text and every comment-log copy", async () => {
      const open = await insertAutomationRun({
        organizationId: team.organization.id,
        automationId: automation.id,
        contactId: contact.id,
        trigger_text: 'my secret text',
      });
      const log = await insertAutomationCommentLog({
        organizationId: team.organization.id,
        automationId: automation.id,
        contactId: contact.id,
        automation_run_id: open.id,
        overall_status: 'waiting',
        waiting_for: 'email',
        email_received: 'jordan@example.com',
      });

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: contactPath(contact.public_id),
        token: team.ownerToken,
      });

      expect(response.statusCode).toBe(204);
      expect(await readRunRow(open.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'contact_deleted',
        trigger_text: null,
        queued_automations: [],
      });
      const [erasedLog] = await readCommentLogRows(team.organization.id);
      expect(erasedLog).toMatchObject({
        id: log.id,
        overall_status: 'cancelled',
        comment_text: null,
        commenter_username: null,
        commenter_instagram_user_id: null,
        email_received: null,
        phone_received: null,
        instagram_comment_id: log.instagram_comment_id,
      });
    });
  });

  describe('DELETE /app/social/instagram/account cancels nothing (IQ1, D24)', () => {
    it('leaves the waiting runs waiting', async () => {
      const waiting = await insertAutomationRun({
        organizationId: team.organization.id,
        automationId: automation.id,
        contactId: contact.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });

      expect(response.statusCode).toBe(204);
      expect(await readRunRow(waiting.id)).toMatchObject({
        status: 'waiting',
        cancel_reason: null,
      });
    });
  });
});
