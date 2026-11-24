import { createHash } from 'node:crypto';
import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  assertTeamOrganization,
  assertTeamOrganizationForRead,
} from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import { channelFeatureRefusalError } from '@/domains/app/sub-domains/channel-account/channel-account-error.util.js';
import {
  NotFoundError,
  ServiceUnavailableError,
  fieldValidationError,
  type ValidationError,
} from '@/shared/errors/index.js';
import { getPostgresErrorCode } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { isPostgresStatementTimeoutError } from '@/shared/utils/infrastructure/timeout-error.util.js';
import { assertRecordNotChangedSince } from '@/shared/utils/validation/record-fields.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { SegmentConditions } from './broadcast-segment.dto.js';
import {
  type BroadcastSegmentRepository,
  type SegmentChannelAccount,
  type SegmentRow,
  type SegmentViewRow,
  segmentAutomationPublicIds,
} from './broadcast-segment.repository.js';
import { serializeSegment, serializeSegmentAudienceCount } from './broadcast-segment.serializer.js';
import type {
  SegmentAudienceCount,
  SegmentAudienceCountInput,
  SegmentAudienceCountOutput,
  SegmentBackgroundCountPort,
  SegmentCaller,
  SegmentCreateInput,
  SegmentFeatureCheck,
  SegmentListQuery,
  SegmentOutput,
  SegmentPageOutput,
  SegmentUpdateInput,
} from './broadcast-segment.types.js';

/**
 * A step route 81 runs in the segment delete's transaction (BC15): the broadcasts' "empty
 * `segment_id` on this account's drafts that use it" — registered by ROUTE row R22, which builds
 * `app.broadcasts`.
 *
 * @remarks
 * Side effects: the step's own writes, in the caller's unit; a step that throws rolls the delete back.
 */
export type SegmentDeleteStep = (options: {
  organizationId: number;
  segmentId: number;
}) => Promise<void>;

/**
 * The ports later ROUTE rows fill (KICKOFF build-order rule): the delete steps (R22) and the
 * background count (R46).
 *
 * @remarks
 * Notes: both optional — no delete step does nothing; no background count makes an inline count
 * past its timeout answer `503 segment_count_unavailable`.
 */
export interface BroadcastSegmentServicePorts {
  /** Run in route 81's transaction (BC15). */
  deleteSteps?: readonly SegmentDeleteStep[];
  /** The `segment-count` task and its Redis copy (BC14, WC-39 — R46). */
  backgroundCount?: SegmentBackgroundCountPort;
}

/**
 * What route 80 changed, for the controller's audit entry (BC6).
 *
 * @remarks
 * Notes: `changedFields` names fields only, never values; empty when the body changed nothing.
 */
export interface SegmentUpdateResult {
  segment: SegmentOutput;
  /** The fields that changed — names only. */
  changedFields: string[];
}

/** `404 segment_not_found` — absent, deleted or another organization's (7.B.9). */
function segmentNotFoundError(): NotFoundError {
  return new NotFoundError('Segment').withReason('segment_not_found');
}

/** `404 channel_account_not_found` — not an account of the organization (1B.5). */
function channelAccountNotFoundError(): NotFoundError {
  return new NotFoundError('Channel account').withReason('channel_account_not_found');
}

/** `400` on `conditions` — an automation it names is not this account's (BC12). */
function foreignConditionIdError(): ValidationError {
  return fieldValidationError({
    field: 'conditions',
    messageKey: 'errors:validation.segmentConditionsForeignId',
  });
}

/** An empty first page — the list of an account the organization does not have (as contacts). */
function emptySegmentPage(limit: number): SegmentPageOutput {
  return { items: [], limit, has_more: false, next_cursor: null, total: 0 };
}

/** A stable hash of a condition tree — the background count's dedupe key with the account. */
function hashConditions(conditions: SegmentConditions): string {
  return createHash('sha256').update(JSON.stringify(conditions)).digest('hex');
}

