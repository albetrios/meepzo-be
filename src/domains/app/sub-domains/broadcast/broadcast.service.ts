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
import { CHANNEL_CAPABILITIES } from '@/domains/app/sub-domains/channel-account/channel-account-capabilities.constants.js';
import type { AutomationChannelAccount } from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import { listAutomationUploads } from '@/domains/app/sub-domains/automation/automation.validator.js';
import type { SegmentConditions } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';
import {
  type BroadcastSegmentRepository,
  segmentAutomationPublicIds,
} from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.repository.js';
import {
  ConflictError,
  NotFoundError,
  UnprocessableEntityError,
  fieldValidationError,
  type ValidationErrorItem,
} from '@/shared/errors/index.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { getPostgresErrorCode } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { isPostgresStatementTimeoutError } from '@/shared/utils/infrastructure/timeout-error.util.js';
import { SEGMENT_BACKGROUND_COUNT_STATEMENT_TIMEOUT_MS } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.constants.js';
import { assertRecordNotChangedSince } from '@/shared/utils/validation/record-fields.util.js';
import { BROADCAST_STATUS_BY_MODE } from './broadcast.constants.js';
import type { BroadcastMessages } from './broadcast.dto.js';
import type {
  BroadcastDraftValues,
  BroadcastRepository,
  BroadcastViewRow,
} from './broadcast.repository.js';
import { serializeBroadcast } from './broadcast.serializer.js';
import type {
  BroadcastAccountRead,
  BroadcastCaller,
  BroadcastCreateInput,
  BroadcastFeatureCheck,
  BroadcastListQuery,
  BroadcastOutput,
  BroadcastPageOutput,
  BroadcastSendInput,
  BroadcastServicePorts,
  BroadcastUpdateInput,
  BroadcastWritableInput,
} from './broadcast.types.js';

/** The day in milliseconds — `ends_at` of a "when her chat opens" broadcast (BC10). */

/**
 * What route 73 changed, for the controller's audit entry (BC6).
 *
 * @remarks
 * Notes: `changedFields` names fields only, never values; empty when the body changed nothing.
 */
export interface BroadcastUpdateResult {
  broadcast: BroadcastOutput;
  /** The fields that changed — names only. */
  changedFields: string[];
}

/** `404 broadcast_not_found` — absent, deleted or another organization's (7.A.9). */
function broadcastNotFoundError(): NotFoundError {
  return new NotFoundError('Broadcast').withReason('broadcast_not_found');
}

/** `409 transition_not_allowed` — the status machine refuses the action (BC9). */
function transitionNotAllowedError(): ConflictError {
  return new ConflictError('errors:broadcastTransitionNotAllowed').withReason(
    'transition_not_allowed',
  );
}

/** `409 instagram_not_connected` — route 75 on a `revoked` or `error` account (7.A.9). */
function accountNotConnectedConflict(): ConflictError {
  return new ConflictError('errors:notFound', { resource: 'Instagram account' }).withReason(
    'instagram_not_connected',
  );
}

/** Whether the account and its connection can send now (BC5). */
function isAccountUsable(account: AutomationChannelAccount): boolean {
  return (
    account.connection_status === 'connected' &&
    account.channel_connection_status !== 'error' &&
    account.channel_connection_status !== 'revoked'
  );
}

/** An empty first page — the list of an account the organization does not have (as segments). */
function emptyBroadcastPage(limit: number): BroadcastPageOutput {
  return { items: [], limit, has_more: false, next_cursor: null, total: 0 };
}

