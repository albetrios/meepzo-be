import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Pieces of 2 instead of 500, so a handful of contacts spans several pieces (WC-36).
vi.mock('@/domains/app/sub-domains/contact/contact.constants.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CONTACT_BULK_ACTION_PIECE_SIZE: 2,
}));

import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import { contact_tag_counts } from '@/domains/app/sub-domains/contact/contact-tag-count.schema.js';
import type {
  ContactPauseStepInput,
  ContactTagChangeEvent,
} from '@/domains/app/sub-domains/contact/contact.types.js';
import {
  type ContactBulkActionTaskInput,
  contactBulkActionJobId,
  contactBulkActionTaskInputSchema,
} from '@/domains/app/sub-domains/contact/queues/contact-bulk-action.job.schema.js';
import { runContactBulkActionPiece } from '@/domains/app/sub-domains/contact/workers/contact-bulk-action.processor.js';
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
 * The bulk contact change (routes-final § 3.A CT7, CTC7; WC-36, P66 — ROUTE row R46): the
 * `contact-bulk-action` task works the selection in pieces, one commit each, chaining the next
 * piece; each contact changes as on route 20 (the tag count, one tag event, the pause steps) and a
 * re-run writes nothing twice. Every statement runs in the job's organization scope, so the suite
 * also holds under `pnpm test:rls-role`.
 */
describe('contact-bulk-action task (database, AC-5.6)', () => {
  let organization: { id: number; public_id: string; type: string };
  let account: { id: number; public_id: string; channel_account_id: number };
  let service: ContactService;
  let events: ContactTagChangeEvent[];
  let pauses: ContactPauseStepInput[];

  beforeEach(async () => {
    await cleanupDatabase();
    const owner = await createTestUser();
    organization = await createTestOrganization({ ownerUserId: owner.id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    events = [];
    pauses = [];
    const organizationService = {
      requireOrganizationByPublicId: async () => organization,
      resolveUserInternalIdByPublicId: async () => owner.id,
    } as unknown as OrganizationService;
    service = new ContactService(
      new ContactRepository(),
      organizationService,
      [],
      async () => null,
      {
        tagEventRecorder: {
          recordContactTagEvents: async ({ events: recorded }) => {
            events.push(...recorded);
          },
        },
        pauseSteps: [
          async (input) => {
            pauses.push(input);
          },
        ],
      },
    );
  });

  const slot = <T>(callback: () => Promise<T>) => callback();

  /** Runs the chain from `first` to its last piece, as the queue would; answers the jobs it added. */
  async function runChain(first: ContactBulkActionTaskInput): Promise<string[]> {
    const jobIds: string[] = [];
    let next: ContactBulkActionTaskInput | null = contactBulkActionTaskInputSchema.parse(first);
    while (next !== null) {
      const current: ContactBulkActionTaskInput = next;
      next = null;
      await runContactBulkActionPiece({
        contactService: service,
        organizationPublicId: organization.public_id,
        taskInput: current,
        runInDatabaseSlot: slot,
        enqueuePiece: async ({ taskInput }) => {
          jobIds.push(contactBulkActionJobId(taskInput));
          next = contactBulkActionTaskInputSchema.parse(JSON.parse(JSON.stringify(taskInput)));
        },
      });
    }
    return jobIds;
  }

  function firstPiece(overrides: Partial<ContactBulkActionTaskInput>): ContactBulkActionTaskInput {
    return {
      bulkActionToken: 'aaaaaaaabbbbbbbb',
      pieceNumber: 1,
      channelAccountPublicId: account.public_id,
      action: 'add_tag',
      tag: 'vip',
      contactPublicIds: null,
      filter: { tags: [], cameInVia: [] },
      actorUserPublicId: '',
      afterContactPublicId: null,
      ...overrides,
    };
  }

  async function readTagCount(tag: string): Promise<number | undefined> {
    const [row] = await getOperatorDatabase()
      .select({ count: contact_tag_counts.contact_count })
      .from(contact_tag_counts)
      .where(
        and(
          eq(contact_tag_counts.organization_id, organization.id),
          eq(contact_tag_counts.channel_account_id, account.channel_account_id),
          eq(contact_tag_counts.tag, tag),
        ),
      );
    return row?.count;
  }

  it('adds a tag to every match of the filter in pieces, chaining each next piece; a re-run writes nothing twice', async () => {
    const leads = await Promise.all(
      Array.from({ length: 5 }, () =>
        insertContact({
          organizationId: organization.id,
          instagramAccountId: account.id,
          tags: ['lead'],
        }),
      ),
    );
    const other = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      tags: ['other'],
    });

    const jobIds = await runChain(firstPiece({ filter: { tags: ['lead'], cameInVia: [] } }));

    // 5 matches in pieces of 2: pieces 2 and 3 were chained (the third is the short, last one).
    expect(jobIds).toEqual(['contact-bulk-aaaaaaaabbbbbbbb-2', 'contact-bulk-aaaaaaaabbbbbbbb-3']);
    for (const lead of leads) {
      expect((await readContactRow(lead.id))?.tags).toEqual(['lead', 'vip']);
    }
    expect((await readContactRow(other.id))?.tags).toEqual(['other']);
    expect(await readTagCount('vip')).toBe(5);
    expect(events).toHaveLength(5);
    expect(events.every((event) => event.kind === 'added' && event.source === 'owner')).toBe(true);

    // A re-run (a replayed piece or the whole chain again) finds the tag in place.
    await runChain(firstPiece({ filter: { tags: ['lead'], cameInVia: [] } }));
    expect(await readTagCount('vip')).toBe(5);
    expect(events).toHaveLength(5);
  });

  it('pauses the named contacts once, runs the pause steps, and resumes them (one piece for named ids)', async () => {
    const first = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    const second = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    const third = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    const named = [first.public_id, second.public_id, third.public_id];

    const pausedJobs = await runChain(
      firstPiece({ action: 'pause_automations', tag: null, contactPublicIds: named, filter: null }),
    );
    // Named ids are at most 500 — one piece; with pieces of 2 here, the rest waits for the next press.
    expect(pausedJobs).toEqual([]);
    const paused = await Promise.all(
      [first, second, third].map((contact) => readContactRow(contact.id)),
    );
    expect(paused.filter((row) => row?.automations_off_at !== null)).toHaveLength(2);
    expect(pauses).toHaveLength(2);
    expect(pauses.every((input) => input.reason === 'contact_excluded')).toBe(true);

    await runChain(
      firstPiece({ action: 'pause_automations', tag: null, contactPublicIds: named, filter: null }),
    );
    expect(pauses).toHaveLength(2);

    await runChain(
      firstPiece({
        action: 'resume_automations',
        tag: null,
        contactPublicIds: named,
        filter: null,
      }),
    );
    expect((await readContactRow(first.id))?.automations_off_at).toBeNull();
    expect((await readContactRow(first.id))?.automations_off_by_user_id).toBeNull();
  });

  it('removes a tag and moves the count down; an account no longer found is an empty last piece', async () => {
    await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      tags: ['vip'],
    });
    await getOperatorDatabase().insert(contact_tag_counts).values({
      organization_id: organization.id,
      channel_account_id: account.channel_account_id,
      tag: 'vip',
      contact_count: 1,
    });

    await runChain(firstPiece({ action: 'remove_tag' }));
    expect(await readTagCount('vip')).toBeUndefined();
    expect(events.map((event) => event.kind)).toEqual(['removed']);

    expect(
      await runChain(firstPiece({ channelAccountPublicId: 'cha_zzzzzzzzzzzzzzzzzzzzz' })),
    ).toEqual([]);
  });
});
