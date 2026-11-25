import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepairDutyContext } from '@/infrastructure/queue/worker-runtime/repair-duty.util.js';
import type { ContactTagEventIntakeJobInput } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.types.js';
import { runContactTagEventPickupDuty } from '@/domains/app/sub-domains/contact/contact-tag-event/workers/contact-tag-event-pickup.processor.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The tag events' pick-up against the database (feat-instagram-dm-sending § 3.B, WC-27 — ROUTE row
 * R47; R11's `idx_contact_tag_events_pickup`): an event not handed over after a minute goes to
 * intake, one handed over an hour ago and not done (under a day old) goes again, a fresh, a done or
 * a recently handed one stays — and a second run right after changes nothing. The read runs under
 * the global-retention arm, the stamp in the organization's job scope.
 */
describe('runContactTagEventPickupDuty (database)', () => {
  let organization: { id: number; public_id: string };
  let account: { id: number; channel_account_id: number };
  let handed: ContactTagEventIntakeJobInput[];

  const context = (): RepairDutyContext => ({ now: new Date(), isBudgetSpent: () => false });
  const intakeQueue = {
    enqueueContactTagEventIntake: async (input: ContactTagEventIntakeJobInput) => {
      handed.push(input);
    },
  };

  async function insertEvent({
    contactId,
    createdAgo,
    queuedAgo,
    isDone = false,
  }: {
    contactId: number;
    createdAgo: string;
    queuedAgo: string | null;
    isDone?: boolean;
  }) {
    await operatorQuery`
      INSERT INTO app.contact_tag_events (organization_id, channel_account_id, contact_id, tag, kind,
        source, chain_number, created_at, queued_at, done_at)
      VALUES (${organization.id}, ${account.channel_account_id}, ${contactId}, 'lead', 'added',
        'owner', 0, now() - ${createdAgo}::interval,
        CASE WHEN ${queuedAgo}::text IS NULL THEN NULL ELSE now() - ${queuedAgo}::interval END,
        CASE WHEN ${isDone} THEN now() ELSE NULL END)`;
  }

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    handed = [];
  });

  it('hands over the events intake never got and the stale ones, once (WC-27)', async () => {
    const contact = () =>
      insertContact({ organizationId: organization.id, instagramAccountId: account.id });
    const lost = await contact();
    const stale = await contact();
    const fresh = await contact();
    const recent = await contact();
    const done = await contact();
    const tooOld = await contact();
    await insertEvent({ contactId: lost.id, createdAgo: '5 minutes', queuedAgo: null });
    await insertEvent({ contactId: stale.id, createdAgo: '3 hours', queuedAgo: '2 hours' });
    await insertEvent({ contactId: fresh.id, createdAgo: '10 seconds', queuedAgo: null });
    await insertEvent({ contactId: recent.id, createdAgo: '30 minutes', queuedAgo: '20 minutes' });
    await insertEvent({
      contactId: done.id,
      createdAgo: '5 minutes',
      queuedAgo: null,
      isDone: true,
    });
    await insertEvent({ contactId: tooOld.id, createdAgo: '2 days', queuedAgo: '2 days' });

    expect((await runContactTagEventPickupDuty({ context: context(), intakeQueue })).done).toBe(2);
    expect(handed).toEqual([
      {
        organizationPublicId: organization.public_id,
        contactPublicIds: [lost.public_id, stale.public_id],
      },
    ]);

    expect((await runContactTagEventPickupDuty({ context: context(), intakeQueue })).done).toBe(0);
    expect(handed).toHaveLength(1);
  });
});
