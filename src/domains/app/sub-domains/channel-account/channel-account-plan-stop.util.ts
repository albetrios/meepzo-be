import { CHANNEL_ACCOUNT_PLAN_STOP_REASON } from './channel-account.constants.js';
import type { ChannelAccountRow } from './channel-account.repository.js';

/**
 * Which of the organization's live accounts stay in its plan after a plan change (WC-38, BL6, D57 —
 * ROUTE row R52): the internal ids, at most `accountsMax`.
 *
 * @remarks
 * - **Algorithm:** candidates in order — the accounts the owner kept (in connection order), then
 *   the other accounts in the plan now (oldest connected first), then, on a move up
 *   (`mayActivate`), the "not in your plan" ones (oldest connected first); the first `accountsMax`
 *   stay. So a move down with no pick keeps the oldest connected, a kept account disconnected
 *   meanwhile is skipped and the next oldest fills its place, a move up clears `plan_downgrade` up
 *   to the new limit, and a run with nothing to change keeps every account where it is.
 * - **Failure modes:** none — pure.
 * - **Side effects:** none.
 * - **Notes:** `live` must be the organization's not-revoked accounts, oldest connected first
 *   (`ChannelAccountRepository.listLive`).
 */
export function pickChannelAccountsInPlan({
  live,
  accountsMax,
  keptChannelAccountPublicIds,
  mayActivate,
}: {
  live: readonly Pick<ChannelAccountRow, 'id' | 'public_id' | 'plan_stop_reason'>[];
  accountsMax: number;
  keptChannelAccountPublicIds: readonly string[] | null;
  mayActivate: boolean;
}): Set<number> {
  const kept = new Set(keptChannelAccountPublicIds ?? []);
  const isInPlanNow = (account: (typeof live)[number]) =>
    account.plan_stop_reason !== CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_DOWNGRADE;
  const ordered = [
    ...live.filter((account) => kept.has(account.public_id)),
    ...live.filter((account) => !kept.has(account.public_id) && isInPlanNow(account)),
    ...(mayActivate
      ? live.filter((account) => !(kept.has(account.public_id) || isInPlanNow(account)))
      : []),
  ];
  return new Set(ordered.slice(0, Math.max(accountsMax, 0)).map((account) => account.id));
}
