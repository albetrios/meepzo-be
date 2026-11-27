import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import { limit } from '@/domains/billing/sub-domains/entitlement/entitlement-snapshot.util.js';
import type { EntitlementService } from '@/domains/billing/sub-domains/entitlement/entitlement.service.js';
import type { EntitlementSnapshot } from '@/domains/billing/sub-domains/entitlement/entitlement.types.js';
import { CHANNEL_ACCOUNTS_MAX_WITHOUT_PLAN } from '@/domains/app/sub-domains/channel-connection/channel-connection.constants.js';

/**
 * The one plan read the app's services take their switches and limits from (change-plan-gates AP1,
 * K3): billing's entitlement module.
 *
 * @remarks
 * Notes: structural, so a test can stub it; billing's `EntitlementService` satisfies it.
 */
export type ChannelAccountEntitlementService = Pick<EntitlementService, 'resolve'>;

/**
 * The organization's entitlement snapshot for one request or job (change-plan-gates AP1, P24, K2):
 * the one the caller already holds, else one resolve.
 *
 * @remarks
 * - **Algorithm:** `entitlement` when given (the route guard's `request.entitlementSnapshot`, or a
 *   snapshot an earlier step of the same unit resolved); otherwise exactly one
 *   `EntitlementService.resolve` for the scope's organization.
 * - **Failure modes:** a plan read failure propagates.
 * - **Side effects:** none — read-only.
 * - **Notes:** a caller with several plan gates calls it once and passes the snapshot on, so a
 *   request or job reads the plan once.
 */
export async function readEntitlementSnapshot({
  entitlementService,
  scope,
  entitlement,
}: {
  entitlementService: ChannelAccountEntitlementService;
  scope: OrganizationPrincipalDatabaseScope;
  entitlement?: EntitlementSnapshot | undefined;
}): Promise<EntitlementSnapshot> {
  return (
    entitlement ??
    (await entitlementService.resolve({ organizationPublicId: scope.organizationPublicId }))
  );
}

/**
 * The plan's `channel_accounts_max` from a snapshot (change-plan-gates AP4, P39): the limit, or
 * Free's 1 ({@link CHANNEL_ACCOUNTS_MAX_WITHOUT_PLAN}) when it reads `null` — no plan in the
 * catalog, exactly as the app answered before the module.
 *
 * @remarks
 * Pure; reads `limit('channel_accounts_max')`. The counter's owner keeps its lock and count (K4).
 */
export function readChannelAccountsMax(entitlement: EntitlementSnapshot): number {
  return (
    limit({ snapshot: entitlement, key: 'channel_accounts_max' }) ??
    CHANNEL_ACCOUNTS_MAX_WITHOUT_PLAN
  );
}
