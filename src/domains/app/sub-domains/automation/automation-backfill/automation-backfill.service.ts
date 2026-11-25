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
import { AUTOMATION_BACKFILL_TRIGGER_TYPES } from './automation-backfill.constants.js';
import {
  AUTOMATION_BACKFILL_OPEN_INDEX,
  type AutomationBackfillRepository,
  type AutomationBackfillRow,
} from './automation-backfill.repository.js';
import { serializeAutomationBackfill } from './automation-backfill.serializer.js';
import type {
  AutomationBackfillGetInput,
  AutomationBackfillOutput,
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
  'findLiveByPublicId' | 'lockLiveByPublicId'
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
      callback: () => this.backfillRepository.failOpenForPlanFeatureOff(organizationId),
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

/** `409 automation_backfill_in_progress` — "Past comments are already being read" (AU31). */
function inProgressError(): ConflictError {
  return new ConflictError('errors:automationBackfillInProgress').withReason(
    'automation_backfill_in_progress',
  );
}