/** True when the count was cancelled by its statement timeout (Postgres 57014, BC14). */
function isCountTimeout(error: unknown): boolean {
  return getPostgresErrorCode(error) === '57014' || isPostgresStatementTimeoutError(error);
}

/**
 * The segment service (feat-instagram-dm-sending routes-final § 7.B — routes 77–82): one account's
 * saved audiences and the audience count.
 *
 * @remarks
 * Algorithm:
 * - Routes run in the caller's organization scope (`withAppDatabaseContext`), team-only (7.5):
 *   reads answer `404 team_organization_required` on a personal organization, writes `422`.
 * - Create (78), edit (80) and the count (82) ask 1B's one feature check for `segments` first (BC19,
 *   P76): Free → `403 plan_lacks_feature`; listing (77), reading (79) and deleting (81) stay open, so
 *   a trial's segments stay saved after a move down (D57).
 * - Every automation a tree names (`aut_…`) must be the account's (deleted ones too — their runs
 *   stay), else `400` on `conditions` (BC12). Instagram media ids are kept as given: the comment
 *   logs they are matched against are the account's contacts' own (P309).
 * - The count (BC14) runs inline in its own unit under a 2 s statement timeout; past it, the
 *   background count (R46) is asked and the answer says `is_counting: true` — until R46, `503
 *   segment_count_unavailable`.
 *
 * Failure modes: `404 segment_not_found`, `404 channel_account_not_found`, `400` on `conditions` /
 * `segment_id`, `403 plan_lacks_feature` (and the feature check's other refusals), `409
 * record_changed`, `404 team_organization_required` / `422` on a personal organization, `503
 * segment_count_unavailable`.
 *
 * Side effects: writes `app.segments`; route 81 runs the registered delete steps in its
 * transaction. The audit entries are the controller's, after commit (BC6).
 */
export class BroadcastSegmentService {
  private readonly deleteSteps: readonly SegmentDeleteStep[];

  constructor(
    private readonly segmentRepository: BroadcastSegmentRepository,
    private readonly organizationService: OrganizationService,
    private readonly featureCheck: SegmentFeatureCheck,
    private readonly ports: BroadcastSegmentServicePorts = {},
  ) {
    this.deleteSteps = ports.deleteSteps ?? [];
  }

