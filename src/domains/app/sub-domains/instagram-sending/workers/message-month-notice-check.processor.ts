import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { createRetentionMessageMonthCountRepository } from '@/domains/app/sub-domains/instagram-sending/message-month-count.repository.js';
import type { MessageMonthNoticeService } from '@/domains/app/sub-domains/instagram-sending/message-month-notice.service.js';
import {
  MESSAGE_MONTH_NOTICE_CHECK_BUDGET_MILLISECONDS,
  MESSAGE_MONTH_NOTICE_CHECK_LOOKBACK_MINUTES,
} from './message-month-notice-check.constants.js';

/**
 * What one backup check of the month notices did.
 *
 * @remarks
 * Notes: `notifiedCount` counts people told now (0 when every line was told already);
 * `isBudgetSpent` — the rest waits for the next minute.
 */
export interface MessageMonthNoticeCheckResult {
  checkedCount: number;
  notifiedCount: number;
  failedCount: number;
  isBudgetSpent: boolean;
}

/**
 * The month notices' backup check (feat-instagram-dm-sending WC-56, P94): every minute, each
 * organization whose month count moved in the last 5 minutes is told the line it stands at — a
 * notice the send's after-commit call lost (a crash, a failed write) goes within a minute.
 *
 * @remarks
 * - **Algorithm:** one read under the retention sweep arm
 *   (`MessageMonthCountRepository.listOrganizationsCountedSince`), then per organization
 *   `MessageMonthNoticeService.tellMonthLine` in its job scope until the 40 s budget is spent. The
 *   notice's key (`month-limit:<month>:<line>`) keeps every line once a month.
 * - **Failure modes:** one organization failing is logged and the rest go on; a read error
 *   propagates (the next minute reads again).
 * - **Side effects:** notices and emails; log lines with ids and counts only.
 * - **Notes:** rides the intake queue (`instagram-webhook`) like the other app sweeps.
 */
export async function runMessageMonthNoticeCheckJob({
  monthNotice,
  now = new Date(),
  budgetMilliseconds = MESSAGE_MONTH_NOTICE_CHECK_BUDGET_MILLISECONDS,
}: {
  monthNotice: Pick<MessageMonthNoticeService, 'tellMonthLine'>;
  now?: Date;
  budgetMilliseconds?: number;
}): Promise<MessageMonthNoticeCheckResult> {
  const startedAt = Date.now();
  const since = new Date(
    now.getTime() - MESSAGE_MONTH_NOTICE_CHECK_LOOKBACK_MINUTES * MILLISECONDS_PER_MINUTE,
  );
  const organizationPublicIds = await runGlobalRetentionWorkerJob((databaseHandle) =>
    createRetentionMessageMonthCountRepository(databaseHandle).listOrganizationsCountedSince({
      since,
    }),
  );
  const result: MessageMonthNoticeCheckResult = {
    checkedCount: 0,
    notifiedCount: 0,
    failedCount: 0,
    isBudgetSpent: false,
  };
  for (const organizationPublicId of organizationPublicIds) {
    if (Date.now() - startedAt > budgetMilliseconds) {
      result.isBudgetSpent = true;
      break;
    }
    try {
      const told = await monthNotice.tellMonthLine({
        scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId }),
      });
      result.checkedCount += 1;
      result.notifiedCount += told.notifiedCount;
    } catch (error) {
      result.failedCount += 1;
      logger.warn(
        {
          organizationPublicId,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        'app.instagram_send.month_notice_check_failed',
      );
    }
  }
  logger.info(result, 'app.instagram_send.month_notice_checked');
  return result;
}
