import { asc, eq } from 'drizzle-orm';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { instagram_outgoing_messages } from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/instagram-outgoing-message.schema.js';
import { instagram_send_attempts } from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/instagram-send-attempt.schema.js';
import type { AutomationRunFixtureRow } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';

/** One `app.instagram_outgoing_messages` row as the fixtures read it. */
export type InstagramOutgoingMessageFixtureRow = typeof instagram_outgoing_messages.$inferSelect;

/** One `app.instagram_send_attempts` row as the fixtures read it. */
export type InstagramSendAttemptFixtureRow = typeof instagram_send_attempts.$inferSelect;

/**
 * Inserts one message of a run through the operator (feat-instagram-dm-sending § 6.B.3); the default
 * is a `failed` list message 1 sent direct in the fast lane, made now — every column may be
 * overridden.
 */
export async function insertInstagramOutgoingMessage({
  run,
  channelAccountId,
  ...overrides
}: {
  run: AutomationRunFixtureRow;
  channelAccountId: number;
} & Partial<
  Omit<
    InstagramOutgoingMessageFixtureRow,
    'id' | 'organization_id' | 'automation_run_id' | 'automation_run_started_at'
  >
>): Promise<InstagramOutgoingMessageFixtureRow> {
  const [row] = await getOperatorDatabase()
    .insert(instagram_outgoing_messages)
    .values({
      public_id: generatePublicId('instagramMessage'),
      organization_id: run.organization_id,
      channel_account_id: channelAccountId,
      automation_id: run.automation_id,
      automation_run_id: run.id,
      automation_run_started_at: run.started_at,
      contact_id: run.contact_id,
      message_type: 'message',
      message_number: 1,
      message_kind: 'text',
      lane: 'fast',
      channel: 'direct',
      is_counted_as_direct_message: true,
      status: 'failed',
      reason: 'bad_text',
      not_before: new Date(),
      trigger_occurred_at: run.trigger_occurred_at,
      ...overrides,
    })
    .returning();
  if (row === undefined) throw new Error('instagram message fixture insert returned no row');
  return row;
}

/** Every message of an organization, oldest first, read as the operator. */
export async function readInstagramOutgoingMessages(
  organizationId: number,
): Promise<InstagramOutgoingMessageFixtureRow[]> {
  return getOperatorDatabase()
    .select()
    .from(instagram_outgoing_messages)
    .where(eq(instagram_outgoing_messages.organization_id, organizationId))
    .orderBy(asc(instagram_outgoing_messages.id));
}

/** Every send attempt of an organization, oldest first, read as the operator. */
export async function readInstagramSendAttempts(
  organizationId: number,
): Promise<InstagramSendAttemptFixtureRow[]> {
  return getOperatorDatabase()
    .select()
    .from(instagram_send_attempts)
    .where(eq(instagram_send_attempts.organization_id, organizationId))
    .orderBy(asc(instagram_send_attempts.id));
}
