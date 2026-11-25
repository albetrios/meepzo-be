import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  acquireResourceQuotaLock,
  RESOURCE_QUOTA_LOCK_NAMESPACE,
} from '@/infrastructure/database/resource-quota-lock.util.js';
import { runEnqueueAfterCommit } from '@/core/events/event-bus.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  assertTeamOrganization,
  assertTeamOrganizationForRead,
} from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  fieldValidationError,
} from '@/shared/errors/index.js';
import { assertRecordNotChangedSince } from '@/shared/utils/validation/record-fields.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  type ChannelFailedMessagesRetry,
  type ChannelSendingPort,
  type ChannelSendingPorts,
  emptyFailedMessagesSummary,
} from '@/domains/app/app.channel-ports.js';
import {
  type FailedMessagesRetryOutput,
  type FailedMessagesSummaryOutput,
  serializeFailedMessagesRetry,
  serializeFailedMessagesSummary,
} from '@/domains/app/app.failed-messages.serializer.js';
import type {
  ChannelAccountPlanAccessService,
  ChannelAccountService,
} from '@/domains/app/sub-domains/channel-account/channel-account.service.js';
import type { ChannelFeature } from '@/domains/app/sub-domains/channel-account/channel-account-capabilities.constants.js';
import { CHANNEL_FEATURES } from '@/domains/app/sub-domains/channel-account/channel-account-capabilities.constants.js';
import type { AutomationChannelAccount } from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import { matchAutomationKeyword } from './automation-run/automation-run-matching.util.js';
import {
  AUTOMATION_CATCH_ALL_TRIGGER_TYPES,
  AUTOMATION_COMMENT_TRIGGER_TYPES,
  AUTOMATION_DEFAULT_SORT,
  AUTOMATION_DUPLICATE_NAME_SUFFIX,
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_STARTER_QUESTIONS_MAX_COUNT,
  type AutomationKeywordTestSource,
  type AutomationSortField,
  type AutomationTriggerType,
} from './automation.constants.js';
import type {
  AutomationAccountKey,
  AutomationRepository,
  AutomationRow,
  AutomationWithAccountRow,
} from './automation.repository.js';
import type { AutomationCountService } from './automation-count.service.js';
import type { AutomationOpenBackfillReader } from './automation-backfill/automation-backfill.types.js';
import type { AutomationReplyStateService } from './automation-reply-state.service.js';
import { serializeAutomation, serializeAutomationListRow } from './automation.serializer.js';
import type {
  AutomationActionInput,
  AutomationCreateInput,
  AutomationDeleteInput,
  AutomationDeleteResult,
  AutomationGetInput,
  AutomationKeywordTestInput,
  AutomationKeywordTestOutput,
  AutomationLinkNextPostInput,
  AutomationListInput,
  AutomationMessageFilePort,
  AutomationMonthLimitPort,
  AutomationOpenRunCancelStep,
  AutomationOutput,
  AutomationPageOutput,
  AutomationPauseInput,
  AutomationProblem,
  AutomationAttachmentUploadPort,
  AutomationStarterQuestionSyncQueue,
  AutomationUpdateInput,
  AutomationWarning,
  AutomationWithWarningsOutput,
  AutomationWritableFields,
} from './automation.types.js';
import {
  assertNoContentProblems,
  assertTriggerTypeGroupUnchanged,
  generateAutomationRefCode,
  listAutomationContentProblems,
  listAutomationFeatureParts,
  listAutomationProFeatures,
  listAutomationUploads,
  mergeAutomationForCreate,
  mergeAutomationForUpdate,
} from './automation.validator.js';

/**
 * The channel account reads and the one feature check the automations use (1B, CA11, AU34).
 *
 * @remarks
 * Notes: structural, so a suite that never reads an account can stub it; the app container passes
 * `ChannelAccountService`.
 */
export type AutomationChannelAccountPort = Pick<
  ChannelAccountService,
  'readAutomationAccount' | 'listChannelAccountAutomationProblems'
>;

/**
 * The optional seams of later rows; each absent one skips its side effect.
 *
 * @remarks
 * Notes: the app container wires the month count (R18), the usable-file read (R12) and the open
 * past-comments read (R15); the starter-question sync joins at R40, the channels' sending ports at
 * R19–R20.
 */
export interface AutomationServicePorts {
  /** Go-live check 4 — sub-domain 6's month count (`MessageMonthCountService`, R18). */
  monthLimit?: AutomationMonthLimitPort | undefined;
  /** Go-live check 15's files — the upload domain's usable-file read (R12). */
  messageFiles?: AutomationMessageFilePort | undefined;
  /** The starter-question sync after commit (IA6, R40). */
  starterQuestionSync?: AutomationStarterQuestionSyncQueue | undefined;
  /** The message files' upload after a go-live or a live file change (WC-32, R46). */
  attachmentUploads?: AutomationAttachmentUploadPort | undefined;
  /** Each channel's sending port (AU35, R19–R20): the waiting messages a delete or edit ends. */
  sendingPorts?: ChannelSendingPorts | undefined;
  /** The automation's open past-comments read on its object (`open_backfill`, 4.C — R15). */
  openBackfills?: AutomationOpenBackfillReader | undefined;
}

/** `404 automation_not_found` — absent, deleted or another organization's (4.A.9). */
function automationNotFoundError(): NotFoundError {
  return new NotFoundError('Automation').withReason('automation_not_found');
}

/** `409 automation_ref_code_exists` naming the automation that holds the link name (4.A.9, AC-6.12). */
function refCodeExistsError(name: string): ConflictError {
  return new ConflictError('errors:automationRefCodeExists', { name }).withReason(
    'automation_ref_code_exists',
  );
}

/** `403 plan_lacks_feature` — a save turns on a PRO part the plan lacks (AU4 (2), AU12). */
function planLacksFeatureError(): ForbiddenError {
  return new ForbiddenError('errors:planLacksFeature').withReason('plan_lacks_feature');
}

/** The order a list without `order` uses: newest first, `name` A→Z. */
function defaultAutomationOrder(sort: AutomationSortField): 'asc' | 'desc' {
  return sort === 'name' ? 'asc' : 'desc';
}

/** The fields of a stored row a person writes — what an edit merges its body over. */
function toWritableFields(row: AutomationRow): AutomationWritableFields {
  return {
    name: row.name,
    trigger_type: row.trigger_type as AutomationTriggerType,
    also_start_from: [...row.also_start_from] as AutomationWritableFields['also_start_from'],
    target_scope: row.target_scope as AutomationWritableFields['target_scope'],
    target_instagram_media_id: row.target_instagram_media_id,
    target_instagram_story_id: row.target_instagram_story_id,
    target_starts_at: row.target_starts_at,
    target_ends_at: row.target_ends_at,
    keywords: [...row.keywords],
    ref_code: row.ref_code,
    starter_questions: [...row.starter_questions],
    ad_id: row.ad_id,
    trigger_tag: row.trigger_tag,
    default_reply_mode: row.default_reply_mode as AutomationWritableFields['default_reply_mode'],
    is_public_reply_enabled: row.is_public_reply_enabled,
    public_reply_texts: [...row.public_reply_texts],
    is_public_reply_mention_enabled: row.is_public_reply_mention_enabled,
    is_reply_like_person_enabled: row.is_reply_like_person_enabled,
    public_reply_hour_limit: row.public_reply_hour_limit,
    is_hide_comment_after_direct_message_enabled: row.is_hide_comment_after_direct_message_enabled,
    steps: row.steps,
  };
}

