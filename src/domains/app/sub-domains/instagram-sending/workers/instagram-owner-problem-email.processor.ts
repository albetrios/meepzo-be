import { createHash } from 'node:crypto';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  MILLISECONDS_PER_HOUR,
  MILLISECONDS_PER_MINUTE,
} from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  notifyOrganizationKind,
  sendTeamAlertEmail,
} from '@/domains/notify/sub-domains/notification/notification-notice.service.js';
import { INSTAGRAM_ACCOUNT_FRONTEND_PATH } from '@/domains/app/sub-domains/instagram-account/instagram-account.constants.js';
import {
  type InstagramSendStopAcrossRow,
  createRetentionInstagramSendStopRepository,
} from '@/domains/app/sub-domains/instagram-sending/instagram-send-stop.repository.js';
import {
  OWNER_PROBLEM_EMAIL_BUDGET_MILLISECONDS,
  OWNER_PROBLEM_EMAIL_EVERY_HOURS,
  OWNER_PROBLEM_KIND_BY_STOP_REASON,
  OWNER_PROBLEM_LONG_STOP_MINUTES,
  OWNER_PROBLEM_UNTOLD_STOP_REASONS,
  type OwnerProblemKind,
} from './instagram-owner-problem-email.constants.js';

/** The copy key of each problem kind (`common:notifications.<key>Title` / `…Message`). */
const OWNER_PROBLEM_COPY_KEY: Readonly<Record<OwnerProblemKind, string>> = {
  blocked: 'ownerProblemBlocked',
  connection_stopped: 'ownerProblemConnectionStopped',
  message_access_off: 'ownerProblemMessageAccessOff',
  plan_ended: 'ownerProblemPlanEnded',
  plan_switch_off: 'ownerProblemPlanSwitchOff',
  long_stop: 'ownerProblemLongStop',
};

/** The team alert lists the problems that came due within this many minutes (WC-57's team part). */
const TEAM_ALERT_RECENT_MINUTES = 2;

/**
 * One owner problem to tell (WC-57): an account, its kind, when it came due, its username.
 *
 * @remarks
 * Notes: `dueAt` names the problem in the notice's key.
 */
export interface OwnerProblemToTell {
  organizationPublicId: string;
  channelAccountPublicId: string;
  username: string;
  kind: OwnerProblemKind;
  dueAt: Date;
}

/** The kind a stop is told as, or `null` when the problem emails never tell it. */
function kindOfStop(reason: string): OwnerProblemKind | null {
  if (OWNER_PROBLEM_UNTOLD_STOP_REASONS.has(reason)) return null;
  return OWNER_PROBLEM_KIND_BY_STOP_REASON[reason] ?? 'long_stop';
}

/** One stop's problem when it came due by `now` and was not over before then; else `null`. */
function dueProblemOf({
  stop,
  now,
}: {
  stop: InstagramSendStopAcrossRow;
  now: Date;
}): OwnerProblemToTell | null {
  const kind = kindOfStop(stop.reason);
  if (kind === null) return null;
  const delayMilliseconds =
    kind === 'long_stop' ? OWNER_PROBLEM_LONG_STOP_MINUTES * MILLISECONDS_PER_MINUTE : 0;
  const dueAt = new Date(stop.startedAt.getTime() + delayMilliseconds);
  if (dueAt.getTime() > now.getTime()) return null;
  if (stop.endedAt !== null && stop.endedAt.getTime() < dueAt.getTime()) return null;
  return {
    organizationPublicId: stop.organizationPublicId,
    channelAccountPublicId: stop.channelAccountPublicId,
    username: stop.displayName.replace(/^@/, ''),
    kind,
    dueAt,
  };
}

/**
 * Which stops tell their owners now (feat-instagram-dm-sending WC-57, AC-10.6) — pure.
 *
 * @remarks
 * - **Algorithm:** a stop's kind ({@link OWNER_PROBLEM_KIND_BY_STOP_REASON}; any other reason is a
 *   `long_stop`; `login_expired` and `plan_limit` are told elsewhere); it comes due at its start
 *   (a `long_stop` an hour later) and counts only when it was still on then (a stop that ended
 *   before its email was due sends none). Per account and kind, in due order, a due stop is told
 *   when no told one came due in the 6 hours before it — one email of a kind per account per
 *   6 hours. Only those due within the last 6 hours are returned (older ones were told by earlier
 *   runs; they still hold their window).
 * - **Failure modes:** none.
 * - **Side effects:** none.
 * - **Notes:** a stop on every lane is one row per lane — they come due together, so one is told.
 */
export function decideOwnerProblems({
  stops,
  now,
}: {
  stops: readonly InstagramSendStopAcrossRow[];
  now: Date;
}): OwnerProblemToTell[] {
  const windowMilliseconds = OWNER_PROBLEM_EMAIL_EVERY_HOURS * MILLISECONDS_PER_HOUR;
  const due = stops
    .map((stop) => dueProblemOf({ stop, now }))
    .filter((problem): problem is OwnerProblemToTell => problem !== null);
  due.sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime());
  const lastToldAt = new Map<string, number>();
  const told: OwnerProblemToTell[] = [];
  for (const problem of due) {
    const key = `${problem.channelAccountPublicId}:${problem.kind}`;
    const last = lastToldAt.get(key);
    if (last !== undefined && problem.dueAt.getTime() - last < windowMilliseconds) continue;
    lastToldAt.set(key, problem.dueAt.getTime());
    if (problem.dueAt.getTime() >= now.getTime() - windowMilliseconds) told.push(problem);
  }
  return told;
}

/**
 * The once key of one owner problem: `owner-problem:<cha_…>:<kind>:<due time>`.
 *
 * @remarks
 * Exported for the unit test.
 */
