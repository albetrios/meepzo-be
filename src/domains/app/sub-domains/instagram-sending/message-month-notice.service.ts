import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { notifyOrganizationKind } from '@/domains/notify/sub-domains/notification/notification-notice.service.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { INSTAGRAM_ACCOUNT_FRONTEND_PATH } from '@/domains/app/sub-domains/instagram-account/instagram-account.constants.js';
import { MESSAGE_MONTH_NEARLY_SHARE } from './instagram-sending.constants.js';
import type { MessageMonthCountRepository } from './message-month-count.repository.js';
import type { MessageMonthCountService } from './message-month-count.service.js';

/**
 * A month line the organization is told about once a month (WC-56): 80 % or 100 %.
 *
 * @remarks
 * Notes: it names the notice's key (`month-limit:<month>:<line>`) and its `data.percent`.
 */
export type MessageMonthLine = 80 | 100;

/**
 * The highest month line `used` stands at for `limit` (WC-56, D34): `100` at the limit, `80` from
 * {@link MESSAGE_MONTH_NEARLY_SHARE} of it, else `null`.
 *
 * @remarks
 * Pure; exported for the unit test and the send's claim, which tells a line when one DM moves it.
 * Only the highest line is told — a month that jumps past 80 % straight to 100 % gets one notice.
 */
export function decideMessageMonthLine({
  used,
  limit,
}: {
  used: number;
  limit: number | null;
}): MessageMonthLine | null {
  if (limit === null || limit <= 0) return null;
  if (used >= limit) return 100;
  return used >= limit * MESSAGE_MONTH_NEARLY_SHARE ? 80 : null;
}

/**
 * What one month-line check did.
 *
 * @remarks
 * `line` — the line the month stands at (`null` under 80 % or without a limit); `notifiedCount` —
 * people notified now (0 when already told this month).
 */
export interface MessageMonthLineResult {
  line: MessageMonthLine | null;
  notifiedCount: number;
}

/**
 * The month at 80 % and 100 % (feat-instagram-dm-sending WC-56, D34, AC-10.3–AC-10.5): one notice
 * and one email per organization, month and line, to the kind's people (`direct_message_limit` —
 * Owner, Admin, Editor; email and in-app on by default).
 *
 * @remarks
 * - **Algorithm:** billing's `message_month_limit`; in the organization's scope the month from
 *   Postgres (its 16 slots, in its time zone); {@link decideMessageMonthLine}; then one
 *   `billing.usage_threshold` notice (`data.percent` 80 | 100) keyed `month-limit:<month>:<line>`
 *   through notify's `notifyOrganizationKind` — the key's lock makes two servers crossing the line
 *   at once write one notice and one email.
 * - **Failure modes:** reads and writes propagate; {@link tellMonthLineAfterCommit} logs them.
 * - **Side effects:** notification and outbox rows; mail jobs.
 * - **Notes:** the send's claim calls it after the commit that moved the month over a line; the
 *   every-minute backup check calls it for every organization counted lately (a lost after-commit
 *   call, a crash). The 100 % plan stop is the claim's own (R42).
 */
export class MessageMonthNoticeService {
  constructor(
    private readonly monthCountRepository: MessageMonthCountRepository,
    private readonly monthCountService: Pick<MessageMonthCountService, 'readMonthLimit'>,
    private readonly organizationService: Pick<OrganizationService, 'findOrganizationByPublicId'>,
  ) {}

  /**
   * Tells the organization the month line it stands at, once a month per line.
   *
   * @remarks
   * Algorithm: as the class says. Failure modes: propagates. Side effects: the notice.
   */
  async tellMonthLine({
    scope,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
  }): Promise<MessageMonthLineResult> {
    const limit = await this.monthCountService.readMonthLimit(scope);
    if (limit === null) return { line: null, notifiedCount: 0 };
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.findOrganizationByPublicId(
          scope.organizationPublicId,
        );
        if (!organization) return { line: null, notifiedCount: 0 };
        const month = await this.monthCountRepository.readMonth(organization.id);
        if (month === null) return { line: null, notifiedCount: 0 };
        const line = decideMessageMonthLine({ used: month.used, limit });
        if (line === null) return { line, notifiedCount: 0 };
        const notified = await notifyOrganizationKind({
          scope,
          type: 'billing.usage_threshold',
          copy: {
            key: line === 100 ? 'directMessageLimitReached' : 'directMessageLimitNearly',
            values: { used: month.used, limit, resetsOn: month.resetsOn },
          },
          dedupeKey: `month-limit:${month.monthStart}:${String(line)}`,
          actionPath: INSTAGRAM_ACCOUNT_FRONTEND_PATH,
          data: { percent: line, month_start: month.monthStart },
        });
        return { line, notifiedCount: notified.deduplicated ? 0 : notified.createdCount };
      },
    });
  }

  /**
   * {@link tellMonthLine} for the send's claim, after its commit: a failure is logged, never thrown
   * (the DM is already claimed; the backup check tells the line within a minute).
   *
   * @remarks
   * Algorithm: one call, caught. Failure modes: none thrown. Side effects: the notice; a log line.
   */
  async tellMonthLineAfterCommit({
    scope,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
  }): Promise<void> {
    try {
      await this.tellMonthLine({ scope });
    } catch (error) {
      logger.warn(
        {
          organizationPublicId: scope.organizationPublicId,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        'app.instagram_send.month_notice_failed',
      );
    }
  }
}