  /**
   * One page of one account's live segments (route 77), with the capped total on the first page.
   *
   * @remarks
   * Algorithm: one unit — the team check, the account read back (an unknown one → an empty page),
   * the list (default by name A→Z; `created_at` newest first), the creators' public ids in one
   * batch. Failure modes: `404 team_organization_required`. Side effects: none.
   */
  async listSegments({
    scope,
    query,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    query: SegmentListQuery;
  }): Promise<SegmentPageOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        const account = await this.segmentRepository.findChannelAccount({
          organizationId: organization.id,
          channelAccountPublicId: query.channelAccountPublicId,
        });
        if (account === null) return emptySegmentPage(query.limit);
        const sort = query.sort ?? 'name';
        const page = await this.segmentRepository.list({
          organizationId: organization.id,
          query: {
            channelAccountId: account.id,
            q: query.q,
            sort,
            order: query.order ?? (sort === 'name' ? 'asc' : 'desc'),
            limit: query.limit,
            after: query.after,
          },
        });
        return { ...page, items: await this.serializeRows(page.items) };
      },
    });
  }

  /**
   * One live segment (route 79).
   *
   * @remarks
   * Algorithm: one unit — the team check and the read. Failure modes: `404 segment_not_found`,
   * `404 team_organization_required`. Side effects: none.
   */
  async getSegment({
    scope,
    segmentPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    segmentPublicId: string;
  }): Promise<SegmentOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        const segment = await this.segmentRepository.findLiveByPublicId({
          organizationId: organization.id,
          segmentPublicId,
        });
        if (segment === null) throw segmentNotFoundError();
        const [output] = await this.serializeRows([segment]);
        return output as SegmentOutput;
      },
    });
  }

  /**
   * Saves a segment on one account (route 78, BC12, BC19).
   *
   * @remarks
   * Algorithm: a unit for the team check (`422`) and the account (any status — a revoked one may
   * still hold segments; else `404 channel_account_not_found`); the feature check for `segments`;
   * then one unit — the tree's automations resolved (`400` when one is not the account's) and the
   * insert with the creator. Failure modes: as the class lists. Side effects: one row.
   */
  async createSegment({
    caller,
    input,
  }: {
    caller: SegmentCaller;
    input: SegmentCreateInput;
  }): Promise<SegmentOutput> {
    const { organizationId, account } = await this.requireWritableAccount({
      scope: caller.scope,
      channelAccountPublicId: input.channelAccountPublicId,
    });
    await this.assertSegmentsFeature({
      scope: caller.scope,
      organizationId,
      channelAccountId: account.id,
    });
    return withAppDatabaseContext({
      scope: caller.scope,
      callback: async () => {
        await this.resolveAutomationIds({
          organizationId,
          channelAccountId: account.id,
          conditions: input.conditions,
        });
        const createdByUserId = await this.resolveUserInternalId(caller.userPublicId);
        const row = await this.segmentRepository.insert({
          organizationId,
          channelAccount: account,
          name: input.name,
          conditions: input.conditions,
          createdByUserId,
        });
        const [output] = await this.serializeRows([
          { ...row, channel_account_public_id: account.public_id },
        ]);
        return output as SegmentOutput;
      },
    });
  }

  /**
   * Changes a segment's name or conditions (route 80, BC15); drafts that use it follow it.
   *
   * @remarks
   * Algorithm: a unit for the team check and the segment read (`404 segment_not_found`); the feature
   * check on its account; then one unit — the segment locked `FOR UPDATE`, `expected_updated_at`
   * older than the row → `409 record_changed`, new conditions' automations resolved (`400`), the
   * write when something changed. Failure modes: as the class lists. Side effects: one row.
   */
  async updateSegment({
    caller,
    segmentPublicId,
    input,
  }: {
    caller: SegmentCaller;
    segmentPublicId: string;
    input: SegmentUpdateInput;
  }): Promise<SegmentUpdateResult> {
    const { organizationId, segment } = await this.requireWritableSegment({
      scope: caller.scope,
      segmentPublicId,
    });
    await this.assertSegmentsFeature({
      scope: caller.scope,
      organizationId,
      channelAccountId: segment.channel_account_id,
    });
    return withAppDatabaseContext({
      scope: caller.scope,
      callback: async () => {
        const locked = await this.segmentRepository.findLiveByPublicId({
          organizationId,
          segmentPublicId,
          lock: true,
        });
        if (locked === null) throw segmentNotFoundError();
        await assertRecordNotChangedSince({
          row: locked,
          expected: input.expectedUpdatedAt,
          resolveUserPublicId: (userInternalId) =>
            this.organizationService.resolveUserPublicIdByInternalId(userInternalId),
        });
        const values: { name?: string; conditions?: SegmentConditions } = {};
        const changedFields: string[] = [];
        if (input.name !== undefined && input.name !== locked.name) {
          values.name = input.name;
          changedFields.push('name');
        }
        if (
          input.conditions !== undefined &&
          JSON.stringify(input.conditions) !== JSON.stringify(locked.conditions)
        ) {
          await this.resolveAutomationIds({
            organizationId,
            channelAccountId: locked.channel_account_id,
            conditions: input.conditions,
          });
          values.conditions = input.conditions;
          changedFields.push('conditions');
        }
        let row: SegmentViewRow = locked;
        if (changedFields.length > 0) {
          const updated = await this.segmentRepository.update({
            organizationId,
            segmentId: locked.id,
            values,
            updatedByUserId: await this.resolveUserInternalId(caller.userPublicId),
          });
          if (updated === null) throw segmentNotFoundError();
          row = { ...updated, channel_account_public_id: locked.channel_account_public_id };
        }
        const [output] = await this.serializeRows([row]);
        return { segment: output as SegmentOutput, changedFields };
      },
    });
  }

  /**
   * Deletes a segment (route 81, BC4, BC15): soft, and in the same transaction the registered
   * delete steps (R22 empties drafts' `segment_id`).
   *
   * @remarks
   * Algorithm: one unit — the team check (`422`), the segment locked, the soft delete, each step.
   * Open on every plan (BC19). Failure modes: `404 segment_not_found` (a repeat too). Side effects:
   * the row's `deleted_at`; the steps' writes.
   */
  async deleteSegment({
    caller,
    segmentPublicId,
  }: {
    caller: SegmentCaller;
    segmentPublicId: string;
  }): Promise<{ segmentPublicId: string }> {
    return withAppDatabaseContext({
      scope: caller.scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          caller.scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const segment = await this.segmentRepository.findLiveByPublicId({
          organizationId: organization.id,
          segmentPublicId,
          lock: true,
        });
        if (segment === null) throw segmentNotFoundError();
        const deleted = await this.segmentRepository.softDelete({
          organizationId: organization.id,
          segmentId: segment.id,
          updatedByUserId: await this.resolveUserInternalId(caller.userPublicId),
        });
        if (!deleted) throw segmentNotFoundError();
        for (const step of this.deleteSteps) {
          await step({ organizationId: organization.id, segmentId: segment.id });
        }
        return { segmentPublicId: segment.public_id };
      },
    });
  }

  /**
   * Counts an audience (route 82, BC13, BC14): a saved segment of the account, or unsaved
   * conditions.
   *
   * @remarks
   * Algorithm: a unit for the team check (`422`), the account (`404 channel_account_not_found`), the
   * saved segment (`404 segment_not_found`; another account's → `400` on `segment_id`); the feature
   * check for `segments`; a fresh background copy when one exists (R46); else the inline count in
   * its own unit under the 2 s timeout — the tree's automations resolved (`400`). A timeout asks the
   * background count and answers `is_counting: true`, or `503 segment_count_unavailable` while no
   * background count is wired (R46). Failure modes: as the class lists. Side effects: none, or one
   * queued task.
   */
  async countAudience({
    caller,
    input,
  }: {
    caller: SegmentCaller;
    input: SegmentAudienceCountInput;
  }): Promise<SegmentAudienceCountOutput> {
    const { organizationId, account, conditions } = await withAppDatabaseContext({
      scope: caller.scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          caller.scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const found = await this.segmentRepository.findChannelAccount({
          organizationId: organization.id,
          channelAccountPublicId: input.channelAccountPublicId,
        });
        if (found === null) throw channelAccountNotFoundError();
        let tree = input.conditions;
        if (input.segmentPublicId !== undefined) {
          const segment = await this.segmentRepository.findLiveByPublicId({
            organizationId: organization.id,
            segmentPublicId: input.segmentPublicId,
          });
          if (segment === null) throw segmentNotFoundError();
          if (segment.channel_account_id !== found.id) {
            throw fieldValidationError({
              field: 'segment_id',
              messageKey: 'errors:validation.segmentOfAnotherAccount',
            });
          }
          tree = segment.conditions;
        }
        return {
          organizationId: organization.id,
          account: found,
          conditions: tree as SegmentConditions,
        };
      },
    });
    await this.assertSegmentsFeature({
      scope: caller.scope,
      organizationId,
      channelAccountId: account.id,
    });
    const backgroundKey = {
      organizationPublicId: caller.scope.organizationPublicId,
      channelAccountPublicId: account.public_id,
      conditionsHash: hashConditions(conditions),
      conditions,
    };
    const background = this.ports.backgroundCount;
    if (background !== undefined) {
      const cached = await background.readCount(backgroundKey);
      if (cached !== null) return serializeSegmentAudienceCount(cached);
    }
    let count: SegmentAudienceCount;
    try {
      count = await withAppDatabaseContext({
        scope: caller.scope,
        callback: async () => {
          const automationIds = await this.resolveAutomationIds({
            organizationId,
            channelAccountId: account.id,
            conditions,
          });
          return this.segmentRepository.countAudience({
            organizationId,
            channelAccountId: account.id,
            conditions,
            automationIds,
          });
        },
      });
    } catch (error) {
      if (!isCountTimeout(error)) throw error;
      logger.info(
        {
          organizationPublicId: caller.scope.organizationPublicId,
          channelAccountPublicId: account.public_id,
          isBackgroundCountWired: background !== undefined,
        },
        'segment audience count timed out',
      );
      if (background === undefined) {
        throw new ServiceUnavailableError('errors:segmentCountUnavailable').withReason(
          'segment_count_unavailable',
        );
      }
      await background.requestCount(backgroundKey);
      return serializeSegmentAudienceCount(null);
    }
    return serializeSegmentAudienceCount(count);
  }

  /** The team check (`422`) and the organization's account (`404`), in one unit. */
  private async requireWritableAccount({
    scope,
    channelAccountPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
  }): Promise<{ organizationId: number; account: SegmentChannelAccount }> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const account = await this.segmentRepository.findChannelAccount({
          organizationId: organization.id,
          channelAccountPublicId,
        });
        if (account === null) throw channelAccountNotFoundError();
        return { organizationId: organization.id, account };
      },
    });
  }

  /** The team check (`422`) and the organization's live segment (`404`), in one unit. */
  private async requireWritableSegment({
    scope,
    segmentPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    segmentPublicId: string;
  }): Promise<{ organizationId: number; segment: SegmentRow }> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const segment = await this.segmentRepository.findLiveByPublicId({
          organizationId: organization.id,
          segmentPublicId,
        });
        if (segment === null) throw segmentNotFoundError();
        return { organizationId: organization.id, segment };
      },
    });
  }

  /** 1B's one feature check for `segments` (BC19, P76); a refusal is the route's error (P61). */
  private async assertSegmentsFeature({
    scope,
    organizationId,
    channelAccountId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    channelAccountId: number;
  }): Promise<void> {
    const check = await this.featureCheck({
      scope,
      organizationId,
      channelAccountId,
      feature: 'segments',
    });
    if (!check.isAllowed) throw channelFeatureRefusalError(check.reason);
  }

  /** The tree's automations as internal ids — every one the account's, else `400` (BC12). */
  private async resolveAutomationIds({
    organizationId,
    channelAccountId,
    conditions,
  }: {
    organizationId: number;
    channelAccountId: number;
    conditions: SegmentConditions;
  }): Promise<Map<string, number>> {
    const publicIds = segmentAutomationPublicIds(conditions);
    const automationIds = await this.segmentRepository.findAccountAutomationIds({
      organizationId,
      channelAccountId,
      automationPublicIds: publicIds,
    });
    if (publicIds.some((publicId) => !automationIds.has(publicId))) {
      throw foreignConditionIdError();
    }
    return automationIds;
  }

  /** The acting user's internal id, or `null` for an API key. */
  private resolveUserInternalId(userPublicId: string): Promise<number | null> {
    return this.organizationService.resolveUserInternalIdByPublicId(userPublicId);
  }

  /** Serializes rows with their creators' public ids, resolved in one batch. */
  private async serializeRows(
    rows: readonly (SegmentRow & { channel_account_public_id: string })[],
  ): Promise<SegmentOutput[]> {
    const userIds = [
      ...new Set(
        rows
          .map((row) => row.created_by_user_id)
          .filter((userId): userId is number => userId !== null),
      ),
    ];
    const userPublicIds =
      userIds.length === 0
        ? new Map<number, string>()
        : await this.organizationService.resolveUserPublicIdsByInternalIds(userIds);
    return rows.map((row) =>
      serializeSegment({
        segment: row,
        created_by_user_public_id:
          row.created_by_user_id === null
            ? null
            : (userPublicIds.get(row.created_by_user_id) ?? null),
      }),
    );
  }
}