/** The body path a feature-check problem points at (AU34). */
function featureProblemField({
  kind,
  part,
}: {
  kind: 'trigger_type' | 'step' | 'message_kind' | 'feature';
  part: string;
}): string {
  if (kind === 'trigger_type') return 'trigger_type';
  if (kind === 'message_kind') return 'steps.messages';
  if (kind === 'step') return `steps.${part}`;
  return `features.${part}`;
}

/** A problem of the one feature check, with its step path and reason (AU34). */
function featureProblem({
  kind,
  part,
  reason,
}: {
  kind: 'trigger_type' | 'step' | 'message_kind' | 'feature';
  part: string;
  reason: string;
}): AutomationProblem {
  return {
    field: featureProblemField({ kind, part }),
    reason,
    messageKey: `errors:automationProblems.${reason}`,
    messageParams: { part },
  };
}

/** Whether the reply step changed — its box starts again (AU12). */
function isReplyStepChanged({
  stored,
  merged,
}: {
  stored: AutomationWritableFields;
  merged: AutomationWritableFields;
}): boolean {
  return (
    stored.is_public_reply_enabled !== merged.is_public_reply_enabled ||
    stored.is_reply_like_person_enabled !== merged.is_reply_like_person_enabled ||
    stored.public_reply_hour_limit !== merged.public_reply_hour_limit ||
    stored.public_reply_texts.join('\u0000') !== merged.public_reply_texts.join('\u0000')
  );
}

/**
 * The automation service (feat-instagram-dm-sending routes-final § 4.A — routes 27–35): list one
 * account's automations, save drafts, read, save content, delete, go live, pause, duplicate and try a
 * keyword, shared by every channel (P48) — and "next post" linking and the contacts filter's id
 * lookup.
 *
 * @remarks
 * Algorithm:
 * - Routes run in the caller's organization scope (`withAppDatabaseContext`, one transaction),
 *   team-only: reads `404 team_organization_required`, writes `422`.
 * - **Status by actions only (AU3):** a save keeps the status; go-live (32) from `draft` or `paused`
 *   runs every check and answers `409 automation_not_ready` with `errors[]` (AUQ1); pause (33) from
 *   `live`; a repeat of either is a no-op.
 * - **Two levels (AU9, AUQ2):** a draft saves anything of the right shape; a save of a live or paused
 *   one also passes the content checks (`400`, one item per problem), and may not turn a PRO part on
 *   (`403 plan_lacks_feature`); go-live adds the account, month, feature (1B's one check — AU34),
 *   file, starter-total, ref-code and catch-all checks. Warnings (a shared keyword, a private account
 *   on a comment kind) never refuse.
 * - **Lock order (4.A.10):** go-live locks the account row first (the starter-question count), then
 *   the automation; edits, actions and the delete lock the automation `FOR UPDATE`; the run engine
 *   holds it `FOR KEY SHARE` (D47).
 * - **The delete (AU16):** soft delete, every registered open-run cancel step and each channel's
 *   waiting-message cancel (when wired) in one transaction.
 * - **After commit:** a starter-question automation's go-live, pause, delete or question change
 *   enqueues the account's starter-question sync (when wired, R40).
 *
 * Failure modes: the `400`s, `403`s, `404`s and `409`s of 4.A.9; a step that throws rolls back.
 *
 * Side effects: writes `app.automations` (and the reply state's box); the steps' writes. The audit
 * entries are the controller's, after commit (AU7). Never calls a provider.
 */
export class AutomationService {
  constructor(
    private readonly automationRepository: AutomationRepository,
    private readonly countService: AutomationCountService,
    private readonly replyStateService: AutomationReplyStateService,
    private readonly channelAccountPort: AutomationChannelAccountPort,
    private readonly planAccessService: ChannelAccountPlanAccessService,
    private readonly organizationService: OrganizationService,
    private readonly openRunCancelSteps: readonly AutomationOpenRunCancelStep[],
    private readonly ports: AutomationServicePorts = {},
  ) {}

