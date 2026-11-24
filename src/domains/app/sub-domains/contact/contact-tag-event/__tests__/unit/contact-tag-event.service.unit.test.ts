import { describe, expect, it, vi } from 'vitest';
import type { ContactTagChangeEvent } from '@/domains/app/sub-domains/contact/contact.types.js';
import { CONTACT_TAG_EVENT_INTAKE_CONTACTS_PER_JOB } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.constants.js';
import type { ContactTagEventRepository } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.repository.js';
import { ContactTagEventService } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.service.js';

/**
 * The tag-event recorder's own rules (routes-final § 3.B, CT16; scale review S20), over a mocked
 * repository: outside a unit of work the after-commit hand-over runs at once, so the order of the
 * calls is visible here; the database suite proves the commit itself.
 */

function changeEvent(overrides: Partial<ContactTagChangeEvent> = {}): ContactTagChangeEvent {
  return {
    organizationId: 7,
    channelAccountId: 11,
    contactId: 21,
    tag: 'vip',
    kind: 'added',
    source: 'owner',
    sourceAutomationId: null,
    chainNumber: 0,
    ...overrides,
  };
}

function mockRepository({ contactPublicIds = ['con_a'] }: { contactPublicIds?: string[] } = {}) {
  return {
    insertMany: vi.fn(async () => []),
    findHandOverTarget: vi.fn(async () => ({
      organizationPublicId: 'org_a',
      contactPublicIds,
    })),
    deleteForContact: vi.fn(async () => 2),
  };
}

function serviceWith(repository: ReturnType<typeof mockRepository>, withIntake: boolean) {
  const intakeQueue = {
    enqueueContactTagEventIntake: vi.fn(
      async (_input: { organizationPublicId: string; contactPublicIds: readonly string[] }) =>
        undefined,
    ),
  };
  const service = new ContactTagEventService(
    repository as unknown as ContactTagEventRepository,
    withIntake ? { intakeQueue } : {},
  );
  return { service, intakeQueue };
}

describe('ContactTagEventService', () => {
  it('does nothing for no events', async () => {
    const repository = mockRepository();
    const { service, intakeQueue } = serviceWith(repository, true);

    await service.recordContactTagEvents({ events: [] });

    expect(repository.insertMany).not.toHaveBeenCalled();
    expect(intakeQueue.enqueueContactTagEventIntake).not.toHaveBeenCalled();
  });

  it('writes the events unqueued and hands nothing over until intake is wired (R38)', async () => {
    const repository = mockRepository();
    const { service } = serviceWith(repository, false);
    const events = [changeEvent(), changeEvent({ tag: 'lead', kind: 'removed' })];

    await service.recordContactTagEvents({ events });

    expect(repository.insertMany).toHaveBeenCalledWith({ events, isQueued: false });
    expect(repository.findHandOverTarget).not.toHaveBeenCalled();
  });

  it('stamps queued_at and hands each organization its distinct contacts over once', async () => {
    const repository = mockRepository();
    const { service, intakeQueue } = serviceWith(repository, true);

    await service.recordContactTagEvents({
      events: [changeEvent(), changeEvent({ tag: 'lead' }), changeEvent({ contactId: 22 })],
    });

    expect(repository.insertMany).toHaveBeenCalledWith(expect.objectContaining({ isQueued: true }));
    expect(repository.findHandOverTarget).toHaveBeenCalledWith({
      organizationId: 7,
      contactIds: [21, 22],
    });
    expect(intakeQueue.enqueueContactTagEventIntake).toHaveBeenCalledExactlyOnceWith({
      organizationPublicId: 'org_a',
      contactPublicIds: ['con_a'],
    });
  });

  it('hands over one job per 500 contacts (S20)', async () => {
    const contactPublicIds = Array.from(
      { length: CONTACT_TAG_EVENT_INTAKE_CONTACTS_PER_JOB * 2 + 1 },
      (_, index) => `con_${index}`,
    );
    const repository = mockRepository({ contactPublicIds });
    const { service, intakeQueue } = serviceWith(repository, true);

    await service.recordContactTagEvents({ events: [changeEvent()] });

    const pieces = intakeQueue.enqueueContactTagEventIntake.mock.calls.map(
      ([input]) => input.contactPublicIds,
    );
    expect(pieces.map((piece) => piece.length)).toEqual([500, 500, 1]);
    expect(pieces.flat()).toEqual(contactPublicIds);
  });

  it('keeps going when a hand-over fails: the pick-up hands it over again (WC-27)', async () => {
    const repository = mockRepository({
      contactPublicIds: Array.from({ length: 501 }, (_, index) => `con_${index}`),
    });
    const { service, intakeQueue } = serviceWith(repository, true);
    intakeQueue.enqueueContactTagEventIntake.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      service.recordContactTagEvents({ events: [changeEvent()] }),
    ).resolves.toBeUndefined();

    expect(intakeQueue.enqueueContactTagEventIntake).toHaveBeenCalledTimes(2);
  });

  it('hands nothing over when no changed contact is live', async () => {
    const repository = mockRepository();
    repository.findHandOverTarget.mockResolvedValueOnce(
      null as unknown as { organizationPublicId: string; contactPublicIds: string[] },
    );
    const { service, intakeQueue } = serviceWith(repository, true);

    await service.recordContactTagEvents({ events: [changeEvent()] });

    expect(intakeQueue.enqueueContactTagEventIntake).not.toHaveBeenCalled();
  });

  it("deletes the erased contact's events (the erase step)", async () => {
    const repository = mockRepository();
    const { service } = serviceWith(repository, false);

    await service.deleteContactTagEvents({
      organizationId: 7,
      contactId: 21,
      instagramUserId: '17841400000000001',
    });

    expect(repository.deleteForContact).toHaveBeenCalledWith({ organizationId: 7, contactId: 21 });
  });
});
