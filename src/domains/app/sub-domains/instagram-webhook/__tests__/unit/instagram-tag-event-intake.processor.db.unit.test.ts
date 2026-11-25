import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { AutomationRunChannelAccount } from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import { AutomationCountRepository } from '@/domains/app/sub-domains/automation/automation-count.repository.js';
import { AutomationCountService } from '@/domains/app/sub-domains/automation/automation-count.service.js';
import { AutomationReplyStateRepository } from '@/domains/app/sub-domains/automation/automation-reply-state.repository.js';
import { AutomationReplyStateService } from '@/domains/app/sub-domains/automation/automation-reply-state.service.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import { ContactTagEventRepository } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.repository.js';
import { ContactTagEventService } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.service.js';
import { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import { RecordingSendingPort } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/recording-sending-port.factory.js';
import { processInstagramTagEventIntakeJob } from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-tag-event-intake.processor.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { readRunRows } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { readChannelAccountIdOfInstagramAccount } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/__tests__/factories/instagram-webhook-event.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Tag intake against the database (feat-instagram-dm-sending § 5 WH15, WHC9; WC-4; AC-16.19): a
 * tag event of one contact starts the account's tag automation only while her window is open, its
 * `done_at` set in the same transaction (a repeat starts nothing), a chain stopping at 3 — with the
 * real run engine (a recording sending port) and the contact's tag events.
 */

describe('processInstagramTagEventIntakeJob (database, the real run engine)', () => {
  let organization: { id: number; public_id: string };
  let account: { id: number; public_id: string };
  let channelAccountId: number;
  let services: Parameters<typeof processInstagramTagEventIntakeJob>[0]['services'];

  beforeAll(async () => {
    await initializeI18nextForBackgroundWork();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    channelAccountId = await readChannelAccountIdOfInstagramAccount(account.id);
    const runAccount: AutomationRunChannelAccount = {
      organizationId: organization.id,
      id: channelAccountId,
      public_id: account.public_id,
      channel: 'instagram',
      connection_status: 'connected',
      is_automation_enabled: true,
      time_zone: 'UTC',
      is_comment_reply_trigger_enabled: true,
      is_once_per_person_per_post_enabled: true,
    };
    const organizationService = {
      requireOrganizationByPublicId: async () => organization,
      findOrganizationByPublicId: async () => organization,
    } as unknown as OrganizationService;
    const contactService = new ContactService(
      new ContactRepository(),
      organizationService,
      [],
      async () => null,
    );
    services = {
      organizationService,
      contactTagEventService: new ContactTagEventService(new ContactTagEventRepository()),
      contactService,
      automationRunService: new AutomationRunService({
        channelAccountService: { readAutomationRunAccount: async () => runAccount } as never,
        contactService,
        planAccessService: { getPlanAccess: (async () => ({ features: null })) as never },
        countService: new AutomationCountService(new AutomationCountRepository()),
        replyStateService: new AutomationReplyStateService(new AutomationReplyStateRepository()),
        sendingPorts: { instagram: new RecordingSendingPort() },
      }),
    };
  });

  async function contactWithTagEvent({
    windowOpen,
    chainNumber = 0,
  }: {
    windowOpen: boolean;
    chainNumber?: number;
  }): Promise<{ contactPublicId: string; tagEventId: number }> {
    const contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      last_direct_message_received_at: windowOpen ? new Date() : null,
    });
    const [row] = await operatorQuery<Array<{ id: string }>>`
      INSERT INTO app.contact_tag_events
        (organization_id, channel_account_id, contact_id, tag, kind, source, chain_number, queued_at)
      VALUES (${organization.id}, ${channelAccountId}, ${contact.id}, 'vip', 'added', 'owner',
              ${chainNumber}, now())
      RETURNING id`;
    return { contactPublicId: contact.public_id, tagEventId: Number(row?.id) };
  }

  async function doneAt(tagEventId: number): Promise<Date | null> {
    const [row] = await operatorQuery<Array<{ done_at: Date | null }>>`
      SELECT done_at FROM app.contact_tag_events WHERE id = ${tagEventId}`;
    return row?.done_at ?? null;
  }

  function runJob(contactPublicIds: string[]) {
    return processInstagramTagEventIntakeJob({
      jobData: { organizationPublicId: organization.public_id, contactPublicIds },
      services,
      jobId: 'tag-job-1',
    });
  }

  async function tagAutomation() {
    return insertAutomation({
      organizationId: organization.id,
      instagramAccountId: account.id,
      status: 'live',
      trigger_type: 'tag_added',
      trigger_tag: 'vip',
      keywords: [],
      is_opening_message_enabled: false,
      opening_message: null,
    });
  }

  it('her window open: the tag automation starts and the event is done — a repeat starts nothing', async () => {
    const automation = await tagAutomation();
    const { contactPublicId, tagEventId } = await contactWithTagEvent({ windowOpen: true });

    await expect(runJob([contactPublicId])).resolves.toEqual({
      doneCount: 1,
      alreadyDoneCount: 0,
      failedCount: 0,
    });
    expect(await doneAt(tagEventId)).not.toBeNull();
    const runs = await readRunRows(organization.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ automation_id: automation.id, trigger_type: 'tag_added' });

    await expect(runJob([contactPublicId])).resolves.toMatchObject({ doneCount: 0 });
    expect(await readRunRows(organization.id)).toHaveLength(1);
  });

  it('her window closed: the event is done and no run starts (AC-16.19)', async () => {
    await tagAutomation();
    const { contactPublicId, tagEventId } = await contactWithTagEvent({ windowOpen: false });

    await runJob([contactPublicId]);

    expect(await doneAt(tagEventId)).not.toBeNull();
    expect(await readRunRows(organization.id)).toEqual([]);
  });

  it('a chain of tag starts stops at the third (D45)', async () => {
    await tagAutomation();
    const { contactPublicId } = await contactWithTagEvent({ windowOpen: true, chainNumber: 3 });

    await runJob([contactPublicId]);

    expect(await readRunRows(organization.id)).toEqual([]);
  });
});
