import i18next from 'i18next';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import {
  runGlobalRetentionWorkerJob,
  runOrganizationScopedWorkerJob,
} from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import type { NotificationService } from '@/domains/notify/sub-domains/notification/notification.service.js';
import type { MembershipService } from '@/domains/tenancy/sub-domains/membership/membership.service.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import { env } from '@/shared/config/env.config.js';
import { DEFAULT_FRONTEND_URL } from '@/shared/constants/index.js';
import type { NotificationType } from '@/shared/constants/notification.constants.js';
import type { SupportedLanguage } from '@/shared/constants/i18n.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { withoutTrailingSlashes } from '@/shared/utils/text/trailing-slash.util.js';
import { BILLING_PERMISSIONS } from '@/domains/billing/billing.permissions.js';
import { PLAN_STATE_CHANGE } from '@/domains/billing/sub-domains/subscription/events/subscription.events.js';
import {
  createRetentionSubscriptionRepository,
  createWorkerSubscriptionRepository,
} from '@/domains/billing/sub-domains/subscription/subscription.repository.js';
import type { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import {
  PLAN_STATE_CHECK_GRACE_END_LOOKBACK_DAYS,
  TRIAL_NOTICE_DAYS,
} from '@/domains/billing/sub-domains/subscription/subscription.constants.js';
import {
  type PlanStateCheckFinding,
  buildPlanChoiceDedupeKey,
  buildTrialEndingDedupeKey,
  decidePlanStateCheckFindings,
} from '@/domains/billing/sub-domains/subscription/subscription-plan-state.util.js';
import type { SubscriptionPlanStateCheckJobData } from '@/domains/billing/sub-domains/subscription/queues/subscription-plan-state-check.job.schema.js';
import { enqueueSubscriptionPlanStateChecks } from '@/domains/billing/sub-domains/subscription/queues/subscription-plan-state-check.queue.js';
import {
  BILLING_FRONTEND_PATH,
  SUBSCRIPTION_PLAN_STATE_CHECK_SWEEP_MAX_PAGES,
  SUBSCRIPTION_PLAN_STATE_CHECK_SWEEP_PAGE_SIZE,
} from './subscription-plan-state-check.constants.js';

/**
 * The services the plan-state check drives (BL17, BL24 — WC-59): billing's emitter of the check's
 * findings, and the notice path — notify's once-only organization notifications, the billing
 * recipients (tenancy's membership read) and the organization's language.
 *
 * @remarks
 * - **Algorithm:** structural picks, so the processor depends only on the methods it calls.
 * - **Failure modes:** none — type only.
 * - **Side effects:** none on this type.
 * - **Notes:** supplied by the worker composition root (`billingDomain`, `notifyDomain`,
 *   `tenancyDomain`), never built here.
 */
export interface SubscriptionPlanStateCheckServices {
  subscriptionService: Pick<SubscriptionService, 'emitPlanStateCheckFinding'>;
  notificationService: Pick<NotificationService, 'createOrganizationNotifications'>;
  membershipService: Pick<MembershipService, 'findActiveUserIdsWithPermission'>;
  organizationSettingsService: Pick<
    OrganizationSettingsService,
    'resolveDefaultLocaleForOrganization'
  >;
}

/**
 * What one subscription's check did.
 *
 * @remarks
 * - **Algorithm:** `skipped` — the subscription or its organization is gone; `checked` — the
 *   findings, each with what it did: `emitted` (the event went out), `sent` / `deduplicated` (the
 *   notice), `no_recipients`.
 * - **Failure modes:** none — a return shape (Bull Board shows it).
 * - **Side effects:** none.
 * - **Notes:** logged as `billing.plan_state_check.completed`.
 */
export type SubscriptionPlanStateCheckResult =
  | { outcome: 'skipped'; reason: 'subscription_missing' }
  | {
      outcome: 'checked';
      findings: { kind: PlanStateCheckFinding['kind']; did: string }[];
    };

/** The billing page link of every billing notice. */
function billingActionUrl(): string {
  return `${withoutTrailingSlashes(env.FRONTEND_URL ?? DEFAULT_FRONTEND_URL)}${BILLING_FRONTEND_PATH}`;
}

/** A finding's notice title and message, plain text in `locale`. */
function translateNotice({
  finding,
  locale,
  organizationName,
  trialEnd,
}: {
  finding: Exclude<PlanStateCheckFinding, { kind: 'grace_ended' }>;
  locale: SupportedLanguage;
  organizationName: string;
  trialEnd: Date | null;
}): { type: NotificationType; title: string; message: string } {
  const plainText = { lng: locale, interpolation: { escapeValue: false } };
  if (finding.kind === 'trial_notice') {
    return {
      type: 'billing.trial_ending',
      title: i18next.t('common:notifications.billingTrialEndingTitle', plainText),
      message: i18next.t('common:notifications.billingTrialEndingMessage', {
        ...plainText,
        organizationName,
        endsOn: trialEnd?.toISOString().slice(0, 10) ?? '',
      }),
    };
  }
  return {
    type: 'billing.plan_choice_required',
    title: i18next.t('common:notifications.billingPlanChoiceRequiredTitle', plainText),
    message: i18next.t('common:notifications.billingPlanChoiceRequiredMessage', {
      ...plainText,
      organizationName,
    }),
  };
}

/**
 * One subscription's plan-state check (routes-final § 8.B BL17, BL24, BLC10, BLC13 — WC-59): inside
 * its organization, re-reads the row and acts on each finding once.
 *
 * @remarks
 * - **Algorithm:** the organization's language first; then one unit of work in the organization's
 *   job scope (`runOrganizationScopedWorkerJob`, K8): the row ({@link decidePlanStateCheckFindings});
 *   a `trial_notice` sends `billing.trial_ending` to the billing recipients (`subscription:manage`
 *   holders) keyed `trial-ending:<subscription>:<days>`; a `legacy_plan` sends
 *   `billing.plan_choice_required` keyed `plan-choice:<subscription>` — notify's once-only check and
 *   the email's outbox key make each one once. After the unit commits: a `grace_ended` emits
 *   `plan_ended` (keyed by the period end — the app's plan-change task drops a repeat); a
 *   `legacy_plan` whose notice went out now emits `moved_down` (keyed by the subscription) — so one
 *   event per subscription however often the check runs.
 * - **Failure modes:** a database failure rolls the unit back and the job retries — nothing was
 *   sent; every recipient failing rethrows (retry). An emit failure is logged by the bus (the next
 *   check emits the grace end again; the legacy move is then the plan-stop backup's, WC-38).
 * - **Side effects:** `notify.notifications` / `auth.mail_outbox` rows; one domain event per
 *   finding that needs one. Stripe is never called.
 * - **Notes:** a re-run in the same sweep sends nothing twice (the keys); safe to skip — the next
 *   sweep finds the row again.
 */
export async function processSubscriptionPlanStateCheckJob({
  jobData,
  services,
  now = new Date(),
}: {
  jobData: Pick<SubscriptionPlanStateCheckJobData, 'organizationPublicId' | 'subscriptionPublicId'>;
  services: SubscriptionPlanStateCheckServices;
  now?: Date;
}): Promise<SubscriptionPlanStateCheckResult> {
  const { organizationPublicId, subscriptionPublicId } = jobData;
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
  const locale =
    await services.organizationSettingsService.resolveDefaultLocaleForOrganization(
      organizationPublicId,
    );
  const unit = await runOrganizationScopedWorkerJob({
    job: { organizationPublicId },
    processor: async (databaseHandle) => {
      const repository = createWorkerSubscriptionRepository(databaseHandle);
      const organization = await repository.findOrganizationFromCurrentContext();
      if (organization === null) return null;
      const row = await repository.findPlanStateCheckRow({
        organizationId: organization.id,
        subscriptionPublicId,
      });
      if (row === null) return null;
      const findings = decidePlanStateCheckFindings({
        row,
        now,
        dunningGraceDays: env.BILLING_DUNNING_GRACE_DAYS,
      });
      const done: { finding: PlanStateCheckFinding; did: string }[] = [];
      for (const finding of findings) {
        if (finding.kind === 'grace_ended') {
          done.push({ finding, did: 'emit' });
          continue;
        }
        const recipientUserIds = await services.membershipService.findActiveUserIdsWithPermission({
          scope,
          permissionCode: BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE,
        });
        if (recipientUserIds.length === 0) {
          done.push({ finding, did: 'no_recipients' });
          continue;
        }
        const notice = translateNotice({
          finding,
          locale,
          organizationName: row.organizationName,
          trialEnd: row.trialEnd,
        });
        const notified = await services.notificationService.createOrganizationNotifications({
          scope,
          recipientUserIds,
          notification: {
            ...notice,
            actionUrl: billingActionUrl(),
            channels: ['in_app', 'email'],
            locale,
          },
          dedupeKey:
            finding.kind === 'trial_notice'
              ? buildTrialEndingDedupeKey({ subscriptionPublicId, days: finding.days })
              : buildPlanChoiceDedupeKey(subscriptionPublicId),
        });
        const did = notified.deduplicated ? 'deduplicated' : 'sent';
        done.push({
          finding,
          did: finding.kind === 'legacy_plan' && did === 'sent' ? 'emit' : did,
        });
      }
      return { row, done };
    },
  });
  if (unit === null) return { outcome: 'skipped', reason: 'subscription_missing' };
  for (const { finding, did } of unit.done) {
    if (did !== 'emit') continue;
    await services.subscriptionService.emitPlanStateCheckFinding(
      finding.kind === 'grace_ended'
        ? {
            organizationPublicId,
            change: PLAN_STATE_CHANGE.PLAN_ENDED,
            previous: { state: 'grace', plan_public_id: unit.row.planPublicId },
            changeKey: String(finding.periodEnd.getTime()),
          }
        : {
            organizationPublicId,
            change: PLAN_STATE_CHANGE.MOVED_DOWN,
            previous: { state: 'active', plan_public_id: unit.row.planPublicId },
            changeKey: subscriptionPublicId,
          },
    );
  }
  const result: SubscriptionPlanStateCheckResult = {
    outcome: 'checked',
    findings: unit.done.map(({ finding, did }) => ({
      kind: finding.kind,
      did: did === 'emit' ? 'emitted' : did,
    })),
  };
  logger.info(
    { organizationPublicId, subscriptionPublicId, ...result },
    'billing.plan_state_check.completed',
  );
  return result;
}

/**
 * The 15-minute sweep of the plan-state check (BL17, BLC10): lists the due subscriptions across
 * organizations and adds one check each.
 *
 * @remarks
 * - **Algorithm:** pages of {@link SUBSCRIPTION_PLAN_STATE_CHECK_SWEEP_PAGE_SIZE} by subscription
 *   id, each one short read under the retention maintenance context (the subscriptions policy's
 *   `USING` bypass arm — `runGlobalRetentionWorkerJob`), then the adds outside it; at most
 *   {@link SUBSCRIPTION_PLAN_STATE_CHECK_SWEEP_MAX_PAGES} pages.
 * - **Failure modes:** a read failure propagates (the sweep job retries); an add failure is logged
 *   and the sweep goes on — the rows are still due at the next sweep.
 * - **Side effects:** check jobs on the plan-state check queue.
 * - **Notes:** returns how many checks it added.
 */
export async function runSubscriptionPlanStateCheckSweep(
  sweptAt: Date = new Date(),
): Promise<{ addedCount: number }> {
  let afterId = 0;
  let addedCount = 0;
  for (let page = 0; page < SUBSCRIPTION_PLAN_STATE_CHECK_SWEEP_MAX_PAGES; page += 1) {
    const rows = await runGlobalRetentionWorkerJob((databaseHandle) =>
      createRetentionSubscriptionRepository(databaseHandle).listPlanStateCheckDue({
        dunningGraceDays: env.BILLING_DUNNING_GRACE_DAYS,
        lookbackDays: PLAN_STATE_CHECK_GRACE_END_LOOKBACK_DAYS,
        trialNoticeMaxDays: Math.max(...TRIAL_NOTICE_DAYS),
        afterId,
        limit: SUBSCRIPTION_PLAN_STATE_CHECK_SWEEP_PAGE_SIZE,
      }),
    );
    if (rows.length === 0) return { addedCount };
    try {
      addedCount += await enqueueSubscriptionPlanStateChecks({ targets: rows, sweptAt });
    } catch (error) {
      logger.warn(
        { error_name: (error as Error | null)?.name, count: rows.length },
        'billing.plan_state_check.enqueue_failed',
      );
    }
    afterId = rows.at(-1)?.subscriptionId ?? afterId;
    if (rows.length < SUBSCRIPTION_PLAN_STATE_CHECK_SWEEP_PAGE_SIZE) {
      logger.info({ addedCount }, 'billing.plan_state_check.sweep_completed');
      return { addedCount };
    }
  }
  logger.error({ addedCount }, 'billing.plan_state_check.sweep_capped');
  return { addedCount };
}
