import { asc, eq } from 'drizzle-orm';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { automation_runs } from '@/domains/app/sub-domains/automation/automation-run/automation-run.schema.js';
import { automation_run_events } from '@/domains/app/sub-domains/automation/automation-run/automation-run-event.schema.js';
import { automation_comment_logs } from '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.schema.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';

/** One `app.automation_runs` row as the fixtures write and read it. */
export type AutomationRunFixtureRow = typeof automation_runs.$inferSelect;

/** One `app.automation_comment_logs` row as the fixtures write and read it. */
export type AutomationCommentLogFixtureRow = typeof automation_comment_logs.$inferSelect;

let instagramIdSequence = 0;

/** A fresh digits-only Instagram comment or post id (unique per call). */
export function nextInstagramObjectId(): string {
  instagramIdSequence += 1;
  return `1795${`${Date.now()}${instagramIdSequence}`.slice(-12).padStart(12, '0')}`;
}

/**
 * Inserts one run through the operator; every column may be overridden. The default is a `waiting`
 * DM run waiting for an email — an open run the cancel and erase steps reach.
 */
export async function insertAutomationRun({
  organizationId,
  automationId,
  contactId,
  ...overrides
}: {
  organizationId: number;
  automationId: number;
  contactId: number;
} & Partial<
  Omit<
    AutomationRunFixtureRow,
    'id' | 'organization_id' | 'automation_id' | 'contact_id' | 'ended_at'
  >
>): Promise<AutomationRunFixtureRow> {
  const now = new Date();
  const [run] = await getOperatorDatabase()
    .insert(automation_runs)
    .values({
      public_id: generatePublicId('automationRun'),
      organization_id: organizationId,
      automation_id: automationId,
      contact_id: contactId,
      trigger_type: 'dm',
      trigger_text: 'catalog please',
      status: 'waiting',
      current_step: 'email_collect',
      waiting_for: 'email',
      waiting_since_at: now,
      last_instagram_event_key: `message:fixture-${nextInstagramObjectId()}`,
      ...overrides,
    })
    .returning();
  if (run === undefined) throw new Error('automation run fixture insert returned no row');
  return run;
}

/** Appends one `status_changed` run event through the operator (the run's history, AU23). */
export async function insertAutomationRunEvent({
  organizationId,
  runId,
  status,
}: {
  organizationId: number;
  runId: number;
  status: AutomationRunFixtureRow['status'];
}): Promise<void> {
  await getOperatorDatabase().insert(automation_run_events).values({
    organization_id: organizationId,
    automation_run_id: runId,
    event_type: 'status_changed',
    status,
  });
}

/** Every run event of an organization as `<run id>:<event_type>:<status>`, read as the operator. */
export async function readRunEventsOfOrganization(organizationId: number): Promise<string[]> {
  const rows = await getOperatorDatabase()
    .select()
    .from(automation_run_events)
    .where(eq(automation_run_events.organization_id, organizationId))
    .orderBy(asc(automation_run_events.id));
  return rows.map((row) => `${row.automation_run_id}:${row.event_type}:${row.status ?? '-'}`);
}

/** Inserts one comment log through the operator; every column may be overridden. */
export async function insertAutomationCommentLog({
  organizationId,
  automationId,
  contactId,
  ...overrides
}: {
  organizationId: number;
  automationId: number;
  contactId: number;
} & Partial<
  Omit<AutomationCommentLogFixtureRow, 'id' | 'organization_id' | 'automation_id' | 'contact_id'>
>): Promise<AutomationCommentLogFixtureRow> {
  const [log] = await getOperatorDatabase()
    .insert(automation_comment_logs)
    .values({
      public_id: generatePublicId('automationCommentLog'),
      organization_id: organizationId,
      automation_id: automationId,
      contact_id: contactId,
      automation_name: 'Fixture automation',
      instagram_media_id: nextInstagramObjectId(),
      instagram_comment_id: nextInstagramObjectId(),
      comment_text: 'link please',
      commenter_username: 'jordan.lee',
      commenter_instagram_user_id: '17841400000000001',
      ...overrides,
    })
    .returning();
  if (log === undefined) throw new Error('comment log fixture insert returned no row');
  return log;
}

/** Every run of an organization, oldest first, read as the operator. */
export async function readRunRows(organizationId: number): Promise<AutomationRunFixtureRow[]> {
  return getOperatorDatabase()
    .select()
    .from(automation_runs)
    .where(eq(automation_runs.organization_id, organizationId))
    .orderBy(asc(automation_runs.id));
}

/** One run by its internal id, read as the operator. */
export async function readRunRow(runId: number): Promise<AutomationRunFixtureRow | undefined> {
  const [run] = await getOperatorDatabase()
    .select()
    .from(automation_runs)
    .where(eq(automation_runs.id, runId))
    .limit(1);
  return run;
}

/** A run's history as `<event_type>:<status>` strings, oldest first. */
export async function readRunEventTrail(runId: number): Promise<string[]> {
  const rows = await getOperatorDatabase()
    .select()
    .from(automation_run_events)
    .where(eq(automation_run_events.automation_run_id, runId))
    .orderBy(asc(automation_run_events.id));
  return rows.map((row) => `${row.event_type}:${row.status ?? '-'}`);
}

/** Every comment log of an organization, oldest first, read as the operator. */
export async function readCommentLogRows(
  organizationId: number,
): Promise<AutomationCommentLogFixtureRow[]> {
  return getOperatorDatabase()
    .select()
    .from(automation_comment_logs)
    .where(eq(automation_comment_logs.organization_id, organizationId))
    .orderBy(asc(automation_comment_logs.id));
}
