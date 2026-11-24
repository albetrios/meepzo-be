import { and, desc, eq, isNull } from 'drizzle-orm';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { membership_invitations } from '@/domains/tenancy/sub-domains/membership/membership-invitation/membership-invitation.schema.js';

/**
 * The first line of a `POST /tenancy/organization/memberships` answer (route 117,
 * feat-instagram-dm-sending TN10) — the invite of one email most tests send.
 */
export interface MembershipInviteTestLine {
  email: string;
  result: string;
  membership_id: string | null;
  debug_invitation_token?: string;
}

/**
 * Reads the first line of an invite answer (`data.results[0]`); throws when the answer has none, so a
 * test fails on the shape instead of on an `undefined` further down.
 */
export function firstInviteLine(response: { json(): unknown }): MembershipInviteTestLine {
  const body = response.json() as { data?: { results?: MembershipInviteTestLine[] } };
  const line = body.data?.results?.[0];
  if (!line) throw new Error(`invite answer without results: ${JSON.stringify(body)}`);
  return line;
}

/**
 * The membership public id (`mem_…`) an invite of one email created — the first line's
 * `membership_id`; throws when that line was not `invited`.
 */
export function invitedMembershipPublicId(response: { json(): unknown }): string {
  const line = firstInviteLine(response);
  if (line.result !== 'invited' || line.membership_id === null) {
    throw new Error(`invite line was ${line.result}, not invited`);
  }
  return line.membership_id;
}

/**
 * The public id (`inv_…`) of a membership's pending invitation (not accepted, not revoked) — the
 * invite answer names the membership only, so tests that accept or decline read it here.
 */
export async function pendingInvitationPublicId(membershipPublicId: string): Promise<string> {
  const [row] = await getOperatorDatabase()
    .select({ public_id: membership_invitations.public_id })
    .from(membership_invitations)
    .innerJoin(memberships, eq(memberships.id, membership_invitations.membership_id))
    .where(
      and(
        eq(memberships.public_id, membershipPublicId),
        isNull(membership_invitations.accepted_at),
        isNull(membership_invitations.revoked_at),
      ),
    )
    .orderBy(desc(membership_invitations.created_at))
    .limit(1);
  if (!row) throw new Error(`no pending invitation for ${membershipPublicId}`);
  return row.public_id;
}
