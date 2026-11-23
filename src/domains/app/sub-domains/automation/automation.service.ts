import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  acquireResourceQuotaLock,
  RESOURCE_QUOTA_LOCK_NAMESPACE,
} from '@/infrastructure/database/resource-quota-lock.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  assertTeamOrganization,
  assertTeamOrganizationForRead,
} from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import { ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { assertRecordNotChangedSince } from '@/shared/utils/validation/record-fields.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import { instagramNotConnectedConflictError } from '@/domains/app/sub-domains/instagram-account/instagram-account-error.util.js';
import { AUTOMATION_DEFAULT_SORT, type AutomationSortField } from './automation.constants.js';
import type {
  AutomationRepository,
  AutomationRow,
  AutomationWithAccountRow,
} from './automation.repository.js';
import { serializeAutomation } from './automation.serializer.js';
import type {
  AutomationCreateInput,
  AutomationDeleteInput,
  AutomationDeleteResult,
  AutomationGetInput,
  AutomationLinkNextPostInput,
  AutomationListInput,
  AutomationMergedFields,
  AutomationOpenRunCancelStep,
  AutomationOutput,
  AutomationPageOutput,
  AutomationUpdateInput,
  AutomationWritableFields,
} from './automation.types.js';
import {
  assertNextPostLinkUnchanged,
  mergeAutomationForCreate,
  mergeAutomationForUpdate,
  resolveNextPostState,
  validateAutomationFlow,
} from './automation.validator.js';

/** `404 automation_not_found` — absent, deleted or another organization's (AU3, AU12, K1). */
function automationNotFoundError(): NotFoundError {
  return new NotFoundError('Automation').withReason('automation_not_found');
}

/** The order a list without `order` uses: newest / most first, `name` A→Z (AU13). */
function defaultAutomationOrder(sort: AutomationSortField): 'asc' | 'desc' {
  return sort === 'name' ? 'asc' : 'desc';
}

/** The fields of a stored row a person writes — what an edit merges its body over (AU8). */
function toWritableFields(row: AutomationRow): AutomationWritableFields {
  return {
    name: row.name,
    status: row.status as AutomationWritableFields['status'],
    trigger_type: row.trigger_type as AutomationWritableFields['trigger_type'],
    target_scope: row.target_scope as AutomationWritableFields['target_scope'],
    target_instagram_media_id: row.target_instagram_media_id,
    target_instagram_story_id: row.target_instagram_story_id,
    next_post_starts_at: row.next_post_starts_at,
    next_post_ends_at: row.next_post_ends_at,
    is_dm_keyword_trigger_enabled: row.is_dm_keyword_trigger_enabled,
    keywords: [...row.keywords],
    tags: [...row.tags],
    is_public_reply_enabled: row.is_public_reply_enabled,
    public_reply_texts: [...row.public_reply_texts],
    is_opening_message_enabled: row.is_opening_message_enabled,
    opening_message: row.opening_message,
    is_follow_required: row.is_follow_required,
    follow_request_message: row.follow_request_message,
    is_email_collection_enabled: row.is_email_collection_enabled,
    email_request_message: row.email_request_message,
    is_phone_collection_enabled: row.is_phone_collection_enabled,
    phone_request_message: row.phone_request_message,
    final_message: row.final_message,
  };
}

/** The "next post" state an edit starts from (AU9). */
function toStoredNextPost(row: AutomationRow) {
  return {
    target_scope: row.target_scope as AutomationWritableFields['target_scope'],
    next_post_starts_at: row.next_post_starts_at,
    next_post_ends_at: row.next_post_ends_at,
    next_post_status: row.next_post_status as AutomationMergedFields['next_post_status'],
    next_post_linked_at: row.next_post_linked_at,
    target_instagram_media_id: row.target_instagram_media_id,
  };
}

/** Whether a save leaves the automation live and waiting — the only state the overlap check reads (AU9). */
function needsNextPostOverlapCheck(fields: AutomationMergedFields): boolean {
  return fields.status === 'live' && fields.next_post_status === 'waiting';
}

/** The first keyword two keyword sets share, A→Z; `null` when they share none. */
function firstSharedKeyword({
  keywords,
  otherKeywords,
}: {
  keywords: readonly string[];
  otherKeywords: readonly string[];
}): string | null {
  const other = new Set(otherKeywords);
  const shared = keywords
    .filter((keyword) => other.has(keyword))
    .sort((left, right) => left.localeCompare(right));
  return shared[0] ?? null;
}

/**
 * The automation service (routes-final § 3.A): list, create, read, edit and delete (routes 11–15)
 * for the team, "next post" linking for sub-domain 4's event processing (AU15), and the automation
 * id lookup of the contacts list's `automation_id` filter (CT5).
 *
 * @remarks
 * Algorithm:
 * - Routes run in the caller's organization scope (`withAppDatabaseContext`, one transaction),
 *   team-only (AU3): the reads answer `404 team_organization_required` on a personal organization
 *   (`assertTeamOrganizationForRead`), the writes `422` (`assertTeamOrganization`, capability
 *   `INSTAGRAM`) — the second line behind the permission gate. A deleted or another organization's
 *   automation is `404 automation_not_found`.
 * - Every save is complete (AU8): the body is merged over the create's defaults or the stored row
 *   and the one flow rule set runs on the result ({@link validateAutomationFlow}).
 * - Each automation belongs to the account connected when it was created (AU27): the create reads
 *   it through {@link InstagramAccountService.findLiveAccount}; no edit changes it.
 * - The "next post" overlap (AU9): when the save leaves the automation live and waiting, the check
 *   and the write run under the organization's `AUTOMATION_NEXT_POST` advisory lock, which linking
 *   takes too. An edit takes the lock before it locks the row, the same order linking takes them in,
 *   so the two never deadlock.
 * - The delete (AU12) locks the automation, soft-deletes it and runs every registered
 *   {@link AutomationOpenRunCancelStep} in the same transaction — sub-domain 3.B's
 *   `cancelAutomationOpenRuns`, wired by the app container. The automation's lock comes before its
 *   runs' — the order of the run engine and the contact erase (D47), so none of them blocks another.
 *
 * Failure modes:
 * - The `400`s of 3.A.9 (the merged flow), `404 automation_not_found`,
 *   `404 team_organization_required` / `422` (personal organization), `409 instagram_not_connected`
 *   (create without an account), `409 next_post_window_overlap`, `409 next_post_already_linked`,
 *   `409 record_changed` (AU11). A cancel step that throws rolls the delete back.
 *
 * Side effects:
 * - Writes `app.automations`; the delete also runs the registered steps' writes. The audit entries
 *   are the controller's, after commit (AU4, D36). Never calls Instagram.
 *
 * Notes:
 * - The counters (`completed_run_count`, `last_triggered_at`) are the run engine's (AU10); no route
 *   writes them. There is no plan limit on the number of automations (D12).
 */
export class AutomationService {
  constructor(
    private readonly automationRepository: AutomationRepository,
    private readonly instagramAccountService: InstagramAccountService,
    private readonly organizationService: OrganizationService,
    private readonly openRunCancelSteps: readonly AutomationOpenRunCancelStep[],
  ) {}

  /**
   * One page of the organization's live automations (route 11, AU13), with the capped total on the
   * first page.
   *
   * @remarks
   * Algorithm: one unit of work — the team check, the repository list with the sort and order
   * resolved (default `created_at`, newest first; `name` A→Z; the counters most first), then the
   * page's users' public ids in one batch. Failure modes: `404 team_organization_required` on a
   * personal organization. Side effects: none.
   */
  async listAutomations({ scope, query }: AutomationListInput): Promise<AutomationPageOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        const sort = query.sort ?? AUTOMATION_DEFAULT_SORT;
        const page = await this.automationRepository.list({
          organizationId: organization.id,
          query: { ...query, sort, order: query.order ?? defaultAutomationOrder(sort) },
        });
        return { ...page, items: await this.serializeRows(page.items) };
      },
    });
  }

  /**
   * One live automation of the organization (route 13).
   *
   * @remarks
   * Algorithm: one unit of work — the team check, the read, its users' public ids. Failure modes:
   * `404 automation_not_found`; `404 team_organization_required` on a personal organization. Side
   * effects: none.
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
        const [automation] = await this.serializeRows([row]);
        return automation as AutomationOutput;
      },
    });
  }

  /**
   * Creates an automation (route 12, AU7–AU9, AU27) on the organization's connected account and
   * returns it.
   *
   * @remarks
   * Algorithm:
   * 1. The body over the defaults (`inactive`, `any`, …), the flow rules on the result (`400`s),
   *    the "next post" state (`waiting` on `next`).
   * 2. One unit of work: the team check (`422`); the organization's not-revoked account (an
   *    `expired` or `error` one counts) — none → `409 instagram_not_connected`; the creator's id;
   *    when the new automation is live and waiting, the advisory lock and the overlap check
   *    (`409 next_post_window_overlap`); the insert.
   *
   * Failure modes: as above. Side effects: one row inserted. The copy a Duplicate makes belongs to
   * the account connected now (3.A.10).
   */
  async createAutomation({
    scope,
    changes,
    createdByUserPublicId,
  }: AutomationCreateInput): Promise<AutomationOutput> {
    const now = new Date();
    const writable = mergeAutomationForCreate(changes);
    validateAutomationFlow({
      automation: writable,
      stored: null,
      isMediaIdSent:
        changes.target_instagram_media_id !== undefined &&
        changes.target_instagram_media_id !== null,
      now,
    });
    const fields = resolveNextPostState({ automation: writable, stored: null });
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const account = await this.instagramAccountService.findLiveAccount({
          scope,
          organizationId: organization.id,
        });
        if (account === null) throw instagramNotConnectedConflictError();
        const createdByUserId =
          await this.organizationService.resolveUserInternalIdByPublicId(createdByUserPublicId);
        if (needsNextPostOverlapCheck(fields)) {
          await this.assertNoNextPostOverlap({
            organizationId: organization.id,
            instagramAccountId: account.id,
            automationId: null,
            fields,
          });
        }
        const row = await this.automationRepository.insert({
          organizationId: organization.id,
          instagramAccountId: account.id,
          fields,
          createdByUserId,
        });
        const [automation] = await this.serializeRows([
          { ...row, instagram_account_public_id: account.public_id },
        ]);
        return automation as AutomationOutput;
      },
    });
  }

  /**
   * Edits an automation (route 14, AU8, AU9, AU11) — any field of the create body, `null` clearing
   * a nullable one — and returns it as saved.
   *
   * @remarks
   * Algorithm — one unit of work:
   * 1. The team check (`422`); the advisory lock; the live row locked `FOR UPDATE`
   *    (`404 automation_not_found`).
   * 2. `expected_updated_at` older than the row → `409 record_changed` (who and when).
   * 3. A `linked` automation's window, scope or target ids changing → `409 next_post_already_linked`.
   * 4. The body over the stored row, the flow rules on the result (`400`s); the "next post" state —
   *    an `expired` one whose window changed waits again; leaving `next` clears every next-post
   *    field.
   * 5. Live and waiting → the overlap check against the account's other automations (`409`).
   * 6. The write, the caller as last editor. The account and the counters never change.
   *
   * Failure modes: as above. Side effects: one row updated. An edit reaches open runs from their
   * next step; turning it `inactive` stops new runs only (AU14).
   */
  async updateAutomation({
    scope,
    automationPublicId,
    changes,
    expectedUpdatedAt,
    updatedByUserPublicId,
  }: AutomationUpdateInput): Promise<AutomationOutput> {
    const now = new Date();
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        // Lock order — the advisory lock, then the row — is linking's, so the two never deadlock.
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
        const storedNextPost = toStoredNextPost(stored);
        assertNextPostLinkUnchanged({
          stored: {
            ...storedNextPost,
            target_instagram_story_id: stored.target_instagram_story_id,
          },
          changes,
        });
        const writable = mergeAutomationForUpdate({ stored: toWritableFields(stored), changes });
        validateAutomationFlow({
          automation: writable,
          stored: storedNextPost,
          isMediaIdSent:
            changes.target_instagram_media_id !== undefined &&
            changes.target_instagram_media_id !== null &&
            changes.target_instagram_media_id !== stored.target_instagram_media_id,
          now,
        });
        const fields = resolveNextPostState({ automation: writable, stored: storedNextPost });
        if (needsNextPostOverlapCheck(fields)) {
          await this.assertNoNextPostOverlap({
            organizationId: organization.id,
            instagramAccountId: stored.instagram_account_id,
            automationId: stored.id,
            fields,
          });
        }
        const updatedByUserId =
          await this.organizationService.resolveUserInternalIdByPublicId(updatedByUserPublicId);
        const row = await this.automationRepository.update({
          organizationId: organization.id,
          automationId: stored.id,
          fields,
          updatedByUserId,
        });
        if (row === null) throw automationNotFoundError();
        const [automation] = await this.serializeRows([
          { ...row, instagram_account_public_id: stored.instagram_account_public_id },
        ]);
        return automation as AutomationOutput;
      },
    });
  }

  /**
   * Deletes an automation (route 15, AU12, AQ6): soft delete with the reason and note, then every
   * registered open-run cancel step — one transaction. Returns its public id and the number of runs
   * cancelled for the controller's audit entry.
   *
   * @remarks
   * Algorithm: one unit of work — the team check (`422`), the live row locked `FOR UPDATE`
   * (`404 automation_not_found`), the soft delete (`deleted_at`, `delete_reason`, `delete_note`, the
   * caller as last editor), each cancel step in registration order with `{ organizationId,
   * automationId }`, their counts summed. The lock is granted once every unit that starts or moves a
   * run of this automation, and every erase of a contact with an open one, is over (they hold the
   * automation `FOR KEY SHARE` before its runs, D47): the steps, which read after it, find every open
   * run there is, and a unit that comes later finds the automation deleted and starts nothing — so no
   * open run is left and the two never block each other. Failure modes: `404 automation_not_found`
   * when absent, deleted (a repeat) or another organization's; a step that throws rolls everything
   * back. Side effects: the row and the steps' writes; runs and comment logs stay. No restore route
   * (the purge comes 180 days later, AQ7).
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
        return { automationPublicId: stored.public_id, cancelledRunCount };
      },
    });
  }

  /**
   * Links a new post to the waiting "next post" automations of its Instagram account (AU15, WC-4)
   * — sub-domain 4 calls it for every comment, before the comment is matched, so a just-linked
   * automation counts as linked to that post. Returns the linked automations' public ids.
   *
   * @remarks
   * Algorithm: in the caller's organization scope (the job's, relayed by sub-domain 4 — a caller
   * inside a unit of work for that organization joins it, so it can run the call in a savepoint):
   * the organization's `AUTOMATION_NEXT_POST` advisory lock (the overlap check's), then one
   * conditional `UPDATE` over the account's live, waiting automations whose window holds the post's
   * publish time, unless one of the account's automations targeted the post before (AQ4).
   * Failure modes: a database error propagates — the caller logs it and still matches the comment
   * (D18). Side effects: the linked rows. Safe to repeat: a linked automation never links again.
   */
  async linkNextPostAutomations({
    scope,
    instagramAccountPublicId,
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
          instagramAccountPublicId,
          instagramMediaId,
          publishedAt,
        });
        if (linkedPublicIds.length > 0) {
          logger.info(
            {
              organizationPublicId: scope.organizationPublicId,
              instagramAccountPublicId,
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
   * the contacts list's `automation_id` filter (routes-final § 3.B.8, CT5: a deleted automation's
   * runs stay); `null` when there is none, so the list answers an empty page.
   *
   * @remarks
   * Algorithm: one read in the caller's organization scope — the contact list calls it inside its
   * own unit of work, which this one joins. Failure modes: none of its own (a malformed id is the
   * list query's `400`). Side effects: none.
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
   * Refuses a save whose live, waiting "next post" window clashes with another of the same account
   * (AU9): `409 next_post_window_overlap`, the detail naming the other automation, the first shared
   * keyword (A→Z) and its window (ISO 8601, UTC) — or the "any comment" wording when a side has no
   * keywords. Takes the organization's advisory lock first (held to the end of the transaction).
   */
  private async assertNoNextPostOverlap({
    organizationId,
    instagramAccountId,
    automationId,
    fields,
  }: {
    organizationId: number;
    instagramAccountId: number;
    automationId: number | null;
    fields: AutomationMergedFields;
  }): Promise<void> {
    const startsAt = fields.next_post_starts_at;
    const endsAt = fields.next_post_ends_at;
    if (startsAt === null || endsAt === null) return;
    await acquireResourceQuotaLock({
      namespace: RESOURCE_QUOTA_LOCK_NAMESPACE.AUTOMATION_NEXT_POST,
      key: organizationId,
    });
    const overlap = await this.automationRepository.findNextPostOverlap({
      organizationId,
      instagramAccountId,
      excludedAutomationId: automationId,
      startsAt,
      endsAt,
      keywords: fields.keywords,
    });
    if (overlap === null) return;
    const window = {
      name: overlap.name,
      startsAt: overlap.next_post_starts_at.toISOString(),
      endsAt: overlap.next_post_ends_at.toISOString(),
    };
    const keyword = firstSharedKeyword({
      keywords: fields.keywords,
      otherKeywords: overlap.keywords,
    });
    const error =
      keyword === null
        ? new ConflictError('errors:nextPostWindowOverlapAnyComment', window)
        : new ConflictError('errors:nextPostWindowOverlap', { ...window, keyword });
    throw error.withReason('next_post_window_overlap');
  }

  /**
   * Serializes stored rows with their account's public id and their two users' public ids,
   * resolved in one batch (`auth.resolve_user_public_ids_by_ids` — `auth.users` is FORCE RLS).
   */
  private async serializeRows(
    rows: readonly AutomationWithAccountRow[],
  ): Promise<AutomationOutput[]> {
    const userIds = [
      ...new Set(
        rows.flatMap((row) =>
          [row.created_by_user_id, row.updated_by_user_id].filter(
            (userId): userId is number => userId !== null,
          ),
        ),
      ),
    ];
    const userPublicIds =
      userIds.length === 0
        ? new Map<number, string>()
        : await this.organizationService.resolveUserPublicIdsByInternalIds(userIds);
    const userPublicIdOf = (userId: number | null) =>
      userId === null ? null : (userPublicIds.get(userId) ?? null);
    return rows.map((row) =>
      serializeAutomation({
        automation: row,
        instagram_account_public_id: row.instagram_account_public_id,
        created_by_user_public_id: userPublicIdOf(row.created_by_user_id),
        updated_by_user_public_id: userPublicIdOf(row.updated_by_user_id),
      }),
    );
  }
}
