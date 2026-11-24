import { and, eq, inArray } from 'drizzle-orm';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

/** `GET` / `POST /app/automations` (routes 11–12). */
export const AUTOMATIONS_PATH = testApiPath('/app/automations');

/** `GET` / `PATCH` / `DELETE /app/automations/{automation_id}` (routes 13–15). */
export function automationPath(automationPublicId: string): string {
  return `${AUTOMATIONS_PATH}/${automationPublicId}`;
}

/** One `app.automations` row as the fixtures write and read it. */
export type AutomationFixtureRow = typeof automations.$inferSelect;

/** The smallest complete comment automation body (route 12): the opening button and the final message. */
export function commentAutomationBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'Comment for the link',
    trigger_type: 'comment',
    opening_message: { text: 'Thanks for your comment!', button_title: 'Send it' },
    final_message: {
      text: 'Here you go',
      links: [{ title: 'Shop', url: 'https://shop.example.com' }],
    },
    ...overrides,
  };
}

/**
 * Inserts one live automation through the operator; every column may be overridden. The default
 * is an inactive comment automation on any post with its opening button and final message — a
 * complete flow the table's checks accept.
 */
export async function insertAutomation({
  organizationId,
  instagramAccountId,
  ...overrides
}: {
  organizationId: number;
  instagramAccountId: number;
} & Partial<
  Omit<AutomationFixtureRow, 'id' | 'organization_id' | 'instagram_account_id'>
>): Promise<AutomationFixtureRow> {
  const [automation] = await getOperatorDatabase()
    .insert(automations)
    .values({
      public_id: generatePublicId('automation'),
      organization_id: organizationId,
      instagram_account_id: instagramAccountId,
      name: 'Fixture automation',
      trigger_type: 'comment',
      opening_message: { text: 'Hi there', button_title: 'Send it' },
      final_message: { text: 'Here you go', links: [] },
      ...overrides,
    })
    .returning();
  if (automation === undefined) throw new Error('automation fixture insert returned no row');
  return automation;
}

/** One automation row by its public id, read as the operator (deleted rows included). */
export async function readAutomationRow(
  automationPublicId: string,
): Promise<AutomationFixtureRow | undefined> {
  const rows = await getOperatorDatabase()
    .select()
    .from(automations)
    .where(eq(automations.public_id, automationPublicId))
    .limit(1);
  return rows[0];
}

/** Revokes an organization's Instagram account through the operator, as a disconnect leaves it. */
export async function revokeInstagramAccount({
  organizationId,
  instagramAccountId,
}: {
  organizationId: number;
  instagramAccountId: number;
}): Promise<void> {
  // The status is the channel account's since R6 (2.A.3).
  const channelAccountIdOf = getOperatorDatabase()
    .select({ id: instagram_accounts.channel_account_id })
    .from(instagram_accounts)
    .where(
      and(
        eq(instagram_accounts.organization_id, organizationId),
        eq(instagram_accounts.id, instagramAccountId),
      ),
    );
  await getOperatorDatabase()
    .update(channel_accounts)
    .set({ connection_status: 'revoked', disconnected_at: new Date() })
    .where(
      and(
        eq(channel_accounts.organization_id, organizationId),
        inArray(channel_accounts.id, channelAccountIdOf),
      ),
    );
}