  /**
   * One page of one account's live automations (route 27, AU10) with `meta.totals`.
   *
   * @remarks
   * Algorithm: one unit — the team check, the account's live count (an unknown account is an empty
   * page), the keyset page, the page's slot sums, the account's all-time runs. Failure modes:
   * `404 team_organization_required`. Side effects: none.
   */
  async listAutomations({ scope, query }: AutomationListInput): Promise<AutomationPageOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        const { channelAccountId, liveCount } = await this.automationRepository.countLiveOfAccount({
          organizationId: organization.id,
          channelAccountPublicId: query.channelAccountPublicId,
        });
        if (channelAccountId === null) {
          return {
            items: [],
            limit: query.limit,
            has_more: false,
            next_cursor: null,
            totals: { live_count: 0, runs_started: 0 },
          };
        }
        const sort = query.sort ?? AUTOMATION_DEFAULT_SORT;
        const page = await this.automationRepository.list({
          organizationId: organization.id,
          query: { ...query, sort, order: query.order ?? defaultAutomationOrder(sort) },
        });
        const counts = await this.countService.readCounts({
          scope,
          organizationId: organization.id,
          automationIds: page.items.map((row) => row.id),
        });
        const runsStarted = await this.countService.readAccountRunsStarted({
          scope,
          organizationId: organization.id,
          channelAccountId,
        });
        return {
          items: page.items.map((row) =>
            serializeAutomationListRow({
              automation: row,
              channel_account_public_id: row.channel_account_public_id,
              counts: counts.get(row.id),
            }),
          ),
          limit: page.limit,
          has_more: page.has_more,
          next_cursor: page.next_cursor,
          totals: { live_count: liveCount, runs_started: runsStarted },
        };
      },
    });
  }

  /**
   * One live automation of the organization (route 29, AU17).
   *
   * @remarks
   * Algorithm: one unit — the team check, the read, its counts, the PRO parts off, its users' public
   * ids. Failure modes: `404 automation_not_found`, `404 team_organization_required`. Side effects:
   * none.
   */
  async getAutomation({
    scope,
    automationPublicId,
  }: AutomationGetInput): Promise<AutomationOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        const row = await this.automationRepository.findLiveByPublicId({
          organizationId: organization.id,
          automationPublicId,
        });
        if (row === null) throw automationNotFoundError();
        return this.serialize({ scope, organizationId: organization.id, row });
      },
    });
  }

  /**
   * Saves a draft (route 28, AU11, D28) on the named account and returns it.
   *
   * @remarks
   * Algorithm — one unit: the team check (`422`); the account by its public id (not the
   * organization's → `400 channel_account_id`; revoked → `409 instagram_not_connected`; an `error`
   * one is fine); "Reply like a person" defaults to the plan's switch (D59); a `ref_link` without a
   * `ref_code` gets a free one, a given one must be free on the account (`409
   * automation_ref_code_exists`); the insert as `draft`. Nothing is sent; a read-only plan may
   * create (P10). Failure modes: as above. Side effects: one row.
   */
  async createAutomation({
    scope,
    changes,
    createdByUserPublicId,
  }: AutomationCreateInput): Promise<AutomationOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const account = await this.channelAccountPort.readAutomationAccount({
          scope,
          organizationId: organization.id,
          account: { channelAccountPublicId: changes.channel_account_id },
        });
        if (account === null) {
          throw fieldValidationError({
            field: 'channel_account_id',
            messageKey: 'errors:validation.automationChannelAccountUnknown',
          });
        }
        if (account.connection_status === 'revoked') {
          throw new ConflictError('errors:notFound', { resource: 'Instagram account' }).withReason(
            'instagram_not_connected',
          );
        }
        const switches = await this.readPlanSwitches(scope);
        const fields = mergeAutomationForCreate({
          changes,
          isReplyLikePersonDefault: switches?.reply_like_person === true,
        });
        fields.ref_code = await this.resolveRefCode({
          organizationId: organization.id,
          channelAccountId: account.id,
          excludedAutomationId: null,
          fields,
        });
        const createdByUserId =
          await this.organizationService.resolveUserInternalIdByPublicId(createdByUserPublicId);
        const row = await this.automationRepository.insert({
          organizationId: organization.id,
          channelAccountId: account.id,
          channel: account.channel,
          fields,
          createdByUserId,
        });
        return this.serialize({
          scope,
          organizationId: organization.id,
          row: { ...row, channel_account_public_id: account.public_id },
          account,
        });
      },
    });
  }

  /**
   * Saves content (route 30, AU12) and returns the automation with its warnings.
   *
   * @remarks
   * Algorithm — one unit: the team check; the organization's `AUTOMATION_NEXT_POST` advisory lock
   * (linking's, so a save and a link take turns — launch D26); the row locked `FOR UPDATE`; `expected_updated_at`
   * (`409 record_changed`); a way to start only inside its group (`400 trigger_type`); a linked "next
   * post"'s target is fixed (`409 next_post_already_linked`); the merge; for a `live` or `paused` one
   * the content checks (`400`) and no PRO part turned on that the plan lacks (`403`); the ref code
   * free; the write (a fixed text clears a `bad_text` stop); a reply-step change empties the box;
   * the waiting messages of the channel's removed steps end through its sending port (when wired).
   * Failure modes: as above. Side effects: the row, the reply state; the sync after commit.
   */
  async updateAutomation({
    scope,
    automationPublicId,
    changes,
    expectedUpdatedAt,
    updatedByUserPublicId,
  }: AutomationUpdateInput): Promise<AutomationWithWarningsOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        // A save and "next post" linking take turns (launch D26): the advisory lock, then the row —
        // linking's order — so a save that targets a post and a link of it never cross.
        await acquireResourceQuotaLock({
          namespace: RESOURCE_QUOTA_LOCK_NAMESPACE.AUTOMATION_NEXT_POST,
          key: organization.id,
        });
        const stored = await this.automationRepository.lockLiveByPublicId({
          organizationId: organization.id,
          automationPublicId,
        });
        if (stored === null) throw automationNotFoundError();
        await assertRecordNotChangedSince({
          row: stored,
          expected: expectedUpdatedAt,
          resolveUserPublicId: (userInternalId) =>
            this.organizationService.resolveUserPublicIdByInternalId(userInternalId),
        });
        const storedFields = toWritableFields(stored);
        if (changes.trigger_type !== undefined) {
          assertTriggerTypeGroupUnchanged({
            stored: storedFields.trigger_type,
            next: changes.trigger_type,
          });
        }
        this.assertNextPostLinkUnchanged({ stored, changes });
        const merged = this.withNextPostTarget({
          stored,
          merged: mergeAutomationForUpdate({ stored: storedFields, changes }),
        });
        const isActive = stored.status !== 'draft';
        if (isActive) {
          assertNoContentProblems(listAutomationContentProblems(merged));
          await this.assertNoProFeatureTurnedOn({ scope, stored: storedFields, merged });
        }
        merged.ref_code = await this.resolveRefCode({
          organizationId: organization.id,
          channelAccountId: stored.channel_account_id,
          excludedAutomationId: stored.id,
          fields: merged,
        });
        const updatedByUserId =
          await this.organizationService.resolveUserInternalIdByPublicId(updatedByUserPublicId);
        const isNext = merged.target_scope === 'next' && isActive;
        const row = await this.automationRepository.update({
          organizationId: organization.id,
          automationId: stored.id,
          fields: merged,
          updatedByUserId,
          isStopCleared:
            stored.stopped_reason === 'bad_text' &&
            JSON.stringify(stored.steps) !== JSON.stringify(merged.steps),
          nextPost: {
            status: isNext ? (stored.next_post_status ?? 'waiting') : null,
            linkedAt: isNext ? stored.next_post_linked_at : null,
          },
        });
        if (row === null) throw automationNotFoundError();
        if (isReplyStepChanged({ stored: storedFields, merged })) {
          await this.replyStateService.emptyReplyBox({
            scope,
            key: { organizationId: organization.id, automationId: stored.id },
          });
        }
        await this.skipRemovedWaitingMessages({ stored, merged, organizationId: organization.id });
        if (stored.status === 'live') {
          const storedUploads = new Set(
            listAutomationUploads(storedFields.steps).map((upload) => upload.uploadPublicId),
          );
          await this.requestAttachmentUploads({
            scope,
            channelAccountPublicId: stored.channel_account_public_id,
            uploadPublicIds: listAutomationUploads(merged.steps)
              .map((upload) => upload.uploadPublicId)
              .filter((uploadPublicId) => !storedUploads.has(uploadPublicId)),
          });
        }
        if (
          stored.status === 'live' &&
          this.isStarterQuestionChange({ stored: storedFields, merged })
        ) {
          await this.enqueueStarterQuestionSync({
            scope,
            channelAccountPublicId: stored.channel_account_public_id,
          });
        }
        const warnings =
          stored.status === 'live'
            ? await this.listKeywordWarnings({
                organizationId: organization.id,
                channelAccountId: stored.channel_account_id,
                automationId: stored.id,
                keywords: merged.keywords,
              })
            : [];
        const automation = await this.serialize({
          scope,
          organizationId: organization.id,
          row: { ...row, channel_account_public_id: stored.channel_account_public_id },
        });
        return { automation, warnings, isChanged: true };
      },
    });
  }

  /**
   * Goes live (route 32, AU13, D28, P2, P36) from `draft` or `paused`; a `live` one answers as it is
   * (a repeat, AU3).
   *
   * @remarks
   * Algorithm — one unit:
   * 1. The team check; the automation read; its account locked `FOR UPDATE` (4.A.10), then the
   *    automation locked `FOR UPDATE`. Already `live` → no change.
   * 2. Every check, all run, answered together as `409 automation_not_ready` with `errors[]`: the
   *    account `connected` and its connection not `error` / `revoked`; the month limit (sub-domain 6);
   *    the content checks; every part through 1B's one feature check (`channel_lacks_feature`,
   *    `permission_not_granted`, `plan_lacks_feature`, `feature_not_offered`); the starter questions'
   *    account total ≤ 4, none repeated; the `ref_code` free; one live `first_message` and
   *    `default_reply` per account; each file usable (R12's read).
   * 3. `live`; a `next` one waits from now (AU20). Warnings: a shared keyword; a private account on
   *    a comment kind.
   * 4. After commit: a starter-question one enqueues the sync. The plan-ended `403` is the route's
   *    preHandler (AU4 (1)).
   *
   * Failure modes: as above; `404 automation_not_found`. Side effects: the row; the sync.
   */
  async goLiveAutomation({
    scope,
    automationPublicId,
    actingUserPublicId,
  }: AutomationActionInput): Promise<AutomationWithWarningsOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const unlocked = await this.automationRepository.findLiveByPublicId({
          organizationId: organization.id,
          automationPublicId,
        });
        if (unlocked === null) throw automationNotFoundError();
        const account = await this.channelAccountPort.readAutomationAccount({
          scope,
          organizationId: organization.id,
          account: { channelAccountId: unlocked.channel_account_id },
          isLocked: true,
        });
        const stored = await this.automationRepository.lockLiveByPublicId({
          organizationId: organization.id,
          automationPublicId,
        });
        if (stored === null || account === null) throw automationNotFoundError();
        if (stored.status === 'live') {
          const automation = await this.serialize({
            scope,
            organizationId: organization.id,
            row: stored,
            account,
          });
          return { automation, warnings: [], isChanged: false };
        }
        const fields = toWritableFields(stored);
        const problems = await this.listGoLiveProblems({
          scope,
          organizationId: organization.id,
          stored,
          fields,
          account,
        });
        if (problems.length > 0) {
          throw new ConflictError('errors:automationNotReady', { count: problems.length })
            .withReason('automation_not_ready')
            .withErrorItems(
              problems.map((item) => ({
                field: item.field,
                reason: item.reason,
                messageKey: item.messageKey,
                ...(item.messageParams === undefined ? {} : { messageParams: item.messageParams }),
              })),
            );
        }
        const updatedByUserId =
          await this.organizationService.resolveUserInternalIdByPublicId(actingUserPublicId);
        const row = await this.automationRepository.changeState({
          organizationId: organization.id,
          automationId: stored.id,
          change: {
            status: 'live',
            nextPost:
              stored.target_scope === 'next' && stored.next_post_status === null
                ? { targetStartsAt: new Date() }
                : undefined,
          },
          updatedByUserId,
        });
        if (row === null) throw automationNotFoundError();
        if (stored.trigger_type === 'starter_question') {
          await this.enqueueStarterQuestionSync({
            scope,
            channelAccountPublicId: stored.channel_account_public_id,
          });
        }
        await this.requestAttachmentUploads({
          scope,
          channelAccountPublicId: stored.channel_account_public_id,
          uploadPublicIds: listAutomationUploads(fields.steps).map(
            (upload) => upload.uploadPublicId,
          ),
        });
        const warnings = [
          ...(await this.listKeywordWarnings({
            organizationId: organization.id,
            channelAccountId: stored.channel_account_id,
            automationId: stored.id,
            keywords: stored.keywords,
          })),
          ...(account.is_private &&
          AUTOMATION_COMMENT_TRIGGER_TYPES.includes(stored.trigger_type as AutomationTriggerType)
            ? [
                {
                  reason: 'account_private' as const,
                  field: 'channel_account_id',
                  messageKey: 'errors:automationWarnings.accountPrivate',
                  messageParams: { username: account.username ?? '' },
                },
              ]
            : []),
        ];
        const automation = await this.serialize({
          scope,
          organizationId: organization.id,
          row: { ...row, channel_account_public_id: stored.channel_account_public_id },
          account,
        });
        return { automation, warnings, isChanged: true };
      },
    });
  }

  /**
   * Pauses a live automation (route 33, AU14) — `keep` its waiting messages, or `cancel` them
   * (`cancelled_before_at` = now; sub-domain 6's helper marks them, WC-19). A paused one with the
   * same mode again is a no-op; `keep` then `cancel` sets the cut-off; a draft → `409
   * transition_not_allowed`.
   *
   * @remarks
   * Algorithm: one unit — the team check, the row locked, the guarded write; a starter-question one
   * enqueues the sync after commit. Failure modes: `404`, `409`. Side effects: the row; the sync.
   */
  async pauseAutomation({
    scope,
    automationPublicId,
    mode,
    actingUserPublicId,
  }: AutomationPauseInput): Promise<AutomationWithWarningsOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const stored = await this.automationRepository.lockLiveByPublicId({
          organizationId: organization.id,
          automationPublicId,
        });
        if (stored === null) throw automationNotFoundError();
        if (stored.status === 'draft') {
          throw new ConflictError('errors:automationTransitionNotAllowed').withReason(
            'transition_not_allowed',
          );
        }
        const isCancelledAlready =
          stored.cancelled_before_at !== null &&
          stored.cancelled_before_at.getTime() >= stored.updated_at.getTime();
        const isNoOp = stored.status === 'paused' && (mode === 'keep' || isCancelledAlready);
        if (isNoOp) {
          const automation = await this.serialize({
            scope,
            organizationId: organization.id,
            row: stored,
          });
          return { automation, warnings: [], isChanged: false };
        }
        const updatedByUserId =
          await this.organizationService.resolveUserInternalIdByPublicId(actingUserPublicId);
        const row = await this.automationRepository.changeState({
          organizationId: organization.id,
          automationId: stored.id,
          change: { status: 'paused', isCancelledBeforeNow: mode === 'cancel' },
          updatedByUserId,
        });
        if (row === null) throw automationNotFoundError();
        if (stored.trigger_type === 'starter_question' && stored.status === 'live') {
          await this.enqueueStarterQuestionSync({
            scope,
            channelAccountPublicId: stored.channel_account_public_id,
          });
        }
        const automation = await this.serialize({
          scope,
          organizationId: organization.id,
          row: { ...row, channel_account_public_id: stored.channel_account_public_id },
        });
        return { automation, warnings: [], isChanged: true };
      },
    });
  }

  /**
   * The automation's live row and its channel's sending port (routes 36–37): the team check (a read's
   * `404 team_organization_required`, a write's `422`), the automation (`404 automation_not_found`).
   */
  private async resolveAutomationMessages({
    scope,
    automationPublicId,
    isWrite,
  }: {
    scope: AutomationActionInput['scope'];
    automationPublicId: string;
    isWrite: boolean;
  }): Promise<{
    organizationId: number;
    automationId: number;
    port: ChannelSendingPort | undefined;
  }> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        if (isWrite) assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        else assertTeamOrganizationForRead({ organization });
        const row = await this.automationRepository.findLiveByPublicId({
          organizationId: organization.id,
          automationPublicId,
        });
        if (row === null) throw automationNotFoundError();
        return {
          organizationId: organization.id,
          automationId: row.id,
          port: this.ports.sendingPorts?.[row.channel as keyof ChannelSendingPorts],
        };
      },
    });
  }

  /**
   * Its failed messages of about the last 30 days, counted (route 36, AU18, D72) — never `unknown`,
   * `skipped`, `expired` or `cancelled`; changes nothing.
   *
   * @remarks
   * Algorithm: the automation read, then its channel's summary. Failure modes: `404
   * automation_not_found`. Side effects: none.
   */
  async summarizeAutomationFailedMessages({
    scope,
    automationPublicId,
  }: Pick<
    AutomationActionInput,
    'scope' | 'automationPublicId'
  >): Promise<FailedMessagesSummaryOutput> {
    const { organizationId, automationId, port } = await this.resolveAutomationMessages({
      scope,
      automationPublicId,
      isWrite: false,
    });
    const summary = await port?.summarizeFailedMessages({
      scope,
      organizationId,
      by: 'automation',
      id: automationId,
      ownerPublicId: automationPublicId,
    });
    return serializeFailedMessagesSummary(summary ?? emptyFailedMessagesSummary());
  }

  /**
   * Retries its failed messages (route 37, AU18, D72): the allowed ones go back to `waiting`, each at
   * most once — none while its text is still refused (`text_refused`). Answers the object and the
   * press (the controller's audit counts).
   *
   * @remarks
   * Algorithm: the automation read (a write's team check), then its channel's retry. Failure modes:
   * `404 automation_not_found`, `422` for a personal organization. Side effects: the channel's.
   */
  async retryAutomationFailedMessages({
    scope,
    automationPublicId,
  }: Pick<AutomationActionInput, 'scope' | 'automationPublicId'>): Promise<{
    data: FailedMessagesRetryOutput;
    retry: ChannelFailedMessagesRetry;
  }> {
    const { organizationId, automationId, port } = await this.resolveAutomationMessages({
      scope,
      automationPublicId,
      isWrite: true,
    });
    const retry = (await port?.retryFailedMessages({
      scope,
      organizationId,
      by: 'automation',
      id: automationId,
      ownerPublicId: automationPublicId,
    })) ?? { summary: emptyFailedMessagesSummary(), expectedRetryCount: 0, isQueued: false };
    return { data: serializeFailedMessagesRetry(retry), retry };
  }

  /**
   * Duplicates an automation as a draft (route 34, AU15): "<name> (copy)" (cut to 255) on the same
   * account, `steps` and settings copied (files by the same upload ids); counters, reply state,
   * backfills, the stop, the next-post state and the cancel cut-off not copied; a `ref_link` one gets
   * a new free `ref_code`. From any status.
   *
   * @remarks
   * Algorithm: one unit — the team check, the source read, the insert. Failure modes: `404`. Side
   * effects: one row.
   */
  async duplicateAutomation({
    scope,
    automationPublicId,
    actingUserPublicId,
  }: AutomationActionInput): Promise<AutomationOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const source = await this.automationRepository.findLiveByPublicId({
          organizationId: organization.id,
          automationPublicId,
        });
        if (source === null) throw automationNotFoundError();
        const fields = toWritableFields(source);
        const suffixRoom = AUTOMATION_NAME_MAX_LENGTH - AUTOMATION_DUPLICATE_NAME_SUFFIX.length;
        fields.name = `${source.name.slice(0, suffixRoom)}${AUTOMATION_DUPLICATE_NAME_SUFFIX}`;
        if (fields.target_scope === 'next') {
          fields.target_starts_at = null;
          fields.target_ends_at = null;
          fields.target_instagram_media_id = null;
        }
        fields.ref_code =
          source.ref_code === null
            ? null
            : await this.freeRefCode({
                organizationId: organization.id,
                channelAccountId: source.channel_account_id,
                base: source.ref_code,
              });
        const createdByUserId =
          await this.organizationService.resolveUserInternalIdByPublicId(actingUserPublicId);
        const row = await this.automationRepository.insert({
          organizationId: organization.id,
          channelAccountId: source.channel_account_id,
          channel: source.channel,
          fields,
          createdByUserId,
        });
        return this.serialize({
          scope,
          organizationId: organization.id,
          row: { ...row, channel_account_public_id: source.channel_account_public_id },
        });
      },
    });
  }

  /**
   * Deletes an automation (route 31, AU16, P11): soft delete with the optional reason, every
   * registered open-run cancel step, and the channel's waiting-message cancel (when wired) — one
   * transaction. Returns its public id and the cancelled run count for the audit entry.
   *
   * @remarks
   * Algorithm: one unit — the team check, the row locked `FOR UPDATE`, the soft delete, the steps in
   * order; a starter-question one enqueues the sync after commit. Contacts it collected stay.
   * Failure modes: `404 automation_not_found`; a step that throws rolls back. Side effects: the row
   * and the steps' writes.
   */
  async deleteAutomation({
    scope,
    automationPublicId,
    removal,
    deletedByUserPublicId,
  }: AutomationDeleteInput): Promise<AutomationDeleteResult> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const stored = await this.automationRepository.lockLiveByPublicId({
          organizationId: organization.id,
          automationPublicId,
        });
        if (stored === null) throw automationNotFoundError();
        const updatedByUserId =
          await this.organizationService.resolveUserInternalIdByPublicId(deletedByUserPublicId);
        const deleted = await this.automationRepository.softDelete({
          organizationId: organization.id,
          automationId: stored.id,
          reason: removal.reason,
          note: removal.note,
          updatedByUserId,
        });
        if (deleted === null) throw automationNotFoundError();
        let cancelledRunCount = 0;
        for (const cancelOpenRuns of this.openRunCancelSteps) {
          cancelledRunCount += await cancelOpenRuns({
            organizationId: organization.id,
            automationId: stored.id,
          });
        }
        const sendingPort = this.ports.sendingPorts?.[stored.channel as keyof ChannelSendingPorts];
        if (sendingPort !== undefined) {
          await sendingPort.cancelWaitingMessages({
            organizationId: organization.id,
            by: 'automation',
            id: stored.id,
            reason: 'automation_deleted',
          });
        }
        if (stored.trigger_type === 'starter_question' && stored.status === 'live') {
          await this.enqueueStarterQuestionSync({
            scope,
            channelAccountPublicId: stored.channel_account_public_id,
          });
        }
        return { automationPublicId: stored.public_id, cancelledRunCount };
      },
    });
  }

  /**
   * Tries a text against an automation (route 35, AU17, D39): through the same matching function
   * intake uses, over this automation and the account's live ones — whether it matches, the word and
   * `exact` / `close`, and which automation would answer first (oldest first). Saves and sends nothing.
   *
   * @remarks
   * Algorithm: one read-only unit. A source applies to an automation that starts from it (`comment`:
   * the comment kinds; `story_reply`: a story reply or "also start from" story replies; `dm`: a DM
   * keyword or "also start from" DMs); no keywords matches every comment and story reply but never a
   * DM. Failure modes: `404`, `404 team_organization_required`. Side effects: none.
   */
  async testAutomationKeyword({
    scope,
    automationPublicId,
    text,
    source,
  }: AutomationKeywordTestInput): Promise<AutomationKeywordTestOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        const automation = await this.automationRepository.findLiveByPublicId({
          organizationId: organization.id,
          automationPublicId,
        });
        if (automation === null) throw automationNotFoundError();
        const effectiveSource = source ?? defaultKeywordTestSource(automation);
        const ownMatch = keywordTestMatch({ automation, text, source: effectiveSource });
        const liveOnes = await this.automationRepository.listLiveOfAccount({
          organizationId: organization.id,
          channelAccountId: automation.channel_account_id,
        });
        const first =
          liveOnes.find(
            (candidate) =>
              keywordTestMatch({ automation: candidate, text, source: effectiveSource }) !== null,
          ) ?? null;
        const isThisFirst = first?.id === automation.id;
        return {
          is_match: ownMatch !== null && automation.status === 'live' && isThisFirst,
          matched_keyword: ownMatch?.keyword ?? null,
          match_kind: ownMatch?.kind ?? null,
          first_answering_automation:
            first === null ? null : { id: first.public_id, name: first.name },
          reason: keywordTestReason({
            hasOwnMatch: ownMatch !== null,
            isLive: automation.status === 'live',
            isThisFirst,
          }),
        };
      },
    });
  }

  /**
   * The account's live, not-stopped comment and ad-comment automations — what the missed-comment
   * look (WC-26, sub-domain 5) asks whether a watched post is still watched.
   *
   * @remarks
   * Algorithm: one read of the account's run candidates in the caller's organization scope, kept to
   * `comment` and `ad_comment`. Failure modes: a database error propagates. Side effects: none.
   */
  async listLiveCommentAutomations({
    scope,
    channelAccount,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccount: { organizationId: number; channelAccountId: number };
  }): Promise<AutomationRow[]> {
    const candidates = await withAppDatabaseContext({
      scope,
      callback: () => this.automationRepository.listRunCandidates(channelAccount),
    });
    return candidates.filter(
      (candidate) =>
        candidate.trigger_type === 'comment' || candidate.trigger_type === 'ad_comment',
    );
  }

  /**
   * Links a new post to the waiting "next post" automations of its account (AU20, P12) — every live
   * one that went live at or before the post's publish time; no end date. Returns their public ids.
   *
   * @remarks
   * Algorithm: in the caller's organization scope (a caller's open unit is joined): the
   * organization's `AUTOMATION_NEXT_POST` advisory lock, then one conditional `UPDATE`. Failure
   * modes: a database error propagates. Side effects: the linked rows; safe to repeat. Notes: called
   * by intake for a commented post and by the 15-minute linking sweep's task (WC-43, R41).
   */
  async linkNextPostAutomations({
    scope,
    channelAccountPublicId,
    instagramMediaId,
    publishedAt,
  }: AutomationLinkNextPostInput): Promise<string[]> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        await acquireResourceQuotaLock({
          namespace: RESOURCE_QUOTA_LOCK_NAMESPACE.AUTOMATION_NEXT_POST,
          key: organization.id,
        });
        const linkedPublicIds = await this.automationRepository.linkNextPost({
          organizationId: organization.id,
          channelAccountPublicId,
          instagramMediaId,
          publishedAt,
        });
        if (linkedPublicIds.length > 0) {
          logger.info(
            {
              organizationPublicId: scope.organizationPublicId,
              channelAccountPublicId,
              automationPublicIds: linkedPublicIds,
            },
            'app.automation.next_post_linked',
          );
        }
        return linkedPublicIds;
      },
    });
  }

  /**
   * The internal id of the organization's automation with this public id, deleted ones included —
   * the contacts list's `automation_id` filter (CT5); `null` when there is none.
   *
   * @remarks
   * Algorithm: one read in the caller's scope (joins its unit). Failure modes: none. Side effects:
   * none.
   */
  async findAutomationIdForFilter({
    scope,
    organizationId,
    automationPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    /** `tenancy.organizations.id` of the scope's organization. */
    organizationId: number;
    /** `aut_…` from the query. */
    automationPublicId: string;
  }): Promise<number | null> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const row = await this.automationRepository.findByPublicIdIncludingDeleted({
          organizationId,
          automationPublicId,
        });
        return row?.id ?? null;
      },
    });
  }

  /**
   * The account's live starter-question automations and their questions, oldest first — what the
   * starter-question sync and the account set-up write to Instagram (WC-30, WC-31, IA6).
   *
   * @remarks
   * Algorithm: one read in the caller's scope (a job scope in the task worker). Failure modes: none.
   * Side effects: none. Notes: go-live keeps the account at four questions (AU13 check 8).
   */
  async listLiveStarterQuestions({
    scope,
    organizationId,
    channelAccountId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    /** `app.channel_accounts.id`. */
    channelAccountId: number;
  }): Promise<Array<{ automationPublicId: string; questions: string[] }>> {
    const rows = await withAppDatabaseContext({
      scope,
      callback: () =>
        this.automationRepository.listLiveStarterQuestionAutomations({
          organizationId,
          channelAccountId,
        }),
    });
    return rows.map((row) => ({ automationPublicId: row.publicId, questions: row.questions }));
  }

  /** Go-live's every check (AU13), answered as a list. */
  private async listGoLiveProblems({
    scope,
    organizationId,
    stored,
    fields,
    account,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    stored: AutomationWithAccountRow;
    fields: AutomationWritableFields;
    account: AutomationChannelAccount;
  }): Promise<AutomationProblem[]> {
    const problems: AutomationProblem[] = [];
    const isAccountUsable =
      account.connection_status === 'connected' &&
      account.channel_connection_status !== 'error' &&
      account.channel_connection_status !== 'revoked';
    if (!isAccountUsable) {
      problems.push({
        field: 'channel_account_id',
        reason: 'account_not_connected',
        messageKey: 'errors:automationProblems.account_not_connected',
      });
    }
    if (this.ports.monthLimit !== undefined) {
      const stop = await this.ports.monthLimit.readOrganizationPlanStop({ scope, organizationId });
      if (stop === 'plan_limit') {
        problems.push({
          field: 'channel_account_id',
          reason: 'month_limit_reached',
          messageKey: 'errors:automationProblems.month_limit_reached',
        });
      }
    }
    problems.push(...listAutomationContentProblems(fields));
    const featureProblems = await this.channelAccountPort.listChannelAccountAutomationProblems({
      scope,
      organizationId,
      channelAccountId: account.id,
      channel: account.channel,
      parts: listAutomationFeatureParts(fields),
    });
    problems.push(...featureProblems.map((item) => featureProblem(item)));
    const key = {
      organizationId,
      channelAccountId: stored.channel_account_id,
      excludedAutomationId: stored.id,
    };
    if (fields.trigger_type === 'starter_question') {
      problems.push(...(await this.listStarterQuestionProblems({ key, fields })));
    }
    if (fields.ref_code !== null) {
      const holder = await this.automationRepository.findOtherWithRefCode({
        ...key,
        refCode: fields.ref_code,
      });
      if (holder !== null) {
        problems.push({
          field: 'ref_code',
          reason: 'ref_code_taken',
          messageKey: 'errors:automationProblems.ref_code_taken',
          messageParams: { name: holder.name },
        });
      }
    }
    if (AUTOMATION_CATCH_ALL_TRIGGER_TYPES.includes(fields.trigger_type)) {
      const other = await this.automationRepository.findOtherLiveOfTriggerType({
        ...key,
        triggerType: fields.trigger_type,
      });
      if (other !== null) {
        problems.push({
          field: 'trigger_type',
          reason: 'catch_all_taken',
          messageKey: 'errors:automationProblems.catch_all_taken',
          messageParams: { name: other.name },
        });
      }
    }
    problems.push(...(await this.listMessageFileProblems({ scope, fields })));
    return problems;
  }

  /**
   * Go-live's starter-question checks (AU13): at most
   * {@link AUTOMATION_STARTER_QUESTIONS_MAX_COUNT} across the account's live automations, and no
   * question repeated (case- and space-insensitive) there or within this automation.
   */
  private async listStarterQuestionProblems({
    key,
    fields,
  }: {
    key: AutomationAccountKey;
    fields: AutomationWritableFields;
  }): Promise<AutomationProblem[]> {
    const problems: AutomationProblem[] = [];
    const others = await this.automationRepository.listOtherLiveStarterQuestions(key);
    const total = others.length + fields.starter_questions.length;
    if (total > AUTOMATION_STARTER_QUESTIONS_MAX_COUNT) {
      problems.push({
        field: 'starter_questions',
        reason: 'starter_questions_over_limit',
        messageKey: 'errors:automationProblems.starter_questions_over_limit',
        messageParams: { max: AUTOMATION_STARTER_QUESTIONS_MAX_COUNT },
      });
    }
    const othersLowered = new Set(others.map((question) => question.trim().toLowerCase()));
    const ownLowered = fields.starter_questions.map((question) => question.trim().toLowerCase());
    if (
      ownLowered.some((question) => othersLowered.has(question)) ||
      new Set(ownLowered).size !== ownLowered.length
    ) {
      problems.push({
        field: 'starter_questions',
        reason: 'starter_question_repeated',
        messageKey: 'errors:automationProblems.starter_question_repeated',
      });
    }
    return problems;
  }

  /** Go-live's message-file check (AU13): every upload the steps use is still usable (none without the port). */
  private async listMessageFileProblems({
    scope,
    fields,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    fields: AutomationWritableFields;
  }): Promise<AutomationProblem[]> {
    const problems: AutomationProblem[] = [];
    if (this.ports.messageFiles === undefined) return problems;
    for (const upload of listAutomationUploads(fields.steps)) {
      const file = await this.ports.messageFiles.findUsableMessageFile({
        scope,
        uploadPublicId: upload.uploadPublicId,
      });
      if (file === null) {
        problems.push({
          field: upload.field,
          reason: 'file_not_usable',
          messageKey: 'errors:automationProblems.file_not_usable',
        });
      }
    }
    return problems;
  }

  /** The plan's feature switches (P83), or `null` when the organization has no readable plan. */
  private async readPlanSwitches(
    scope: OrganizationPrincipalDatabaseScope,
  ): Promise<Readonly<Record<string, boolean>> | null> {
    const planAccess = await this.planAccessService.getPlanAccess({
      organizationPublicId: scope.organizationPublicId,
    });
    return planAccess.features?.feature_switches ?? null;
  }

  /** `403 plan_lacks_feature` when a save turns on a PRO part the plan lacks (AU4 (2)). */
  private async assertNoProFeatureTurnedOn({
    scope,
    stored,
    merged,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    stored: AutomationWritableFields;
    merged: AutomationWritableFields;
  }): Promise<void> {
    const before = new Set(listAutomationProFeatures(stored));
    const turnedOn = listAutomationProFeatures(merged).filter((feature) => !before.has(feature));
    if (turnedOn.length === 0) return;
    const switches = await this.readPlanSwitches(scope);
    const isLacking = turnedOn.some(
      (feature) => switches?.[CHANNEL_FEATURES[feature].planSwitch] !== true,
    );
    if (isLacking) throw planLacksFeatureError();
  }

  /** A save's `ref_code`: a `ref_link` without one gets a free one; a given one must be free (D43). */
  private async resolveRefCode({
    organizationId,
    channelAccountId,
    excludedAutomationId,
    fields,
  }: {
    organizationId: number;
    channelAccountId: number;
    excludedAutomationId: number | null;
    fields: AutomationWritableFields;
  }): Promise<string | null> {
    if (fields.ref_code === null) {
      return fields.trigger_type === 'ref_link'
        ? this.freeRefCode({ organizationId, channelAccountId, base: null })
        : null;
    }
    const holder = await this.automationRepository.findOtherWithRefCode({
      organizationId,
      channelAccountId,
      excludedAutomationId,
      refCode: fields.ref_code,
    });
    if (holder !== null) throw refCodeExistsError(holder.name);
    return fields.ref_code;
  }

  /** A `ref_code` no automation of the account holds: `base` plus a random tail, tried a few times. */
  private async freeRefCode({
    organizationId,
    channelAccountId,
    base,
  }: {
    organizationId: number;
    channelAccountId: number;
    base: string | null;
  }): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateAutomationRefCode(base);
      const holder = await this.automationRepository.findOtherWithRefCode({
        organizationId,
        channelAccountId,
        excludedAutomationId: null,
        refCode: candidate,
      });
      if (holder === null) return candidate;
    }
    throw refCodeExistsError(base ?? '');
  }

  /** `409 next_post_already_linked` — a save changes a linked "next post"'s target (AU20). */
  private assertNextPostLinkUnchanged({
    stored,
    changes,
  }: {
    stored: AutomationRow;
    changes: AutomationUpdateInput['changes'];
  }): void {
    if (stored.next_post_status !== 'linked') return;
    const isScopeChanged =
      changes.target_scope !== undefined && changes.target_scope !== stored.target_scope;
    const isMediaChanged =
      changes.target_instagram_media_id !== undefined &&
      changes.target_instagram_media_id !== stored.target_instagram_media_id;
    if (isScopeChanged || isMediaChanged) {
      throw new ConflictError('errors:nextPostAlreadyLinked').withReason(
        'next_post_already_linked',
      );
    }
  }

  /**
   * The `next` target as the server keeps it (AU20): the go-live time and, once linked, the post; a
   * scope that leaves `next` keeps the client's target.
   */
  private withNextPostTarget({
    stored,
    merged,
  }: {
    stored: AutomationRow;
    merged: AutomationWritableFields;
  }): AutomationWritableFields {
    if (merged.target_scope !== 'next') return merged;
    const isStillNext = stored.target_scope === 'next';
    return {
      ...merged,
      target_starts_at: nextTargetStartsAt({ stored, isStillNext }),
      target_ends_at: null,
      target_instagram_story_id: null,
      target_instagram_media_id:
        isStillNext && stored.next_post_status === 'linked'
          ? stored.target_instagram_media_id
          : null,
    };
  }

  /** Whether a save changed a live starter-question automation's questions. */
  private isStarterQuestionChange({
    stored,
    merged,
  }: {
    stored: AutomationWritableFields;
    merged: AutomationWritableFields;
  }): boolean {
    return (
      merged.trigger_type === 'starter_question' &&
      stored.starter_questions.join('\u0000') !== merged.starter_questions.join('\u0000')
    );
  }

  /**
   * A live edit's removed steps and messages (plan §5.1 — `cancelled_by_owner`, sub-domain 6): their
   * waiting messages end through the channel's sending port when it is wired (R19).
   */
  private async skipRemovedWaitingMessages({
    stored,
    merged,
    organizationId,
  }: {
    stored: AutomationRow;
    merged: AutomationWritableFields;
    organizationId: number;
  }): Promise<void> {
    const sendingPort = this.ports.sendingPorts?.[stored.channel as keyof ChannelSendingPorts];
    if (sendingPort === undefined || stored.status === 'draft') return;
    const storedCount = stored.steps.messages?.length ?? 0;
    const mergedCount = merged.steps.messages?.length ?? 0;
    const isStepRemoved = (['hello', 'follow', 'email', 'phone'] as const).some(
      (part) => stored.steps[part]?.on === true && merged.steps[part]?.on !== true,
    );
    if (mergedCount < storedCount || isStepRemoved) {
      await sendingPort.cancelWaitingMessages({
        organizationId,
        by: 'automation',
        id: stored.id,
        reason: 'cancelled_by_owner',
      });
    }
  }

  /** The shared-keyword warnings of a live save or go-live (D39) — never a refusal. */
  private async listKeywordWarnings({
    organizationId,
    channelAccountId,
    automationId,
    keywords,
  }: {
    organizationId: number;
    channelAccountId: number;
    automationId: number;
    keywords: readonly string[];
  }): Promise<AutomationWarning[]> {
    const others = await this.automationRepository.listOtherLiveSharingKeywords({
      organizationId,
      channelAccountId,
      excludedAutomationId: automationId,
      keywords,
    });
    const own = new Set(keywords);
    return others.map((other) => ({
      reason: 'keyword_shared',
      field: 'keywords',
      messageKey: 'errors:automationWarnings.keywordShared',
      messageParams: {
        keyword: other.keywords.find((keyword) => own.has(keyword)) ?? '',
        name: other.name,
      },
    }));
  }

  /**
   * Asks the channel to upload the automation's message files after commit (WC-32, R46) — none, or
   * no port, does nothing; a failed add is logged (the send uploads the file before its first send).
   */
  private async requestAttachmentUploads({
    scope,
    channelAccountPublicId,
    uploadPublicIds,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
    uploadPublicIds: readonly string[];
  }): Promise<void> {
    const port = this.ports.attachmentUploads;
    if (port === undefined || uploadPublicIds.length === 0) return;
    await runEnqueueAfterCommit(async () => {
      try {
        await port.requestAttachmentUploads({
          organizationPublicId: scope.organizationPublicId,
          channelAccountPublicId,
          uploadPublicIds,
        });
      } catch (error) {
        logger.warn(
          { error_name: (error as Error | null)?.name, channelAccountPublicId },
          'app.automation.attachment_upload_enqueue_failed',
        );
      }
    });
  }

  /** Enqueues the starter-question sync after commit when wired (IA6, R40). */
  private async enqueueStarterQuestionSync({
    scope,
    channelAccountPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
  }): Promise<void> {
    const queue = this.ports.starterQuestionSync;
    if (queue === undefined) return;
    await runEnqueueAfterCommit(() =>
      queue.enqueueStarterQuestionSync({
        organizationPublicId: scope.organizationPublicId,
        channelAccountPublicId,
      }),
    );
  }

  /** Serializes one row: its users' public ids, counts, PRO parts off and the account's username. */
  private async serialize({
    scope,
    organizationId,
    row,
    account,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    row: AutomationWithAccountRow;
    account?: AutomationChannelAccount | null | undefined;
  }): Promise<AutomationOutput> {
    const userIds = [row.created_by_user_id, row.updated_by_user_id].filter(
      (userId): userId is number => userId !== null,
    );
    const userPublicIds =
      userIds.length === 0
        ? new Map<number, string>()
        : await this.organizationService.resolveUserPublicIdsByInternalIds([...new Set(userIds)]);
    const userPublicIdOf = (userId: number | null) =>
      userId === null ? null : (userPublicIds.get(userId) ?? null);
    const counts = await this.countService.readCounts({
      scope,
      organizationId,
      automationIds: [row.id],
    });
    const switches = await this.readPlanSwitches(scope);
    const proPartsOff: ChannelFeature[] = listAutomationProFeatures(toWritableFields(row)).filter(
      (feature) => switches?.[CHANNEL_FEATURES[feature].planSwitch] !== true,
    );
    const resolvedAccount =
      account === undefined && row.trigger_type === 'ref_link'
        ? await this.channelAccountPort.readAutomationAccount({
            scope,
            organizationId,
            account: { channelAccountId: row.channel_account_id },
          })
        : account;
    const openBackfill =
      (await this.ports.openBackfills?.findOpenAutomationBackfill({
        scope,
        organizationId,
        automationId: row.id,
        automationPublicId: row.public_id,
      })) ?? null;
    return serializeAutomation({
      automation: row,
      channel_account_public_id: row.channel_account_public_id,
      created_by_user_public_id: userPublicIdOf(row.created_by_user_id),
      updated_by_user_public_id: userPublicIdOf(row.updated_by_user_id),
      counts: counts.get(row.id),
      pro_parts_off: proPartsOff,
      username: resolvedAccount?.username ?? null,
      open_backfill: openBackfill,
    });
  }
}

