import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';

/** `GET /app/usage` (route 64). */
export const APP_USAGE_PATH = testApiPath('/app/usage');

/** `GET /app/social/instagram/accounts/{channel_account_id}/sending-status` (route 63). */
export function sendingStatusPath(channelAccountPublicId: string): string {
  return testApiPath(`/app/social/instagram/accounts/${channelAccountPublicId}/sending-status`);
}

/** One lane row as the tests read it. */
export interface TestLaneRow {
  lane: string;
  state: string;
  stop_reason: string | null;
  turn_number: string;
  working_turn: string | null;
  next_run_at: Date | null;
}

/** The account's lanes, slow first. */
export async function readLaneRows(channelAccountId: number): Promise<TestLaneRow[]> {
  return operatorQuery<TestLaneRow[]>`
    SELECT lane, state, stop_reason, turn_number::text, working_turn::text, next_run_at
    FROM app.instagram_send_lanes WHERE channel_account_id = ${channelAccountId}
    ORDER BY array_position(ARRAY['slow', 'reply', 'fast', 'broadcast']::varchar[], lane)`;
}

/** The account's stop history, oldest first. */
export async function readStopRows(
  channelAccountId: number,
): Promise<
  Array<{ lane: string; reason: string; ended_at: Date | null; ended_by: string | null }>
> {
  return operatorQuery`
    SELECT lane, reason, ended_at, ended_by FROM app.instagram_send_stops
    WHERE channel_account_id = ${channelAccountId} ORDER BY id`;
}

/** Inserts the account's four `ready` lanes through the operator, as the pick leaves them. */
export async function insertLanes({
  organizationId,
  channelAccountId,
}: {
  organizationId: number;
  channelAccountId: number;
}): Promise<void> {
  await operatorQuery`
    INSERT INTO app.instagram_send_lanes (organization_id, channel_account_id, lane)
    SELECT ${organizationId}, ${channelAccountId}, lane
    FROM unnest(ARRAY['slow', 'reply', 'fast', 'broadcast']::varchar[]) AS lane
    ON CONFLICT DO NOTHING`;
}

/** Sets this month's count of the organization (its time zone) in slot 0 to `count`. */
export async function setMonthCount({
  organizationId,
  count,
}: {
  organizationId: number;
  count: number;
}): Promise<void> {
  await operatorQuery`
    INSERT INTO app.message_month_counts (organization_id, month_start, slot, count)
    SELECT id, date_trunc('month', now() AT TIME ZONE timezone)::date, 0, ${count}
    FROM tenancy.organizations WHERE id = ${organizationId}
    ON CONFLICT (organization_id, month_start, slot) DO UPDATE SET count = excluded.count`;
}