export function buildOwnerProblemDedupeKey(problem: OwnerProblemToTell): string {
  return `owner-problem:${problem.channelAccountPublicId}:${problem.kind}:${String(problem.dueAt.getTime())}`;
}

/**
 * What one run of the owners' problem emails did.
 *
 * @remarks
 * Notes: `toldCount` counts problems handed to the notice (a repeat is kept once by its key);
 * `isBudgetSpent` — the rest waits for the next minute.
 */
export interface OwnerProblemEmailRunResult {
  toldCount: number;
  failedCount: number;
  teamAlertedCount: number;
  isBudgetSpent: boolean;
}

/**
 * The owners' problem emails (feat-instagram-dm-sending WC-57, AC-10.6): every minute, the account
 * stops that came due are told to the organization's Owner, Admin and Editor (`automation_problem`
 * — email and in-app on by default), one email of a kind per account per 6 hours; the team gets one
 * email grouping the problems that just came due across accounts.
 *
 * @remarks
 * - **Algorithm:** one read under the retention sweep arm — the stops started in the last
 *   13 hours (6 + 1 + 6: a window's worth of `long_stop` history) — then
 *   {@link decideOwnerProblems}; per problem, in its organization's job scope, one
 *   `automation.stopped` notice (`data.problem` the kind) keyed by
 *   {@link buildOwnerProblemDedupeKey}, until the 40 s budget is spent; then
 *   `sendTeamAlertEmail` with the problems due in the last 2 minutes, grouped by kind (keyed by the
 *   set, so an unchanged set is not sent again).
 * - **Failure modes:** one problem failing is logged and the rest go on (the next minute tries it
 *   again — the key keeps it once); a read error propagates (the job's next minute reads again).
 * - **Side effects:** inbox and outbox rows, mail jobs; log lines with ids and counts only.
 * - **Notes:** safe to repeat — the keys; a refused text (R54) and a failed payment (billing) are
 *   not stops and are told by their own rows; missed comments are told by the look (WC-26).
 */
export async function runInstagramOwnerProblemEmailJob({
  now = new Date(),
  budgetMilliseconds = OWNER_PROBLEM_EMAIL_BUDGET_MILLISECONDS,
}: {
  now?: Date;
  budgetMilliseconds?: number;
} = {}): Promise<OwnerProblemEmailRunResult> {
  const startedAt = Date.now();
  const since = new Date(
    now.getTime() -
      (2 * OWNER_PROBLEM_EMAIL_EVERY_HOURS * MILLISECONDS_PER_HOUR +
        OWNER_PROBLEM_LONG_STOP_MINUTES * MILLISECONDS_PER_MINUTE),
  );
  const stops = await runGlobalRetentionWorkerJob((databaseHandle) =>
    createRetentionInstagramSendStopRepository(databaseHandle).listStartedSinceAcrossOrganizations({
      since,
    }),
  );
  const problems = decideOwnerProblems({ stops, now });
  const result: OwnerProblemEmailRunResult = {
    toldCount: 0,
    failedCount: 0,
    teamAlertedCount: 0,
    isBudgetSpent: false,
  };
  for (const problem of problems) {
    if (Date.now() - startedAt > budgetMilliseconds) {
      result.isBudgetSpent = true;
      break;
    }
    const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId: problem.organizationPublicId });
    try {
      await withAppDatabaseContext({
        scope,
        callback: () =>
          notifyOrganizationKind({
            scope,
            type: 'automation.stopped',
            copy: {
              key: OWNER_PROBLEM_COPY_KEY[problem.kind],
              values: { username: problem.username },
            },
            dedupeKey: buildOwnerProblemDedupeKey(problem),
            actionPath: INSTAGRAM_ACCOUNT_FRONTEND_PATH,
            data: { problem: problem.kind, channel_account_id: problem.channelAccountPublicId },
          }),
      });
      result.toldCount += 1;
    } catch (error) {
      result.failedCount += 1;
      logger.warn(
        {
          organizationPublicId: problem.organizationPublicId,
          channelAccountPublicId: problem.channelAccountPublicId,
          kind: problem.kind,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        'app.instagram_send.owner_problem_failed',
      );
    }
  }
  result.teamAlertedCount = await alertTeam({ problems, now });
  logger.info({ problemCount: problems.length, ...result }, 'app.instagram_send.owner_problems');
  return result;
}

/** The team's grouped email (WC-57's team part): the problems that came due in the last minutes. */
async function alertTeam({
  problems,
  now,
}: {
  problems: readonly OwnerProblemToTell[];
  now: Date;
}): Promise<number> {
  const recent = problems.filter(
    (problem) =>
      problem.dueAt.getTime() >=
      now.getTime() - TEAM_ALERT_RECENT_MINUTES * MILLISECONDS_PER_MINUTE,
  );
  if (recent.length === 0) return 0;
  const accountsByKind = new Map<OwnerProblemKind, number>();
  for (const problem of recent) {
    accountsByKind.set(problem.kind, (accountsByKind.get(problem.kind) ?? 0) + 1);
  }
  const summary = [...accountsByKind.entries()]
    .map(([kind, count]) => `${kind}: ${String(count)}`)
    .join(', ');
  const setKey = createHash('sha256')
    .update(
      recent
        .map(buildOwnerProblemDedupeKey)
        .sort((left, right) => left.localeCompare(right))
        .join('|'),
    )
    .digest('hex')
    .slice(0, 32);
  try {
    return await sendTeamAlertEmail({
      key: 'ownerProblems',
      values: { summary, accountCount: recent.length },
      dedupeKey: `owner-problems:${setKey}`,
    });
  } catch (error) {
    logger.warn(
      { errorName: error instanceof Error ? error.name : typeof error },
      'app.instagram_send.owner_problem_team_alert_failed',
    );
    return 0;
  }
}