/** Whether the automation starts from the keyword test's source — its own way or "also start from". */
function startsFromKeywordTestSource({
  automation,
  source,
}: {
  automation: AutomationRow;
  source: AutomationKeywordTestSource;
}): boolean {
  const type = automation.trigger_type;
  if (source === 'comment') {
    return AUTOMATION_COMMENT_TRIGGER_TYPES.includes(type as AutomationTriggerType);
  }
  if (source === 'story_reply') {
    return type === 'story_reply' || automation.also_start_from.includes('story_reply');
  }
  return type === 'dm_keyword' || automation.also_start_from.includes('dm');
}

/** Why a keyword test does not answer with this automation, or `null` when it does (route 35). */
function keywordTestReason({
  hasOwnMatch,
  isLive,
  isThisFirst,
}: {
  hasOwnMatch: boolean;
  isLive: boolean;
  isThisFirst: boolean;
}): 'no_keyword' | 'not_live' | 'other_answers_first' | null {
  if (!hasOwnMatch) return 'no_keyword';
  if (!isLive) return 'not_live';
  return isThisFirst ? null : 'other_answers_first';
}

/**
 * The go-live time of a `next` target (AU20): kept while the stored scope is already `next`, else
 * none for a draft and now for a saved automation.
 */
function nextTargetStartsAt({
  stored,
  isStillNext,
}: {
  stored: AutomationRow;
  isStillNext: boolean;
}): Date | null {
  if (isStillNext) return stored.target_starts_at;
  return stored.status === 'draft' ? null : new Date();
}

/** The source a keyword test reads by default: the automation's way to start (AU17). */
function defaultKeywordTestSource(automation: AutomationRow): AutomationKeywordTestSource {
  if (AUTOMATION_COMMENT_TRIGGER_TYPES.includes(automation.trigger_type as AutomationTriggerType)) {
    return 'comment';
  }
  return automation.trigger_type === 'story_reply' ? 'story_reply' : 'dm';
}

/** Whether an automation starts from a source and its keywords match the text (route 35). */
function keywordTestMatch({
  automation,
  text,
  source,
}: {
  automation: AutomationRow;
  text: string;
  source: AutomationKeywordTestSource;
}): { keyword: string | null; kind: 'exact' | 'close' | null } | null {
  if (!startsFromKeywordTestSource({ automation, source })) return null;
  if (automation.keywords.length === 0) {
    return source === 'dm' ? null : { keyword: null, kind: null };
  }
  const match = matchAutomationKeyword({ keywords: automation.keywords, text });
  return match === null ? null : { keyword: match.keyword, kind: match.kind };
}
