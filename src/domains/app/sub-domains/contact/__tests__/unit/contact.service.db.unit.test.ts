import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import { CONTACT_INTERACTION_KIND } from '@/domains/app/sub-domains/contact/contact.constants.js';
import type { ContactErasureStep } from '@/domains/app/sub-domains/contact/contact.types.js';
import {
  insertContact,
  insertInstagramAccount,
  readAccountContactRows,
  readContactRow,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

/**
 * The contact service against the database (routes-final § 2.10, CT2, CT7–CT10, CT13): the worker
 * operations on an organization-scoped handle, exactly as event processing and the run engine call
 * them, and the erase with its registered steps in one transaction. Every statement runs inside the
 * organization's own context, so the suite also holds under `pnpm test:rls-role`.
 */

type TestOrganization = { id: number; public_id: string; type: string };

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe('ContactService (database)', () => {
  let organization: TestOrganization;
  let account: { id: number; public_id: string };
  let erasureSteps: ContactErasureStep[];
  let service: ContactService;

  beforeEach(async () => {
    await cleanupDatabase();
    const owner = await createTestUser();
    organization = await createTestOrganization({ ownerUserId: owner.id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    erasureSteps = [];
    const organizationService = {
      requireOrganizationByPublicId: async () => organization,
    } as unknown as OrganizationService;
    service = new ContactService(
      new ContactRepository(),
      organizationService,
      erasureSteps,
      async () => null,
    );
  });

  /** Runs `callback` with the organization's job-shaped handle, as a worker job would. */
  function inJob<T>(callback: (databaseHandle: WorkerDatabaseHandle) => Promise<T>): Promise<T> {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id }),
      callback,
    });
  }

  const scope = () => PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id });

  function interact(
    overrides: Partial<{
      instagramAccountId: number;
      instagramUserId: string;
      username: string | null;
      occurredAt: Date;
      interactionKind: (typeof CONTACT_INTERACTION_KIND)[keyof typeof CONTACT_INTERACTION_KIND];
    }> = {},
  ) {
    return inJob((databaseHandle) =>
      service.recordContactInteraction({
        databaseHandle,
        organizationId: organization.id,
        instagramAccountId: account.id,
        instagramUserId: '17841455500000001',
        username: 'jordan.lee',
        occurredAt: minutesAgo(10),
        interactionKind: CONTACT_INTERACTION_KIND.COMMENT,
        ...overrides,
      }),
    );
  }

  describe('recordContactInteraction', () => {
    it('creates a contact from its first event: first seen = last message = the event time (CT10)', async () => {
      const occurredAt = minutesAgo(30);

      const { contact, isNewContact } = await interact({ occurredAt });

      expect(isNewContact).toBe(true);
      expect(contact).toMatchObject({
        organization_id: organization.id,
        instagram_account_id: account.id,
        instagram_user_id: '17841455500000001',
        username: 'jordan.lee',
        tags: [],
        deleted_at: null,
        last_direct_message_received_at: null,
      });
      expect(contact.public_id).toMatch(/^con_[a-z0-9]{21}$/);
      expect(contact.first_seen_at.getTime()).toBe(occurredAt.getTime());
      expect(contact.last_message_received_at.getTime()).toBe(occurredAt.getTime());
    });

    it('touches the live contact on a later event: username kept unless given, times only forward', async () => {
      const firstAt = minutesAgo(30);
      const laterAt = minutesAgo(5);
      const lateArrivalAt = minutesAgo(60);
      const first = await interact({ occurredAt: firstAt });
      const later = await interact({ occurredAt: laterAt, username: null });
      const lateArrival = await interact({
        occurredAt: lateArrivalAt,
        username: 'jordan.renamed',
      });

      expect(later.isNewContact).toBe(false);
      expect(later.contact.id).toBe(first.contact.id);
      expect(later.contact.username).toBe('jordan.lee');
      expect(later.contact.last_message_received_at.getTime()).toBe(laterAt.getTime());
      expect(lateArrival.isNewContact).toBe(false);
      expect(lateArrival.contact.username).toBe('jordan.renamed');
      // An older event never moves the last message back, nor the first-seen time.
      expect(lateArrival.contact.last_message_received_at.getTime()).toBe(laterAt.getTime());
      expect(lateArrival.contact.first_seen_at.getTime()).toBe(firstAt.getTime());
    });

    it('moves last_direct_message_received_at on a DM, story reply or button click — never on a comment', async () => {
      const comment = await interact({ occurredAt: minutesAgo(40) });
      expect(comment.contact.last_direct_message_received_at).toBeNull();

      let lastDirectMessageAt = new Date(0);
      for (const [index, interactionKind] of [
        CONTACT_INTERACTION_KIND.DIRECT_MESSAGE,
        CONTACT_INTERACTION_KIND.STORY_REPLY,
        CONTACT_INTERACTION_KIND.BUTTON_CLICK,
      ].entries()) {
        lastDirectMessageAt = minutesAgo(30 - index * 10);
        const { contact } = await interact({ occurredAt: lastDirectMessageAt, interactionKind });
        expect(contact.last_direct_message_received_at?.getTime()).toBe(
          lastDirectMessageAt.getTime(),
        );
      }
      const laterCommentAt = minutesAgo(1);
      const laterComment = await interact({ occurredAt: laterCommentAt });
      expect(laterComment.contact.last_direct_message_received_at?.getTime()).toBe(
        lastDirectMessageAt.getTime(),
      );
      expect(laterComment.contact.last_message_received_at.getTime()).toBe(
        laterCommentAt.getTime(),
      );
    });

    it('keys a contact per Instagram account: the same person on two accounts is two contacts (CT13)', async () => {
      const revoked = await insertInstagramAccount({
        organizationId: organization.id,
        connectionStatus: 'revoked',
      });
      const onFirst = await interact();
      const onSecond = await interact({ instagramAccountId: revoked.id });

      expect(onSecond.isNewContact).toBe(true);
      expect(onSecond.contact.id).not.toBe(onFirst.contact.id);
      expect(
        await readAccountContactRows({
          organizationId: organization.id,
          instagramAccountId: account.id,
        }),
      ).toHaveLength(1);
    });

    it('starts a fresh contact after an erase (CT9, AC-4.13)', async () => {
      const original = await interact();
      await service.deleteContact({ scope: scope(), contactPublicId: original.contact.public_id });

      const fresh = await interact({ occurredAt: minutesAgo(1) });

      expect(fresh.isNewContact).toBe(true);
      expect(fresh.contact.id).not.toBe(original.contact.id);
      expect((await readContactRow(original.contact.id))?.instagram_user_id).toBeNull();
    });

    it('refuses an Instagram user id that is not digits (a caller bug)', async () => {
      await expect(interact({ instagramUserId: 'abc' })).rejects.toThrow(/digits only/);
    });
  });

  describe('the other worker operations (2.10)', () => {
    async function liveContact() {
      return (await interact()).contact;
    }

    it('recordContactProfile sets only the fields given; a follow answer stamps its check time', async () => {
      const contact = await liveContact();
      const checkedAt = minutesAgo(2);

      const updated = await inJob((databaseHandle) =>
        service.recordContactProfile({
          databaseHandle,
          organizationId: organization.id,
          contactId: contact.id,
          profile: {
            username: null,
            fullName: '  Jordan Lee ',
            profilePictureUrl: 'http://insecure.example.com/p.jpg',
            followersCount: 812,
            isFollowingAccount: false,
          },
          checkedAt,
        }),
      );

      expect(updated).toMatchObject({
        username: 'jordan.lee',
        full_name: 'Jordan Lee',
        profile_picture_url: null,
        followers_count: 812,
        is_following_account: false,
      });
      expect(updated?.follow_checked_at?.getTime()).toBe(checkedAt.getTime());
    });

    it('recordContactEmail saves a valid email lower-cased and answers invalid otherwise', async () => {
      const contact = await liveContact();
      const record = (email: string) =>
        inJob((databaseHandle) =>
          service.recordContactEmail({
            databaseHandle,
            organizationId: organization.id,
            contactId: contact.id,
            email,
            collectedAt: minutesAgo(1),
          }),
        );

      expect(await record('not an email')).toEqual({ outcome: 'invalid' });
      const saved = await record(' Jordan.Lee@Example.com ');
      expect(saved?.outcome).toBe('saved');
      expect(saved?.outcome === 'saved' && saved.contact.email).toBe('jordan.lee@example.com');
      expect(saved?.outcome === 'saved' && saved.contact.email_collected_at).toBeInstanceOf(Date);
    });

    it('recordContactPhone normalises a valid phone and answers invalid otherwise', async () => {
      const contact = await liveContact();
      const record = (phone: string) =>
        inJob((databaseHandle) =>
          service.recordContactPhone({
            databaseHandle,
            organizationId: organization.id,
            contactId: contact.id,
            phone,
            collectedAt: minutesAgo(1),
          }),
        );

      expect(await record('12345')).toEqual({ outcome: 'invalid' });
      const saved = await record('+1 (555) 010-0123');
      expect(saved?.outcome === 'saved' && saved.contact.phone).toBe('+15550100123');
    });

    it('addContactTags appends the new tags in order and stops at 50 without failing', async () => {
      const contact = await insertContact({
        organizationId: organization.id,
        instagramAccountId: account.id,
        tags: Array.from({ length: 48 }, (_, index) => `held${index}`),
      });

      const updated = await inJob((databaseHandle) =>
        service.addContactTags({
          databaseHandle,
          organizationId: organization.id,
          contactId: contact.id,
          tags: ['held0', 'Spring, sale', 'giveaway', 'dropped'],
        }),
      );

      expect(updated?.tags).toHaveLength(50);
      expect(updated?.tags.slice(-2)).toEqual(['Spring  sale', 'giveaway']);
    });

    it('recordContactMessageSent moves last_message_sent_at forward only', async () => {
      const contact = await liveContact();
      const send = (sentAt: Date) =>
        inJob((databaseHandle) =>
          service.recordContactMessageSent({
            databaseHandle,
            organizationId: organization.id,
            contactId: contact.id,
            sentAt,
          }),
        );

      const newer = minutesAgo(1);
      await send(newer);
      const afterOlder = await send(minutesAgo(20));

      expect(afterOlder?.last_message_sent_at?.getTime()).toBe(newer.getTime());
    });

    it('every operation answers null for an erased contact, and changes nothing (CT2, CT9)', async () => {
      const contact = await liveContact();
      await service.deleteContact({ scope: scope(), contactPublicId: contact.public_id });
      const key = { organizationId: organization.id, contactId: contact.id };

      const answers = await inJob(async (databaseHandle) => [
        await service.findLiveContact({ databaseHandle, ...key }),
        await service.lockLiveContact({ databaseHandle, ...key }),
        await service.recordContactProfile({
          databaseHandle,
          ...key,
          profile: { fullName: 'Back Again' },
          checkedAt: new Date(),
        }),
        await service.recordContactEmail({
          databaseHandle,
          ...key,
          email: 'back@example.com',
          collectedAt: new Date(),
        }),
        await service.recordContactPhone({
          databaseHandle,
          ...key,
          phone: '+15550100123',
          collectedAt: new Date(),
        }),
        await service.addContactTags({ databaseHandle, ...key, tags: ['vip'] }),
        await service.recordContactMessageSent({ databaseHandle, ...key, sentAt: new Date() }),
      ]);

      expect(answers).toEqual([null, null, null, null, null, null, null]);
      expect(await readContactRow(contact.id)).toMatchObject({
        full_name: null,
        email: null,
        phone: null,
        tags: [],
      });
    });
  });

  describe('deleteContact (route 10, CT7, CT8)', () => {
    it('runs every registered erasure step with the contact, in order, before anonymising it', async () => {
      const contact = (await interact()).contact;
      const calls: string[] = [];
      erasureSteps.push(
        async (input) => {
          calls.push('first');
          expect(input).toEqual({
            organizationId: organization.id,
            contactId: contact.id,
            instagramUserId: '17841455500000001',
          });
          // The row is still live while the steps run.
          expect((await readContactRow(contact.id))?.deleted_at).toBeNull();
        },
        async () => {
          calls.push('second');
        },
      );

      const result = await service.deleteContact({
        scope: scope(),
        contactPublicId: contact.public_id,
      });

      expect(result).toEqual({ contactPublicId: contact.public_id });
      expect(calls).toEqual(['first', 'second']);
      expect((await readContactRow(contact.id))?.deleted_at).toBeInstanceOf(Date);
    });

    it('rolls the whole erase back when a step fails — the contact stays as it was', async () => {
      const contact = (await interact()).contact;
      const failingStep = vi.fn(async () => {
        throw new Error('step failed');
      });
      erasureSteps.push(failingStep);

      await expect(
        service.deleteContact({ scope: scope(), contactPublicId: contact.public_id }),
      ).rejects.toThrow('step failed');

      expect(await readContactRow(contact.id)).toMatchObject({
        deleted_at: null,
        instagram_user_id: '17841455500000001',
        username: 'jordan.lee',
      });
    });
  });

  describe('the organization purge', () => {
    it("removes the organization's contacts with it, whatever the account link (CT11)", async () => {
      await interact();
      await interact({ instagramUserId: '17841455500000002' });

      await getOperatorDatabase().execute(
        sql`DELETE FROM tenancy.organizations WHERE id = ${organization.id}`,
      );

      expect(
        await readAccountContactRows({
          organizationId: organization.id,
          instagramAccountId: account.id,
        }),
      ).toEqual([]);
    });
  });
});
