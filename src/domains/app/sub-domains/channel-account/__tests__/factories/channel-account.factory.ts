import { eq } from 'drizzle-orm';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { insertChannelConnection } from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

/** `GET /app/social/channel-accounts` (route 6). */
export const CHANNEL_ACCOUNTS_PATH = testApiPath('/app/social/channel-accounts');

/** `GET` / `DELETE /app/social/channel-accounts/{channel_account_id}` (routes 7, 8). */
export function channelAccountPath(channelAccountPublicId: string): string {
  return `${CHANNEL_ACCOUNTS_PATH}/${channelAccountPublicId}`;
}

/** `POST …/{channel_account_id}/pause|resume|activate` (routes 9–11). */
export function channelAccountActionPath({
  channelAccountPublicId,
  action,
}: {
  channelAccountPublicId: string;
  action: 'pause' | 'resume' | 'activate';
}): string {
  return `${channelAccountPath(channelAccountPublicId)}/${action}`;
}

/**
 * Inserts a channel account through the operator, as a pick leaves it — for tests that seed an
 * Instagram account directly (its `channel_account_id`). Makes a connected Meta connection when none
 * is given; a repeat for the same provider account reuses the row. Returns the account's internal
 * and public ids and its connection's internal id.
 */
export async function insertChannelAccount({
  organizationId,
  providerAccountId,
  channelConnectionId,
  connectionStatus = 'connected',
  displayName = `@account_${providerAccountId.slice(-6)}`,
  planStopReason = null,
}: {
  organizationId: number;
  providerAccountId: string;
  channelConnectionId?: number;
  connectionStatus?: 'connected' | 'error' | 'revoked';
  displayName?: string;
  planStopReason?: 'plan_limit' | 'plan_ended' | 'plan_downgrade' | null;
}): Promise<{ id: number; public_id: string; channel_connection_id: number }> {
  const connectionId =
    channelConnectionId ?? (await insertChannelConnection({ organizationId })).id;
  const [account] = await getOperatorDatabase()
    .insert(channel_accounts)
    .values({
      public_id: generatePublicId('channelAccount'),
      organization_id: organizationId,
      channel: 'instagram',
      channel_connection_id: connectionId,
      provider_account_id: providerAccountId,
      display_name: displayName,
      connection_status: connectionStatus,
      disconnected_at: connectionStatus === 'revoked' ? new Date() : null,
      plan_stop_reason: planStopReason,
      plan_stopped_at: planStopReason === null ? null : new Date(),
    })
    // A repeat for the same provider account (a reconnect in a test) reuses the row, as the pick does.
    .onConflictDoUpdate({
      target: [
        channel_accounts.organization_id,
        channel_accounts.channel,
        channel_accounts.provider_account_id,
      ],
      set: { channel_connection_id: connectionId },
    })
    .returning({
      id: channel_accounts.id,
      public_id: channel_accounts.public_id,
      channel_connection_id: channel_accounts.channel_connection_id,
    });
  if (account === undefined) throw new Error('channel account fixture insert returned no row');
  return account;
}

/** An organization's channel account rows — read as the operator. */
export async function readChannelAccountRows(organizationId: number) {
  return getOperatorDatabase()
    .select()
    .from(channel_accounts)
    .where(eq(channel_accounts.organization_id, organizationId))
    .orderBy(channel_accounts.id);
}

/**
 * The route-7 path of the organization's oldest not-revoked channel account — or, when every one is
 * revoked, of its newest one (so a repeated disconnect answers `404`). The launch's singular
 * `/social/instagram/account` routes moved here at R5 (CA2); suites that address "the organization's
 * account" use this.
 */
export async function organizationChannelAccountPath(organizationId: number): Promise<string> {
  const rows = await getOperatorDatabase()
    .select({
      public_id: channel_accounts.public_id,
      connection_status: channel_accounts.connection_status,
    })
    .from(channel_accounts)
    .where(eq(channel_accounts.organization_id, organizationId))
    .orderBy(channel_accounts.connected_at, channel_accounts.id);
  const live = rows.find((row) => row.connection_status !== 'revoked');
  const chosen = live ?? rows.at(-1);
  if (chosen === undefined) return channelAccountPath(`cha_${'0'.repeat(21)}`);
  return channelAccountPath(chosen.public_id);
}
