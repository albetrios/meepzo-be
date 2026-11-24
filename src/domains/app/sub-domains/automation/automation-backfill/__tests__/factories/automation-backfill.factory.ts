import { eq } from 'drizzle-orm';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { automation_backfills } from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.schema.js';

/** One `app.automation_backfills` row as the fixtures write and read it. */
export type AutomationBackfillFixtureRow = typeof automation_backfills.$inferSelect;

/** `POST /app/automations/{automation_id}/backfills` (route 38). */
export function automationBackfillsPath(automationPublicId: string): string {
  return testApiPath(`/app/automations/${automationPublicId}/backfills`);
}

/** `GET /app/automations/{automation_id}/backfills/{automation_backfill_id}` (route 39). */
export function automationBackfillPath({
  automationPublicId,
  automationBackfillPublicId,
}: {
  automationPublicId: string;
  automationBackfillPublicId: string;
}): string {
  return `${automationBackfillsPath(automationPublicId)}/${automationBackfillPublicId}`;
}

/** Inserts one read through the operator (RLS bypassed) — `queued` unless told otherwise. */
export async function insertAutomationBackfill({
  organizationId,
  channelAccountId,
  automationId,
  ...overrides
}: {
  organizationId: number;
  channelAccountId: number;
  automationId: number;
} & Partial<typeof automation_backfills.$inferInsert>): Promise<AutomationBackfillFixtureRow> {
  const [row] = await getOperatorDatabase()
    .insert(automation_backfills)
    .values({
      public_id: generatePublicId('automationBackfill'),
      organization_id: organizationId,
      channel_account_id: channelAccountId,
      automation_id: automationId,
      days: 3,
      ...overrides,
    })
    .returning();
  if (row === undefined) throw new Error('automation backfill fixture insert returned no row');
  return row;
}

/** Every read of one automation, as the operator sees them, oldest first. */
export async function readAutomationBackfillRows(
  automationId: number,
): Promise<AutomationBackfillFixtureRow[]> {
  return getOperatorDatabase()
    .select()
    .from(automation_backfills)
    .where(eq(automation_backfills.automation_id, automationId))
    .orderBy(automation_backfills.id);
}
