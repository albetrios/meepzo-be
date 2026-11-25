import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { runEnqueueAfterCommit } from '@/core/events/event-bus.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  assertTeamOrganization,
  assertTeamOrganizationForRead,
} from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import { ConflictError, NotFoundError, UnprocessableEntityError } from '@/shared/errors/index.js';
import {
  getPostgresConstraintName,
  isPostgresUniqueViolation,
} from '@/shared/utils/infrastructure/postgres-error.util.js';
import type { ChannelAccountService } from '@/domains/app/sub-domains/channel-account/channel-account.service.js';
import { channelFeatureRefusalError } from '@/domains/app/sub-domains/channel-account/channel-account-error.util.js';
import type { AutomationRepository } from '@/domains/app/sub-domains/automation/automation.repository.js';
import type { AutomationTriggerType } from '@/domains/app/sub-domains/automation/automation.constants.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { notifyOrganizationKind } from '@/domains/notify/sub-domains/notification/notification-notice.service.js';
import {
  AUTOMATION_BACKFILL_STUCK_READ_MINUTES,
  AUTOMATION_BACKFILL_TRIGGER_TYPES,
  type AutomationBackfillFailReason,
} from './automation-backfill.constants.js';
import {
  AUTOMATION_BACKFILL_OPEN_INDEX,
  type AutomationBackfillReadTarget,
  type AutomationBackfillRepository,
  type AutomationBackfillRow,
} from './automation-backfill.repository.js';
import { serializeAutomationBackfill } from './automation-backfill.serializer.js';
import type {
  AutomationBackfillGetInput,
  AutomationBackfillOutput,
  AutomationBackfillRead,
  AutomationBackfillReadBegin,
  AutomationBackfillReadQueue,
  AutomationBackfillStartInput,
  AutomationOpenBackfillReader,
} from './automation-backfill.types.js';

/**
 * The one feature check the past-comments start asks (1B, CA11 — `past_comments`).
 *
 * @remarks
 * Notes: structural; the app container passes `ChannelAccountService`.
 */
export type AutomationBackfillFeaturePort = Pick<
  ChannelAccountService,
  'canChannelAccountUseFeature'
>;

/**
 * The automation reads routes 38 and 39 need.
 *
 * @remarks
 * Notes: the automation sub-domain's own repository (same domain — this is its nested sub-domain);
 * the app container passes the one `AutomationRepository` the automation service uses.
 */
export type AutomationBackfillAutomationReader = Pick<
  AutomationRepository,
  'findLiveByPublicId' | 'lockLiveByPublicId' | 'findByIdIncludingDeleted'
>;

/** `404 automation_not_found` — absent, deleted or another organization's (4.C.9). */
function automationNotFoundError(): NotFoundError {
  return new NotFoundError('Automation').withReason('automation_not_found');
}

/**
 * The past-comments reads of an automation (feat-instagram-dm-sending routes-final § 4.C — routes
 * 38–39): start one ("also answer comments from the last N days") and read one; the automation
 * object's open read (`open_backfill`, 4.A.6).
 *
 * @remarks
 * Algorithm:
 * - **Route 38 (AU31)** — one unit: the team check (`422`); the automation locked `FOR UPDATE`
 *   (`404 automation_not_found`); 1B's one feature check `past_comments` (CA11 —
 *   `403 plan_lacks_feature`, `422 channel_lacks_feature`, `409 permission_not_granted`); a `live`
 *   automation only (`409 automation_not_live`); a `comment` or `ad_comment` one only
 *   (`422 automation_backfill_not_supported` — never `live_comment`); no `queued` or `reading` read
 *   of it (`409 automation_backfill_in_progress`, also the partial unique index's race loser); then a
 *   `queued` row with its account copied and who asked. After commit, the read job (when wired —
 *   ROUTE row R41) is enqueued for the account.
 * - **Route 39 (AU33)** — the read by its public id under its own automation only
 *   (`404 automation_backfill_not_found` for another automation's or organization's).
 *
 * Failure modes: as above; a step that throws rolls back.
 *
 * Side effects: route 38 writes one `app.automation_backfills` row; the audit entry is the
 * controller's, after commit (AU7). Never calls Meta (4.10 — the read is the job's).
 */
export class AutomationBackfillService implements AutomationOpenBackfillReader {
  constructor(
    private readonly backfillRepository: AutomationBackfillRepository,
    private readonly automationReader: AutomationBackfillAutomationReader,
    private readonly featurePort: AutomationBackfillFeaturePort,
    private readonly organizationService: OrganizationService,
    private readonly readQueue?: AutomationBackfillReadQueue | undefined,
  ) {}

