import { ConflictError } from '@/shared/errors/index.js';
import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { SubscriptionRepository } from './subscription.repository.js';
import type { TrialAccountRepository } from './trial-account.repository.js';

/**
 * `409 trial_already_used` — the organization, or one of its Instagram accounts, already had a trial (BL7).
 *
 * @remarks
 * Thrown by route 102's checks and its create commit; detail `errors:trialAlreadyUsed`.
 */
export function trialAlreadyUsedError(): ConflictError {
  return new ConflictError('errors:trialAlreadyUsed').withReason('trial_already_used');
}

/**
 * `409 trial_used_by_account` — an account picked during a trial already had one elsewhere (MC7, BL7).
 *
 * @remarks
 * Thrown through the trial port inside the pick's unit, so nothing of the pick is kept; detail
 * `errors:trialUsedByAccount`.
 */
export function trialUsedByAccountError(): ConflictError {
  return new ConflictError('errors:trialUsedByAccount').withReason('trial_used_by_account');
}

/**
 * The one-trial rules of the 7-day no-card trial (feat-instagram-dm-sending routes-final § 8 BL7,
 * § 8.B BL14, BL18): an organization trials once, and an Instagram account trials once, ever, in any
 * organization — over `billing.trial_accounts`. Also the trial port billing implements for the app's
 * pick (sub-domain 1, `ChannelConnectionTrialPort`, § 8.10).
 *
 * @remarks
 * - **Algorithm:** the "had a trial" checks read the organization's subscription rows (`trial_end`
 *   set — rows are never deleted) and, across organizations, the `SECURITY DEFINER` resolver of
 *   `billing.trial_accounts`; the writes insert one row per account in the caller's unit of work, and
 *   the unique `instagram_user_id` is the final guard (a lost race writes fewer rows → `409`).
 * - **Failure modes:** `409 trial_already_used` (route 102) and `409 trial_used_by_account` (the
 *   pick); a query failure propagates. A thrown `409` rolls the caller's unit back, so nothing is kept.
 * - **Side effects:** inserts `billing.trial_accounts` rows; reads only otherwise.
 * - **Notes:** every method runs inside the caller's organization database context (route 102's
 *   create units, the pick's commit) — none opens its own.
 */
export class SubscriptionTrialService {
  constructor(
    private readonly trialAccountRepository: TrialAccountRepository,
    private readonly subscriptionRepository: SubscriptionRepository,
  ) {}

  /**
   * Route 102 before Stripe (BL7): `409 trial_already_used` when the organization ever had a trial or
   * one of these Instagram accounts had one anywhere.
   */
  async assertOrganizationMayTrial({
    organizationId,
    instagramUserIds,
  }: {
    organizationId: number;
    instagramUserIds: readonly string[];
  }): Promise<void> {
    if (await this.subscriptionRepository.hasOrganizationTrialled(organizationId)) {
      throw trialAlreadyUsedError();
    }
    const trialled =
      await this.trialAccountRepository.findTrialledInstagramUserIds(instagramUserIds);
    if (trialled.length > 0) throw trialAlreadyUsedError();
  }

  /**
   * Route 102's create commit (BL14): one row per not-revoked account of the trialing subscription.
   * An account another organization recorded meanwhile → `409 trial_already_used` (the caller's unit
   * rolls back and the Stripe subscription is compensated).
   */
  async recordTrialStart({
    organizationId,
    planId,
    subscriptionId,
    instagramUserIds,
  }: {
    organizationId: number;
    planId: number;
    subscriptionId: number;
    instagramUserIds: readonly string[];
  }): Promise<void> {
    const written = await this.trialAccountRepository.insertMany({
      organizationId,
      planId,
      subscriptionId,
      instagramUserIds,
    });
    if (written < instagramUserIds.length) throw trialAlreadyUsedError();
  }

  /** Trial port (MC7): `409 trial_used_by_account` when one of these provider ids already had a trial. */
  async assertAccountsMayTrial({
    providerAccountIds,
  }: {
    providerAccountIds: readonly string[];
  }): Promise<void> {
    const trialled =
      await this.trialAccountRepository.findTrialledInstagramUserIds(providerAccountIds);
    if (trialled.length > 0) throw trialUsedByAccountError();
  }

  /**
   * Trial port (MC7): records the picked accounts' trial rows in the pick's unit, against the
   * organization's trialing subscription. No trialing subscription (the trial ended meanwhile) → no
   * row. A row another organization wrote meanwhile → `409 trial_used_by_account`.
   */
  async recordTrialAccounts({
    organizationId,
    providerAccountIds,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    providerAccountIds: readonly string[];
  }): Promise<void> {
    const subscription = await this.subscriptionRepository.findActiveByOrganization(organizationId);
    if (subscription?.status !== 'TRIALING') return;
    const written = await this.trialAccountRepository.insertMany({
      organizationId,
      planId: subscription.plan_id,
      subscriptionId: subscription.id,
      instagramUserIds: providerAccountIds,
    });
    if (written < providerAccountIds.length) throw trialUsedByAccountError();
  }
}
