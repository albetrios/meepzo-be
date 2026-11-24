/**
 * Contact tag event bulk seeder — gives every seeded contact one `added` event (`source` `owner`)
 * per tag it holds (`app.contact_tag_events`, routes-final § 3.B, CTC11), as the owner's tag
 * changes would have left them: handed over and finished (`queued_at`, `done_at` set), so the
 * pick-up never starts them.
 *
 * Idempotency: a contact that already has an event is skipped, so a re-run writes nothing. No
 * reference data: tag events are tenant rows only.
 */
import { sql } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';

/**
 * Seeds the tag events of every registry organization's live contacts.
 *
 * @remarks
 * Parents read: `context.registry.organizations` and each one's live `app.contacts` rows, which
 * the contact seeder wrote just before (the contact contribution composes this one after its own).
 * Algorithm: per organization, one `INSERT … SELECT` over its live contacts' tags, skipping a
 * contact that has any event. Side effects: inserts into `app.contact_tag_events`. Failure modes:
 * warns and returns early when the registry has no organizations; otherwise propagates database
 * errors.
 */
export async function seedContactTagEventsBulk(context: SeedContext): Promise<void> {
  const organizations = context.registry.organizations;
  if (organizations.length === 0) {
    context.logger.warn(
      'seed.bulk.contact_tag_event: empty organization pool; run the tenancy seeder first',
    );
    return;
  }
  const database = getRequestDatabase();
  let created = 0;
  for (const organization of organizations) {
    const inserted = await database.execute(sql`
      INSERT INTO app.contact_tag_events
        (organization_id, channel_account_id, contact_id, tag, kind, source, queued_at, done_at)
      SELECT contacts.organization_id, contacts.channel_account_id, contacts.id, tag, 'added', 'owner',
             now(), now()
      FROM app.contacts, unnest(contacts.tags) AS tag
      WHERE contacts.organization_id = ${organization.id}
        AND contacts.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM app.contact_tag_events
          WHERE contact_tag_events.organization_id = contacts.organization_id
            AND contact_tag_events.contact_id = contacts.id
        )
      RETURNING id`);
    created += inserted.rows.length;
  }
  context.logger.info(
    { organizations: organizations.length, created },
    'seed.bulk.contact_tag_event: tag events seeded',
  );
}