  /**
   * Starts a past-comments read (route 38, AU31) and returns it `queued`.
   *
   * @remarks
   * Algorithm, failure modes and side effects: see the class. A new start after a `failed` or
   * `done` read makes a new row.
   */
  async startAutomationBackfill({
    scope,
    automationPublicId,
    days,
    requestedByUserPublicId,
  }: AutomationBackfillStartInput): Promise<AutomationBackfillOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const automation = await this.automationReader.lockLiveByPublicId({
          organizationId: organization.id,
          automationPublicId,
        });
        if (automation === null) throw automationNotFoundError();
        const check = await this.featurePort.canChannelAccountUseFeature({
          scope,
          organizationId: organization.id,
          channelAccountId: automation.channel_account_id,
          feature: 'past_comments',
        });
        if (!check.isAllowed) throw channelFeatureRefusalError(check.reason);
        if (automation.status !== 'live') {
          throw new ConflictError('errors:automationNotLive').withReason('automation_not_live');
        }
        if (
          !AUTOMATION_BACKFILL_TRIGGER_TYPES.includes(
            automation.trigger_type as AutomationTriggerType,
          )
        ) {
          throw new UnprocessableEntityError('errors:automationBackfillNotSupported').withReason(
            'automation_backfill_not_supported',
          );
        }
        const open = await this.backfillRepository.findOpenByAutomation({
          organizationId: organization.id,
          automationId: automation.id,
        });
        if (open !== null) throw inProgressError();
        const requestedByUserId =
          await this.organizationService.resolveUserInternalIdByPublicId(requestedByUserPublicId);
        let row: AutomationBackfillRow;
        try {
          row = await this.backfillRepository.insertQueued({
            organizationId: organization.id,
            channelAccountId: automation.channel_account_id,
            automationId: automation.id,
            days,
            requestedByUserId,
          });
        } catch (error) {
          if (
            isPostgresUniqueViolation(error) &&
            getPostgresConstraintName(error) === AUTOMATION_BACKFILL_OPEN_INDEX
          ) {
            throw inProgressError();
          }
          throw error;
        }
        await this.enqueueRead({
          scope,
          channelAccountPublicId: automation.channel_account_public_id,
          automationBackfillPublicId: row.public_id,
        });
        return this.serialize({ row, automationPublicId: automation.public_id });
      },
    });
  }

  /**
   * One past-comments read (route 39, AU33).
   *
   * @remarks
   * Algorithm: one unit — the team check (`404 team_organization_required`), the automation
   * (`404 automation_not_found`), the read under it (`404 automation_backfill_not_found`). Side
   * effects: none.
   */
  async getAutomationBackfill({
    scope,
    automationPublicId,
    automationBackfillPublicId,
  }: AutomationBackfillGetInput): Promise<AutomationBackfillOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        const automation = await this.automationReader.findLiveByPublicId({
          organizationId: organization.id,
          automationPublicId,
        });
        if (automation === null) throw automationNotFoundError();
        const row = await this.backfillRepository.findByPublicId({
          organizationId: organization.id,
          automationId: automation.id,
          automationBackfillPublicId,
        });
        if (row === null) {
          throw new NotFoundError('Past-comments read').withReason('automation_backfill_not_found');
        }
        return this.serialize({ row, automationPublicId: automation.public_id });
      },
    });
  }

  /**
   * The automation's `queued` or `reading` read as its object shows it (`open_backfill`, 4.A.6), or
   * `null`.
   *
   * @remarks
   * Algorithm: one read in the caller's unit (a nested context reuses it). Side effects: none.
   */
  async findOpenAutomationBackfill({
    scope,
    organizationId,
    automationId,
    automationPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    automationId: number;
    automationPublicId: string;
  }): Promise<AutomationBackfillOutput | null> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const row = await this.backfillRepository.findOpenByAutomation({
          organizationId,
          automationId,
        });
        return row === null ? null : this.serialize({ row, automationPublicId });
      },
    });
  }

  /**
   * Starts the account's next past-comments read for the read job (WC-41, AU32), or continues the
   * one a job named.
   *
   * @remarks
   * Algorithm: one unit under the account's read lock — with `resume`: the named read when it is
   * still `reading` from that start, else `ended`; without: a `reading` read whose last page is
   * under 30 minutes old means another job reads (`busy`); a stuck one (older) is started again
   * from zero; else the account's oldest `queued` read starts (`none` when there is none). Then,
   * outside the unit, 1B's one feature check `past_comments` (CA11, P50): a refusal ends the read
   * `failed` — `plan_feature_off` when the plan lacks it, `meta_error` (the refusal as its code)
   * otherwise. Failure modes: database errors propagate. Side effects: the read's row. Never Meta.
   */
  async beginAutomationBackfillRead({
    scope,
    channelAccount,
    resume,
    now = new Date(),
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccount: { organizationId: number; channelAccountId: number };
    /** The read a resumed job continues and the start it carries. */
    resume: { automationBackfillPublicId: string; startedAt: Date } | null;
    now?: Date;
  }): Promise<AutomationBackfillReadBegin> {
    const begun = await withAppDatabaseContext({
      scope,
      callback: async (): Promise<AutomationBackfillReadBegin | AutomationBackfillRow> => {
        await this.backfillRepository.lockAccountReads(channelAccount);
        const reading = await this.backfillRepository.findReadingByAccount(channelAccount);
        if (resume !== null) {
          if (
            reading === null ||
            reading.public_id !== resume.automationBackfillPublicId ||
            reading.started_at?.getTime() !== resume.startedAt.getTime()
          ) {
            return { kind: 'ended' };
          }
          return reading;
        }
        let next = reading;
        if (reading !== null) {
          const isStuck =
            now.getTime() - reading.updated_at.getTime() >
            AUTOMATION_BACKFILL_STUCK_READ_MINUTES * MILLISECONDS_PER_MINUTE;
          if (!isStuck) return { kind: 'busy' };
        } else {
          next = await this.backfillRepository.findOldestQueuedByAccount(channelAccount);
          if (next === null) return { kind: 'none' };
        }
        if (next === null) return { kind: 'none' };
        const started = await this.backfillRepository.startReading({
          organizationId: channelAccount.organizationId,
          automationBackfillId: next.id,
        });
        if (started === null) return { kind: 'none' };
        logger.info(
          {
            organizationPublicId: scope.organizationPublicId,
            automationBackfillPublicId: started.public_id,
            isRestart: reading !== null,
          },
          'app.automation_backfill.read_started',
        );
        return started;
      },
    });
    if ('kind' in begun) return begun;
    const target = await withAppDatabaseContext({
      scope,
      callback: () =>
        this.backfillRepository.findReadTarget({
          organizationId: begun.organization_id,
          automationId: begun.automation_id,
        }),
    });
    const read = toRead({ row: begun, target });
    const check = await this.featurePort.canChannelAccountUseFeature({
      scope,
      organizationId: channelAccount.organizationId,
      channelAccountId: channelAccount.channelAccountId,
      feature: 'past_comments',
    });
    if (check.isAllowed && read.target !== null) return { kind: 'reading', read };
    let failure: { reason: AutomationBackfillFailReason; lastError: string | null };
    if (check.isAllowed) failure = { reason: 'meta_error', lastError: 'automation_gone' };
    else if (check.reason === 'plan_lacks_feature') {
      failure = { reason: 'plan_feature_off', lastError: null };
    } else failure = { reason: 'meta_error', lastError: `feature:${check.reason}` };
    await this.finishAutomationBackfillRead({ scope, read, failure });
    return { kind: 'refused', failReason: failure.reason };
  }

  /**
   * Adds one post's numbers to a running read and marks its page (WC-41) — the watch restarts a read
   * whose last page is 30 minutes old. Answers `false` when the read ended or was started again
   * meanwhile (the job then stops).
   *
   * @remarks
   * Algorithm: one guarded update in the read's organization scope. Failure modes: database errors
   * propagate. Side effects: the read's counters and `updated_at`.
   */
  async recordAutomationBackfillProgress({
    scope,
    read,
    postsRead,
    found,
    matched,
    queuedCount,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    read: AutomationBackfillRead;
    postsRead: number;
    found: number;
    matched: number;
    queuedCount: number;
  }): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: () =>
        this.backfillRepository.addReadProgress({
          ...read.key,
          startedAt: read.startedAt,
          postsRead,
          found,
          matched,
          queuedCount,
        }),
    });
  }

  /**
   * Ends a running read (WC-41): `done`, or `failed` with its reason and a code-only error.
   *
   * @remarks
   * Algorithm: one guarded update in the read's organization scope (a read already ended or started
   * again is left alone → `false`). Failure modes: database errors propagate. Side effects: the
   * read's row; the log line `app.automation_backfill.read_finished`; a read ended `done` tells its
   * starter and the Owner and Admin in the same unit (`automation.backfill_done`, AC-8.8, R53).
   */
  async finishAutomationBackfillRead({
    scope,
    read,
    failure,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    read: AutomationBackfillRead;
    failure: { reason: AutomationBackfillFailReason; lastError: string | null } | null;
  }): Promise<boolean> {
    const row = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const finished = await this.backfillRepository.finishReading({
          ...read.key,
          startedAt: read.startedAt,
          failure,
        });
        if (finished !== null && finished.status === 'done') {
          await this.tellAutomationBackfillDone({ scope, finished });
        }
        return finished;
      },
    });
    if (row !== null) {
      logger.info(
        {
          organizationPublicId: scope.organizationPublicId,
          automationBackfillPublicId: row.public_id,
          status: row.status,
          failReason: row.fail_reason,
          postsRead: row.posts_read,
          found: row.found,
          matched: row.matched,
          queuedCount: row.queued_count,
        },
        'app.automation_backfill.read_finished',
      );
    }
    return row !== null;
  }

  /**
   * The "past comments done" notice (feat-instagram-dm-sending UN8, UN9, AC-8.8): one
   * `automation.backfill_done` notice with the read's numbers to who started it and the Owner and
   * Admin (`broadcast_or_past_comments_done` — in-app on, email off by default), once per read.
   *
   * @remarks
   * Algorithm: the automation's name (a deleted one keeps its name), then notify's
   * `notifyOrganizationKind` keyed `backfill-done:<abf_…>`, in the finishing unit. Failure modes:
   * propagates (the finish rolls back with it — the read's job retries). Side effects: inbox rows.
   */
  private async tellAutomationBackfillDone({
    scope,
    finished,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    finished: {
      public_id: string;
      organization_id: number;
      automation_id: number;
      requested_by_user_id: number | null;
      found: number;
      matched: number;
      queued_count: number;
    };
  }): Promise<void> {
    const automation = await this.automationReader.findByIdIncludingDeleted({
      organizationId: finished.organization_id,
      automationId: finished.automation_id,
    });
    await notifyOrganizationKind({
      scope,
      type: 'automation.backfill_done',
      copy: {
        key: 'automationBackfillDone',
        values: {
          automationName: automation?.name ?? '',
          found: finished.found,
          matched: finished.matched,
          queuedCount: finished.queued_count,
        },
      },
      dedupeKey: `backfill-done:${finished.public_id}`,
      actionPath: automation === null ? '/automations' : `/automations/${automation.public_id}`,
      subjectUserId: finished.requested_by_user_id,
      data: {
        found: finished.found,
        matched: finished.matched,
        queued_count: finished.queued_count,
      },
    });
  }

  /**
   * A move down turned the plan's `past_comments` switch off (P83, WC-38 — ROUTE row R52, AC-8.7):
   * the organization's unfinished reads end `failed` · `plan_feature_off`; the opening DMs they
   * already queued still go (they are messages now, sub-domain 6's).
   *
   * @remarks
   * Algorithm: one guarded `UPDATE` in the scope's unit (joining the caller's). Failure modes: none
   * of its own. Side effects: the read rows; a read job that wakes on a `failed` row stops at its
   * next claim (R41). Returns the count.
   */
  async failOpenBackfillsForPlanFeatureOff({
    scope,
    organizationId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
  }): Promise<number> {
    return withAppDatabaseContext({
      scope,
      callback: async () =>
        (await this.backfillRepository.failOpenForPlanFeatureOff({ organizationId })).length,
    });
  }

  /** Enqueues the account's read after commit when wired (WC-41, ROUTE row R41). */
  private async enqueueRead({
    scope,
    channelAccountPublicId,
    automationBackfillPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
    automationBackfillPublicId: string;
  }): Promise<void> {
    const queue = this.readQueue;
    if (queue === undefined) return;
    await runEnqueueAfterCommit(() =>
      queue.enqueueAutomationBackfillRead({
        organizationPublicId: scope.organizationPublicId,
        channelAccountPublicId,
        automationBackfillPublicId,
      }),
    );
  }

  /** Serializes one read with the person's public id. */
  private async serialize({
    row,
    automationPublicId,
  }: {
    row: AutomationBackfillRow;
    automationPublicId: string;
  }): Promise<AutomationBackfillOutput> {
    const requestedByUserPublicId =
      row.requested_by_user_id === null
        ? null
        : await this.organizationService.resolveUserPublicIdByInternalId(row.requested_by_user_id);
    return serializeAutomationBackfill({
      backfill: row,
      automation_public_id: automationPublicId,
      requested_by_user_public_id: requestedByUserPublicId,
    });
  }
}

/** The job's view of a started read. */
function toRead({
  row,
  target,
}: {
  row: AutomationBackfillRow;
  target: AutomationBackfillReadTarget | null;
}): AutomationBackfillRead {
  return {
    key: { organizationId: row.organization_id, automationBackfillId: row.id },
    automationBackfillPublicId: row.public_id,
    startedAt: row.started_at ?? row.updated_at,
    days: row.days,
    target: target?.status ? target : null,
  };
}

/** `409 automation_backfill_in_progress` — "Past comments are already being read" (AU31). */
function inProgressError(): ConflictError {
  return new ConflictError('errors:automationBackfillInProgress').withReason(
    'automation_backfill_in_progress',
  );
}
