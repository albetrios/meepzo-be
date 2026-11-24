import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import type { ContactUpdateInput } from '@/domains/app/sub-domains/contact/contact.types.js';
import { ContactTagEventRepository } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.repository.js';
import { contact_tag_events } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.schema.js';
import { ContactTagEventService } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.service.js';
import type { ContactTagEventIntakeQueue } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.types.js';
import {
  insertContact,
  insertInstagramAccount,
  readContactRow,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

/**
 * Contact tag events against the database (routes-final § 3.B, CT16; AC-5.5): every tag change
 * writes exactly one event per tag in its own commit — route 20's owner change and the tag step —
 * a rollback writes none, the hand-over to intake runs only after commit, and the erase deletes a
 * contact's events. Each statement runs inside the organization's own context, so the suite also
 * holds under `pnpm test:rls-role`.
 */

type TestOrganization = { id: number; public_id: string; type: string };

const UPDATE_NOTHING: ContactUpdateInput = {
  note: undefined,
  addTags: [],
  removeTags: [],
  isAutomationsPaused: undefined,
  expectedUpdatedAt: undefined,
};

describe('ContactTagEventService (database)', () => {
  let organization: TestOrganization;
  let account: { id: number; public_id: string; channel_account_id: number };
  let intakeQueue: ContactTagEventIntakeQueue & {
    enqueueContactTagEventIntake: ReturnType<typeof vi.fn>;
  };

  function buildContactService({ withIntake }: { withIntake: boolean }): ContactService {
    const tagEventService = new ContactTagEventService(
      new ContactTagEventRepository(),
      withIntake ? { intakeQueue } : {},
    );
    const organizationService = {
      requireOrganizationByPublicId: async () => organization,
      resolveUserInternalIdByPublicId: async () => null,
      resolveUserPublicIdsByInternalIds: async () => new Map(),
    } as unknown as OrganizationService;
    return new ContactService(
      new ContactRepository(),
      organizationService,
      [(input) => tagEventService.deleteContactTagEvents(input)],
      async () => null,
      { tagEventRecorder: tagEventService },
    );
  }

  beforeEach(async () => {
    await cleanupDatabase();
    const owner = await createTestUser();
    organization = await createTestOrganization({ ownerUserId: owner.id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    intakeQueue = { enqueueContactTagEventIntake: vi.fn(async () => undefined) };
  });

  const scope = () => PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id });
  const caller = () => ({ scope: scope(), userPublicId: '' });

  function inJob<T>(callback: (databaseHandle: WorkerDatabaseHandle) => Promise<T>): Promise<T> {
    return withAppDatabaseContext({ scope: scope(), callback });
  }

  async function newContact(tags: string[] = []) {
    return insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      tags,
    });
  }

  async function eventsOf(contactId: number) {
    return getOperatorDatabase()
      .select()
      .from(contact_tag_events)
      .where(eq(contact_tag_events.contact_id, contactId))
      .orderBy(asc(contact_tag_events.id));
  }

  it("writes one owner event per tag change in route 20's commit (AC-5.5)", async () => {
    const service = buildContactService({ withIntake: false });
    const contact = await newContact(['lead']);

    await service.updateContact({
      caller: caller(),
      contactPublicId: contact.public_id,
      input: { ...UPDATE_NOTHING, addTags: ['vip', 'lead'], removeTags: ['lead'] },
    });

    const events = await eventsOf(contact.id);
    expect(events.map(({ tag, kind }) => ({ tag, kind }))).toEqual([
      { tag: 'vip', kind: 'added' },
      { tag: 'lead', kind: 'added' },
      { tag: 'lead', kind: 'removed' },
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        organization_id: organization.id,
        channel_account_id: account.channel_account_id,
        source: 'owner',
        source_automation_id: null,
        chain_number: 0,
        // Intake is not wired yet (R38): nothing is handed over, the pick-up finds them.
        queued_at: null,
        done_at: null,
      });
    }
  });

  it('writes nothing when the change changes no tag', async () => {
    const service = buildContactService({ withIntake: false });
    const contact = await newContact(['vip']);

    await service.updateContact({
      caller: caller(),
      contactPublicId: contact.public_id,
      input: { ...UPDATE_NOTHING, addTags: ['vip'], note: 'A note' },
    });

    expect(await eventsOf(contact.id)).toEqual([]);
  });

  it("writes the tag step's events with its chain number in the job's commit", async () => {
    const service = buildContactService({ withIntake: false });
    const contact = await newContact(['vip']);

    await inJob((databaseHandle) =>
      service.addContactTags({
        databaseHandle,
        organizationId: organization.id,
        contactId: contact.id,
        tags: ['vip', 'buyer'],
        chainNumber: 2,
      }),
    );

    expect(await eventsOf(contact.id)).toEqual([
      expect.objectContaining({
        tag: 'buyer',
        kind: 'added',
        source: 'automation',
        chain_number: 2,
      }),
    ]);
  });

  it('writes no event when the tag commit rolls back', async () => {
    const service = buildContactService({ withIntake: true });
    const contact = await newContact();

    await expect(
      inJob(async (databaseHandle) => {
        await service.addContactTags({
          databaseHandle,
          organizationId: organization.id,
          contactId: contact.id,
          tags: ['vip'],
        });
        throw new Error('the run failed after the tag step');
      }),
    ).rejects.toThrow('the run failed after the tag step');

    expect(await eventsOf(contact.id)).toEqual([]);
    expect((await readContactRow(contact.id))?.tags).toEqual([]);
    expect(intakeQueue.enqueueContactTagEventIntake).not.toHaveBeenCalled();
  });

  it('hands the contact to intake only after the commit, with queued_at stamped (WC-4, S20)', async () => {
    const service = buildContactService({ withIntake: true });
    const contact = await newContact();
    let calledInsideTheUnit = false;

    await inJob(async (databaseHandle) => {
      await service.addContactTags({
        databaseHandle,
        organizationId: organization.id,
        contactId: contact.id,
        tags: ['vip', 'buyer'],
      });
      calledInsideTheUnit = intakeQueue.enqueueContactTagEventIntake.mock.calls.length > 0;
    });

    expect(calledInsideTheUnit).toBe(false);
    expect(intakeQueue.enqueueContactTagEventIntake).toHaveBeenCalledTimes(1);
    expect(intakeQueue.enqueueContactTagEventIntake).toHaveBeenCalledWith({
      organizationPublicId: organization.public_id,
      contactPublicIds: [contact.public_id],
    });
    const events = await eventsOf(contact.id);
    expect(events).toHaveLength(2);
    for (const event of events) expect(event.queued_at).toBeInstanceOf(Date);
  });

  it("deletes the contact's tag events with her erase, and no one else's (CT11)", async () => {
    const service = buildContactService({ withIntake: false });
    const erased = await newContact();
    const kept = await newContact();
    for (const contact of [erased, kept]) {
      await service.updateContact({
        caller: caller(),
        contactPublicId: contact.public_id,
        input: { ...UPDATE_NOTHING, addTags: ['vip'] },
      });
    }

    await service.deleteContact({ scope: scope(), contactPublicId: erased.public_id });

    expect(await eventsOf(erased.id)).toEqual([]);
    expect(await eventsOf(kept.id)).toHaveLength(1);
  });

  it('refuses a tag outside the stored shape (chk_contact_tag_events_tag)', async () => {
    const contact = await newContact();
    const repository = new ContactTagEventRepository();
    await expect(
      inJob(() =>
        repository.insertMany({
          events: [
            {
              organizationId: organization.id,
              channelAccountId: account.channel_account_id,
              contactId: contact.id,
              tag: 'a,b',
              kind: 'added',
              source: 'owner',
              sourceAutomationId: null,
              chainNumber: 0,
            },
          ],
          isQueued: false,
        }),
      ),
    ).rejects.toThrow();
  });
});