/** A value as JSON text — two values differ when their texts do. */
function jsonTextOf(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * The broadcast service (feat-instagram-dm-sending routes-final § 7.A — routes 70–76): one
 * account's broadcasts — the draft, the send with its copy of the audience, the cancel and delete.
 *
 * @remarks
 * Algorithm:
 * - Routes run in the caller's organization scope (`withAppDatabaseContext`), team-only (7.5):
 *   reads answer `404 team_organization_required` on a personal organization, writes `422`.
 * - Create (71) and send (75) ask 1B's one feature check for `broadcasts` first (BC3) and check the
 *   messages' kinds against the account's channel (`422 channel_lacks_feature`, BC18); reading,
 *   editing a draft, cancelling and deleting stay open, so drafts survive a move down (D57). The
 *   read-only plan guard (`403 organization_read_only`) is route 75's pre-handler.
 * - The audience is a live segment of the account (`segment_id`) or one-off conditions (BC8) — every
 *   automation they name the account's (`400`); the button's `start_automation_id` a live automation
 *   of the account (`400`). Each message's own checks are the validator's (`400`).
 * - Every write locks the row (`FOR UPDATE`) and moves it with one guarded statement (BC9); the send
 *   (BC10) checks, in one unit under the lock, the status, the account, the month limit and
 *   completeness (`422 broadcast_incomplete` naming `messages` or `audience`), takes the copy of the
 *   conditions, and moves the draft. After the commit the send queue (R46) adds the audience task
 *   (`now`) or the matched count (`when_chat_opens`).
 *
 * Failure modes: `404 broadcast_not_found`, `404 instagram_not_connected` (71), `400` on a field,
 * `403 plan_lacks_feature` (and the feature check's other refusals), `409 broadcast_not_draft`,
 * `409 record_changed`, `409 broadcast_active`, `409 transition_not_allowed`, `409
 * instagram_not_connected` (75), `409 message_month_limit_reached`, `422 broadcast_incomplete`,
 * `404 team_organization_required` / `422` on a personal organization.
 *
 * Side effects: writes `app.broadcasts`; route 75 starts background work after its commit through
 * the send queue port. The audit entries are the controller's, after commit (BC6). The waiting
 * recipients and messages of a cancelled broadcast are settled by the end duty (WC-29, ROUTE row R47).
 */
export class BroadcastService {
  constructor(
    private readonly broadcastRepository: BroadcastRepository,
    private readonly segmentRepository: BroadcastSegmentRepository,
    private readonly organizationService: OrganizationService,
    private readonly accountRead: BroadcastAccountRead,
    private readonly featureCheck: BroadcastFeatureCheck,
    private readonly ports: BroadcastServicePorts = {},
  ) {}

  /**
   * One page of one account's live broadcasts (route 70) with their numbers, the capped total on the
   * first page.
   *
   * @remarks
   * Algorithm: one unit — the team check, the account (an unknown one → an empty page), the list
   * (default newest first; `name` A→Z), the creators' public ids in one batch. Failure modes: `404
   * team_organization_required`. Side effects: none.
   */
  async listBroadcasts({
    scope,
    query,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    query: BroadcastListQuery;
  }): Promise<BroadcastPageOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        const account = await this.accountRead({
          scope,
          organizationId: organization.id,
          account: { channelAccountPublicId: query.channelAccountPublicId },
        });
        if (account === null) return emptyBroadcastPage(query.limit);
        const sort = query.sort ?? 'created_at';
        const page = await this.broadcastRepository.list({
          organizationId: organization.id,
          query: {
            channelAccountId: account.id,
            statuses: query.statuses,
            mode: query.mode,
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
   * One live broadcast (route 72).
   *
   * @remarks
   * Algorithm: one unit — the team check and the read. Failure modes: `404 broadcast_not_found`,
   * `404 team_organization_required`. Side effects: none.
   */
  async getBroadcast({
    scope,
    broadcastPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    broadcastPublicId: string;
  }): Promise<BroadcastOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        const row = await this.broadcastRepository.findLiveByPublicId({
          organizationId: organization.id,
          broadcastPublicId,
        });
        if (row === null) throw broadcastNotFoundError();
        return this.serializeRow(row);
      },
    });
  }

  /**
   * Makes a draft on one account (route 71, BC8).
   *
   * @remarks
   * Algorithm: a unit for the team check (`422`) and the account (not the organization's, or
   * `revoked` → `404 instagram_not_connected`); the feature check for `broadcasts` and the messages'
   * kinds; then one unit — the audience and the button resolved (`400`) and the insert as `draft`
   * with the creator. Failure modes: as the class lists. Side effects: one row.
   */
  async createBroadcast({
    caller,
    input,
  }: {
    caller: BroadcastCaller;
    input: BroadcastCreateInput;
  }): Promise<BroadcastOutput> {
    const { organizationId, account } = await withAppDatabaseContext({
      scope: caller.scope,
      callback: async () => {
        const organization = await this.requireWritableOrganizationId(caller.scope);
        const found = await this.accountRead({
          scope: caller.scope,
          organizationId: organization,
          account: { channelAccountPublicId: input.channelAccountPublicId },
        });
        if (found === null || found.connection_status === 'revoked') {
          throw new NotFoundError('Instagram account').withReason('instagram_not_connected');
        }
        return { organizationId: organization, account: found };
      },
    });
    await this.assertBroadcastsFeature({
      scope: caller.scope,
      organizationId,
      account,
      messages: input.messages ?? [],
    });
    return withAppDatabaseContext({
      scope: caller.scope,
      callback: async () => {
        const values = await this.resolveDraftValues({
          organizationId,
          channelAccountId: account.id,
          input,
        });
        const row = await this.broadcastRepository.insert({
          organizationId,
          channelAccount: account,
          name: input.name,
          values,
          createdByUserId: await this.resolveUserInternalId(caller.userPublicId),
        });
        const view = await this.broadcastRepository.findLiveView({
          organizationId,
          broadcastId: row.id,
        });
        return this.serializeRow(view as BroadcastViewRow);
      },
    });
  }

  /**
   * Edits a draft (route 73, BC8, BC9): its name, audience (sending one clears the other), messages
   * or button automation.
   *
   * @remarks
   * Algorithm: one unit — the team check (`422`), the broadcast locked (`404`), not `draft` → `409
   * broadcast_not_draft`, `expected_updated_at` older than the row → `409 record_changed`, the new
   * values resolved (`400`), the guarded write when something changed. Open on every plan (BC3).
   * Failure modes: as the class lists. Side effects: one row.
   */
  async updateBroadcast({
    caller,
    broadcastPublicId,
    input,
  }: {
    caller: BroadcastCaller;
    broadcastPublicId: string;
    input: BroadcastUpdateInput;
  }): Promise<BroadcastUpdateResult> {
    return withAppDatabaseContext({
      scope: caller.scope,
      callback: async () => {
        const organizationId = await this.requireWritableOrganizationId(caller.scope);
        const locked = await this.lockBroadcast({ organizationId, broadcastPublicId });
        if (locked.status !== 'draft') {
          throw new ConflictError('errors:broadcastNotDraft').withReason('broadcast_not_draft');
        }
        await assertRecordNotChangedSince({
          row: locked,
          expected: input.expectedUpdatedAt,
          resolveUserPublicId: (userInternalId) =>
            this.organizationService.resolveUserPublicIdByInternalId(userInternalId),
        });
        const resolved = await this.resolveDraftValues({
          organizationId,
          channelAccountId: locked.channel_account_id,
          input,
        });
        const values: BroadcastDraftValues = {};
        const changedFields: string[] = [];
        for (const field of Object.keys(resolved) as (keyof BroadcastDraftValues)[]) {
          if (jsonTextOf(resolved[field]) !== jsonTextOf(locked[field])) {
            Object.assign(values, { [field]: resolved[field] });
            changedFields.push(field);
          }
        }
        if (changedFields.length === 0) {
          return { broadcast: await this.serializeRow(locked), changedFields };
        }
        const isUpdated = await this.broadcastRepository.updateDraft({
          organizationId,
          broadcastId: locked.id,
          values,
          updatedByUserId: await this.resolveUserInternalId(caller.userPublicId),
        });
        if (!isUpdated) throw broadcastNotFoundError();
        const view = await this.broadcastRepository.findLiveView({
          organizationId,
          broadcastId: locked.id,
        });
        return { broadcast: await this.serializeRow(view as BroadcastViewRow), changedFields };
      },
    });
  }

  /**
   * Deletes a broadcast that is not active (route 74, BC4, BC11): soft.
   *
   * @remarks
   * Algorithm: one unit — the team check (`422`), the broadcast locked (`404`), `scheduled`,
   * `sending` or `waiting_for_chats` → `409 broadcast_active` ("cancel it first"), the soft delete.
   * Open on every plan. Failure modes: as the class lists (a repeat `404`). Side effects: the row's
   * `deleted_at`.
   */
  async deleteBroadcast({
    caller,
    broadcastPublicId,
  }: {
    caller: BroadcastCaller;
    broadcastPublicId: string;
  }): Promise<{ broadcastPublicId: string; status: string }> {
    return withAppDatabaseContext({
      scope: caller.scope,
      callback: async () => {
        const organizationId = await this.requireWritableOrganizationId(caller.scope);
        const locked = await this.lockBroadcast({ organizationId, broadcastPublicId });
        const isDeleted = await this.broadcastRepository.softDelete({
          organizationId,
          broadcastId: locked.id,
          updatedByUserId: await this.resolveUserInternalId(caller.userPublicId),
        });
        if (!isDeleted) {
          throw new ConflictError('errors:broadcastActive').withReason('broadcast_active');
        }
        return { broadcastPublicId: locked.public_id, status: locked.status };
      },
    });
  }

  /**
   * Sends a draft (route 75, BC10): now, at a time, or whenever her chat opens in the next 1–7 days.
   *
   * @remarks
   * Algorithm: a unit for the team check (`422`) and the broadcast (`404`); the feature check for
   * `broadcasts` and the messages' kinds (BC3, BC18); then one unit under the row lock — not `draft`
   * → `409 transition_not_allowed`; the account not `connected` (or its connection `error` /
   * `revoked`) → `409 instagram_not_connected`; the month count at its limit → `409
   * message_month_limit_reached`; no messages, no live audience or a file not usable → `422
   * broadcast_incomplete` with `errors[]`; the copy of the conditions (a segment's, so a later
   * segment edit never changes it — AC-9.8); the move to `sending`, `scheduled` or
   * `waiting_for_chats` with its times (`started_at` now except for `scheduled`, which the start duty
   * sets — R47). After the commit, the send queue (R46). Failure modes: as the class lists. Side
   * effects: one row; one queued task through the port.
   */
  async sendBroadcast({
    caller,
    broadcastPublicId,
    input,
  }: {
    caller: BroadcastCaller;
    broadcastPublicId: string;
    input: BroadcastSendInput;
  }): Promise<BroadcastOutput> {
    const { organizationId, broadcast } = await withAppDatabaseContext({
      scope: caller.scope,
      callback: async () => {
        const organization = await this.requireWritableOrganizationId(caller.scope);
        const found = await this.broadcastRepository.findLiveByPublicId({
          organizationId: organization,
          broadcastPublicId,
        });
        if (found === null) throw broadcastNotFoundError();
        return { organizationId: organization, broadcast: found };
      },
    });
    const account = await this.accountRead({
      scope: caller.scope,
      organizationId,
      account: { channelAccountId: broadcast.channel_account_id },
    });
    if (account === null) throw accountNotConnectedConflict();
    await this.assertBroadcastsFeature({
      scope: caller.scope,
      organizationId,
      account,
      messages: broadcast.messages,
    });
    const sent = await withAppDatabaseContext({
      scope: caller.scope,
      callback: async () => {
        const locked = await this.lockBroadcast({ organizationId, broadcastPublicId });
        if (locked.status !== 'draft') throw transitionNotAllowedError();
        if (!isAccountUsable(account)) throw accountNotConnectedConflict();
        await this.assertMonthLimitNotReached({ scope: caller.scope, organizationId });
        const conditions = await this.requireCompleteDraft({ scope: caller.scope, locked });
        const now = Date.now();
        const isUpdated = await this.broadcastRepository.markSent({
          organizationId,
          broadcastId: locked.id,
          values: {
            status: BROADCAST_STATUS_BY_MODE[input.mode],
            mode: input.mode,
            conditions,
            scheduledAt: input.mode === 'scheduled' ? input.scheduledAt : null,
            endsAt:
              input.mode === 'when_chat_opens'
                ? new Date(now + input.openWaitDays * MILLISECONDS_PER_DAY)
                : null,
            isStarted: input.mode !== 'scheduled',
          },
          updatedByUserId: await this.resolveUserInternalId(caller.userPublicId),
        });
        if (!isUpdated) throw transitionNotAllowedError();
        const view = await this.broadcastRepository.findLiveView({
          organizationId,
          broadcastId: locked.id,
        });
        return this.serializeRow(view as BroadcastViewRow);
      },
    });
    const key = {
      organizationPublicId: caller.scope.organizationPublicId,
      broadcastPublicId: sent.id,
      channelAccountPublicId: sent.channel_account_id,
    };
    if (input.mode === 'now') await this.ports.sendQueue?.enqueueBroadcastAudience(key);
    if (input.mode === 'when_chat_opens') {
      await this.ports.sendQueue?.enqueueBroadcastMatchedCount(key);
    }
    return sent;
  }

  /**
   * The `segment-count` task's broadcast form (BC10, WC-39 — ROUTE row R46): `matched` of a "when
   * her chat opens" broadcast, counted from its copy of the conditions.
   *
   * @remarks
   * Algorithm: a unit in the job's scope reads the broadcast (gone, or no longer
   * `waiting_for_chats` → nothing) and its tree's automations (one no longer the account's →
   * nothing); a second unit counts under the background count's 30 s statement timeout and sets
   * `matched` only while the broadcast still waits for chats. Answers the number set, or `null`.
   * Failure modes: a count past 30 s is logged and answers `null` (`matched` stays 0); other database
   * errors propagate. Side effects: `matched`.
   */
  async countWaitingBroadcastMatched({
    scope,
    broadcastPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    broadcastPublicId: string;
  }): Promise<number | null> {
    try {
      return await withAppDatabaseContext({
        scope,
        callback: async () => {
          const organization = await this.organizationService.requireOrganizationByPublicId(
            scope.organizationPublicId,
          );
          const broadcast = await this.broadcastRepository.findLiveByPublicId({
            organizationId: organization.id,
            broadcastPublicId,
          });
          if (
            broadcast === null ||
            broadcast.status !== 'waiting_for_chats' ||
            broadcast.conditions === null
          ) {
            return null;
          }
          const conditions = broadcast.conditions as SegmentConditions;
          const publicIds = segmentAutomationPublicIds(conditions);
          const automationIds = await this.segmentRepository.findAccountAutomationIds({
            organizationId: organization.id,
            channelAccountId: broadcast.channel_account_id,
            automationPublicIds: publicIds,
          });
          if (publicIds.some((publicId) => !automationIds.has(publicId))) return null;
          const count = await this.segmentRepository.countAudience({
            organizationId: organization.id,
            channelAccountId: broadcast.channel_account_id,
            conditions,
            automationIds,
            statementTimeoutMilliseconds: SEGMENT_BACKGROUND_COUNT_STATEMENT_TIMEOUT_MS,
          });
          const isSet = await this.broadcastRepository.setWaitingMatched({
            organizationId: organization.id,
            broadcastId: broadcast.id,
            matched: count.matched,
          });
          return isSet ? count.matched : null;
        },
      });
    } catch (error) {
      if (!isPostgresStatementTimeoutError(error) && getPostgresErrorCode(error) !== '57014') {
        throw error;
      }
      logger.warn(
        { organizationPublicId: scope.organizationPublicId, broadcastPublicId },
        'broadcast matched count timed out',
      );
      return null;
    }
  }

  /**
   * Cancels a broadcast by its owner (route 76, BC11): from `draft`, `scheduled`, `sending` or
   * `waiting_for_chats`.
   *
   * @remarks
   * Algorithm: one unit — the team check (`422`), the broadcast locked (`404`), the guarded move to
   * `cancelled` (`cancelled_at`, `cancel_reason` `owner`); `done` or `cancelled` → `409
   * transition_not_allowed`. Open on every plan. Failure modes: as the class lists. Side effects: one
   * row; the end duty (WC-29, R47) settles its waiting recipients and messages, and until then the
   * broadcast lane skips them (R45).
   */
  async cancelBroadcast({
    caller,
    broadcastPublicId,
  }: {
    caller: BroadcastCaller;
    broadcastPublicId: string;
  }): Promise<{ broadcast: BroadcastOutput; previousStatus: string }> {
    return withAppDatabaseContext({
      scope: caller.scope,
      callback: async () => {
        const organizationId = await this.requireWritableOrganizationId(caller.scope);
        const locked = await this.lockBroadcast({ organizationId, broadcastPublicId });
        const isCancelled = await this.broadcastRepository.cancelByOwner({
          organizationId,
          broadcastId: locked.id,
          updatedByUserId: await this.resolveUserInternalId(caller.userPublicId),
        });
        if (!isCancelled) throw transitionNotAllowedError();
        const view = await this.broadcastRepository.findLiveView({
          organizationId,
          broadcastId: locked.id,
        });
        return {
          broadcast: await this.serializeRow(view as BroadcastViewRow),
          previousStatus: locked.status,
        };
      },
    });
  }

  /**
   * The segment delete's step (route 81, BC17): empties `segment_id` on the organization's drafts
   * that use the segment, in the delete's transaction — registered as a `SegmentDeleteStep`.
   *
   * @remarks
   * Algorithm: one guarded `UPDATE` in the caller's open unit. Failure modes: none of its own. Side
   * effects: the drafts' `segment_id`; sent broadcasts keep theirs (their copy is what they send).
   */
  async clearDraftSegment({
    organizationId,
    segmentId,
  }: {
    organizationId: number;
    segmentId: number;
  }): Promise<void> {
    await this.broadcastRepository.clearDraftSegment({ organizationId, segmentId });
  }

  /** The team check for a write (`422`); the organization's internal id. In the caller's unit. */
  private async requireWritableOrganizationId(
    scope: OrganizationPrincipalDatabaseScope,
  ): Promise<number> {
    const organization = await this.organizationService.requireOrganizationByPublicId(
      scope.organizationPublicId,
    );
    assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
    return organization.id;
  }

  /** The organization's live broadcast, locked `FOR UPDATE`; `404` when absent. */
  private async lockBroadcast({
    organizationId,
    broadcastPublicId,
  }: {
    organizationId: number;
    broadcastPublicId: string;
  }): Promise<BroadcastViewRow> {
    const locked = await this.broadcastRepository.findLiveByPublicId({
      organizationId,
      broadcastPublicId,
      lock: true,
    });
    if (locked === null) throw broadcastNotFoundError();
    return locked;
  }

  /**
   * 1B's one feature check for `broadcasts` (BC3) and the messages' kinds against the account's
   * channel (BC18); a refusal is the route's error (P61).
   */
  private async assertBroadcastsFeature({
    scope,
    organizationId,
    account,
    messages,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    account: AutomationChannelAccount;
    messages: BroadcastMessages;
  }): Promise<void> {
    const check = await this.featureCheck({
      scope,
      organizationId,
      channelAccountId: account.id,
      feature: 'broadcasts',
    });
    if (!check.isAllowed) throw channelFeatureRefusalError(check.reason);
    const kinds = CHANNEL_CAPABILITIES[account.channel].messageKinds;
    if (messages.some((message) => !kinds.includes(message.kind))) {
      throw channelFeatureRefusalError('channel_lacks_feature');
    }
  }

  /** `409 message_month_limit_reached` when sub-domain 6's month count says the DMs are used up. */
  private async assertMonthLimitNotReached({
    scope,
    organizationId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
  }): Promise<void> {
    const stop = await this.ports.monthLimit?.readOrganizationPlanStop({ scope, organizationId });
    if (stop === 'plan_limit') {
      throw new ConflictError('errors:messageMonthLimitReached').withReason(
        'message_month_limit_reached',
      );
    }
  }

  /**
   * The draft's completeness at send (BC10): 1–3 messages, a live audience, every file usable — else
   * `422 broadcast_incomplete` with `errors[]`; answers the copy of its conditions.
   */
  private async requireCompleteDraft({
    scope,
    locked,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    locked: BroadcastViewRow;
  }): Promise<SegmentConditions> {
    const items: ValidationErrorItem[] = [];
    if (locked.messages.length === 0) {
      items.push({
        field: 'messages',
        reason: 'missing',
        messageKey: 'errors:broadcastProblems.messages_missing',
      });
    }
    for (const upload of listAutomationUploads({ messages: locked.messages })) {
      const file = await this.ports.messageFilePort?.findUsableMessageFile({
        scope,
        uploadPublicId: upload.uploadPublicId,
      });
      if (this.ports.messageFilePort !== undefined && file === null) {
        items.push({
          field: upload.field.replace(/^steps\./, ''),
          reason: 'file_not_usable',
          messageKey: 'errors:broadcastProblems.file_not_usable',
        });
      }
    }
    let conditions = locked.conditions;
    if (locked.segment_id !== null && locked.segment_public_id !== null) {
      const segment = await this.segmentRepository.findLiveByPublicId({
        organizationId: locked.organization_id,
        segmentPublicId: locked.segment_public_id,
      });
      conditions = segment?.conditions ?? null;
    }
    if (conditions === null) {
      items.push({
        field: 'audience',
        reason: 'missing',
        messageKey: 'errors:broadcastProblems.audience_missing',
      });
    }
    if (items.length > 0 || conditions === null) {
      throw new UnprocessableEntityError('errors:broadcastIncomplete')
        .withReason('broadcast_incomplete')
        .withErrorItems(items);
    }
    return conditions;
  }

  /**
   * The draft values of a body (routes 71, 73), resolved to internal ids: a live segment of the
   * account (`400` on `segment_id`), conditions naming only the account's automations (`400` on
   * `conditions`), a live automation of the account for the button (`400` on
   * `start_automation_id`). One audience given clears the other; `undefined` is left out.
   */
  private async resolveDraftValues({
    organizationId,
    channelAccountId,
    input,
  }: {
    organizationId: number;
    channelAccountId: number;
    input: BroadcastWritableInput;
  }): Promise<BroadcastDraftValues> {
    const values: BroadcastDraftValues = {};
    if (input.name !== undefined) values.name = input.name;
    if (input.messages !== undefined) values.messages = input.messages;
    if (input.segmentPublicId !== undefined && input.segmentPublicId !== null) {
      const segment = await this.segmentRepository.findLiveByPublicId({
        organizationId,
        segmentPublicId: input.segmentPublicId,
      });
      if (segment === null || segment.channel_account_id !== channelAccountId) {
        throw fieldValidationError({
          field: 'segment_id',
          messageKey: 'errors:validation.broadcastSegmentUnknown',
        });
      }
      values.segment_id = segment.id;
      values.conditions = null;
    } else if (input.segmentPublicId === null) {
      values.segment_id = null;
    }
    if (input.conditions !== undefined && input.conditions !== null) {
      await this.assertConditionAutomationsOwned({
        organizationId,
        channelAccountId,
        conditions: input.conditions,
      });
      values.conditions = input.conditions;
      values.segment_id = null;
    } else if (input.conditions === null) {
      values.conditions = null;
    }
    if (input.startAutomationPublicId !== undefined && input.startAutomationPublicId !== null) {
      const automationId = await this.broadcastRepository.findLiveAccountAutomationId({
        organizationId,
        channelAccountId,
        automationPublicId: input.startAutomationPublicId,
      });
      if (automationId === null) {
        throw fieldValidationError({
          field: 'start_automation_id',
          messageKey: 'errors:validation.broadcastStartAutomationUnknown',
        });
      }
      values.start_automation_id = automationId;
    } else if (input.startAutomationPublicId === null) {
      values.start_automation_id = null;
    }
    return values;
  }

  /** Every automation the conditions name is the account's, else `400` on `conditions` (BC12). */
  private async assertConditionAutomationsOwned({
    organizationId,
    channelAccountId,
    conditions,
  }: {
    organizationId: number;
    channelAccountId: number;
    conditions: SegmentConditions;
  }): Promise<void> {
    const publicIds = segmentAutomationPublicIds(conditions);
    const found = await this.segmentRepository.findAccountAutomationIds({
      organizationId,
      channelAccountId,
      automationPublicIds: publicIds,
    });
    if (publicIds.some((publicId) => !found.has(publicId))) {
      throw fieldValidationError({
        field: 'conditions',
        messageKey: 'errors:validation.segmentConditionsForeignId',
      });
    }
  }

  /** The acting user's internal id, or `null` for an API key. */
  private resolveUserInternalId(userPublicId: string): Promise<number | null> {
    return this.organizationService.resolveUserInternalIdByPublicId(userPublicId);
  }

  /** Serializes one row with its creator's public id. */
  private async serializeRow(row: BroadcastViewRow): Promise<BroadcastOutput> {
    const [output] = await this.serializeRows([row]);
    return output as BroadcastOutput;
  }

  /** Serializes rows with their creators' public ids, resolved in one batch. */
  private async serializeRows(rows: readonly BroadcastViewRow[]): Promise<BroadcastOutput[]> {
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
      serializeBroadcast({
        broadcast: row,
        created_by_user_public_id:
          row.created_by_user_id === null
            ? null
            : (userPublicIds.get(row.created_by_user_id) ?? null),
      }),
    );
  }
}
