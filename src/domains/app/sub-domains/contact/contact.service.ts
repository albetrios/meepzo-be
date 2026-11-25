import { withAppDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';
import {
  type ChannelActivityCursor,
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
import { finishKeysetPage } from '@/shared/utils/http/list-query.util.js';
import { parseListCursor } from '@/shared/utils/http/pagination.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  assertTeamOrganization,
  assertTeamOrganizationForRead,
} from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableEntityError,
} from '@/shared/errors/index.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { assertRecordNotChangedSince } from '@/shared/utils/validation/record-fields.util.js';
import {
  CONTACT_BULK_ACTION_MATCH_MAX_COUNT,
  CONTACT_DEFAULT_SORT,
  CONTACT_FULL_NAME_MAX_LENGTH,
  CONTACT_INTERACTION_KIND,
  CONTACT_TAGS_MAX_COUNT,
  CONTACT_USERNAME_MAX_LENGTH,
  type ContactPauseReason,
  type ContactSortField,
} from './contact.constants.js';
import {
  type ContactProfileValues,
  type ContactRepository,
  type ContactRow,
  type ContactTagCountDelta,
  createWorkerContactRepository,
} from './contact.repository.js';
import {
  serializeContact,
  serializeContactDetail,
  serializeContactTagCount,
} from './contact.serializer.js';
import type {
  ContactActivityItemOutput,
  ContactActivityPageOutput,
  ContactAutomationFilterResolver,
  ContactBulkActionFilter,
  ContactBulkActionInput,
  ContactBulkActionOutput,
  ContactBulkActionQueue,
  ContactCollectedValueResult,
  ContactDeleteInput,
  ContactDetailOutput,
  ContactErasureStep,
  ContactInteractionResult,
  ContactListInput,
  ContactPageOutput,
  ContactPauseStep,
  ContactProfileInput,
  ContactRunEventReader,
  ContactSendState,
  ContactTagChangeEvent,
  ContactTagCountOutput,
  ContactTagEventRecorder,
  ContactUpdateInput,
  ContactWorkerKey,
  RecordContactInteractionInput,
} from './contact.types.js';
import {
  mergeContactTags,
  normalizeContactEmail,
  normalizeContactPhone,
} from './contact.validator.js';

/**
 * The ports later ROUTE rows fill (KICKOFF build-order rule): the pause steps (4.B now; 6 at its
 * row), the tag-event recorder (3.B, R11) and the bulk-action queue (WC-36, R46).
 *
 * @remarks
 * Notes: every port is optional — a missing pause step or recorder does nothing; a missing queue
 * makes route 21 answer `503 contact_bulk_action_unavailable`.
 */
export interface ContactServicePorts {
  /** Run in the commit that pauses her or records her opt-out (routes-final § 3.10, CTC4). */
  pauseSteps?: readonly ContactPauseStep[];
  /** Writes one tag event per tag change in its commit (3.B, R11). */
  tagEventRecorder?: ContactTagEventRecorder;
  /** Enqueues route 21's job (R46). */
  bulkActionQueue?: ContactBulkActionQueue;
  /**
   * The channels' sending ports (AU35) — her messages (route 24) and the failed-message summary and
   * retry (routes 25–26) by the contact's `channel` (6, ROUTE row R19).
   */
  sendingPorts?: ChannelSendingPorts;
  /** Her runs' history (route 24) — the run engine's reader (4.B, R19). */
  runEventReader?: ContactRunEventReader;
}

/**
 * What route 20 changed, for the controller's audit entries (CT10).
 *
 * @remarks
 * Notes: `changedFields` names fields only, never values (CT4); `pauseChange` drives the separate
 * WARNING entries of D71.
 */
export interface ContactUpdateResult {
  contact: ContactDetailOutput;
  /** The fields that changed — names only, never values (CT4). */
  changedFields: string[];
  /** `pause` / `resume` when the pause flipped, else `null`. */
  pauseChange: 'pause' | 'resume' | null;
}

/**
 * The caller of a contact write route: its organization scope and user.
 *
 * @remarks
 * Notes: the scope is the verified `org` claim; the user public id is empty for an API key.
 */
export interface ContactCaller {
  scope: OrganizationPrincipalDatabaseScope;
  /** `usr_…` of the signed-in user; empty for an API key (the pause then names nobody). */
  userPublicId: string;
}

/** The tags a contact holds after the owner's change, and what actually changed (CT5). */
function applyOwnerTagChange({
  heldTags,
  addTags,
  removeTags,
}: {
  heldTags: readonly string[];
  addTags: readonly string[];
  removeTags: readonly string[];
}): { tags: string[]; added: string[]; removed: string[] } {
  const removeSet = new Set(removeTags);
  const removed = heldTags.filter((tag) => removeSet.has(tag));
  const kept = heldTags.filter((tag) => !removeSet.has(tag));
  const keptSet = new Set(kept);
  const added = addTags.filter((tag) => !keptSet.has(tag));
  return { tags: [...kept, ...added], added, removed };
}

/** The count deltas of one contact's tag change (S7). */
function tagCountDeltas({
  added,
  removed,
}: {
  added: readonly string[];
  removed: readonly string[];
}): ContactTagCountDelta[] {
  return [
    ...added.map((tag) => ({ tag, delta: 1 })),
    ...removed.map((tag) => ({ tag, delta: -1 })),
  ];
}

/** An Instagram user id as the webhook sends it: digits only (`chk_contacts_instagram_user_id`). */
const INSTAGRAM_USER_ID = /^\d{1,64}$/;

/** "What happened" shows our messages of about this many days (CT14 `meta.message_horizon_days`, P13). */
const CONTACT_MESSAGE_HORIZON_DAYS = 30;

/** `404 contact_not_found` — absent, another organization's, or already erased (K1, CT9). */
function contactNotFoundError(): NotFoundError {
  return new NotFoundError('Contact').withReason('contact_not_found');
}

/** `404 channel_account_not_found` — not an account of the organization (1B.5). */
function channelAccountNotFoundError(): NotFoundError {
  return new NotFoundError('Channel account').withReason('channel_account_not_found');
}

/** An empty first page — the list of an account the organization does not have (CT12). */
function emptyContactPage(limit: number): ContactPageOutput {
  return { items: [], limit, has_more: false, next_cursor: null, total: 0 };
}

/** The order a list without `order` uses: newest first for the two times, A→Z for `username` (CT6). */
function defaultContactOrder(sort: ContactSortField): 'asc' | 'desc' {
  return sort === 'username' ? 'asc' : 'desc';
}

/** A username as the column holds it: trimmed; `null` when empty or longer than the column. */
function normalizeContactUsername(username: string | null | undefined): string | null {
  const trimmed = username?.trim() ?? '';
  return trimmed === '' || trimmed.length > CONTACT_USERNAME_MAX_LENGTH ? null : trimmed;
}

/**
 * A profile read or follow check (CQ3) as the columns it sets: a field left `undefined` is not
 * touched; a username only when one is given (never blanked); a picture only on `https://`; a
 * follower count only when a whole number ≥ 0; a follow answer with its check time.
 */
function toContactProfileValues({
  profile,
  checkedAt,
}: {
  profile: ContactProfileInput;
  checkedAt: Date;
}): ContactProfileValues {
  const values: ContactProfileValues = {};
  const username = normalizeContactUsername(profile.username);
  if (username !== null) values.username = username;
  if (profile.fullName !== undefined) {
    const fullName = profile.fullName?.trim().slice(0, CONTACT_FULL_NAME_MAX_LENGTH) ?? '';
    values.full_name = fullName === '' ? null : fullName;
  }
  if (profile.profilePictureUrl !== undefined) {
    const url = profile.profilePictureUrl;
    values.profile_picture_url = url?.startsWith('https://') ? url : null;
  }
  if (profile.followersCount !== undefined) {
    const count = profile.followersCount;
    values.followers_count = count !== null && Number.isInteger(count) && count >= 0 ? count : null;
  }
  if (profile.isFollowingAccount !== undefined) {
    values.is_following_account = profile.isFollowingAccount;
    values.follow_checked_at = checkedAt;
  }
  return values;
}

/**
 * The contact service (routes-final § 3, 3.A): the routes 18–23 for the team, and the operations
 * event processing, the run engine, sending and broadcasts write contacts through (3.A.10, CT1).
 *
 * @remarks
 * Algorithm:
 * - Routes run in the caller's organization scope (`withAppDatabaseContext`, one transaction),
 *   team-only (3.5): reads answer `404 team_organization_required` on a personal organization
 *   (`assertTeamOrganizationForRead`), writes `422` (`assertTeamOrganization`) — the second line
 *   behind the permission gate. Every list names its channel account (CT2).
 * - The owner's change (route 20) locks the contact `FOR NO KEY UPDATE`, applies the note, the tags
 *   (≤ 50 held, else `422 contact_tag_limit`) and the pause, moves the account's tag counts (S7),
 *   hands each tag change to the tag-event port (3.B) and runs the pause steps — all in one commit.
 * - The worker operations run on the caller's organization-scoped job handle
 *   (`createWorkerContactRepository(databaseHandle)`), never open a context of their own, change a
 *   live contact only and answer `null` for an erased one, so the caller stops (CT9).
 * - The erase locks the live contact, runs every registered {@link ContactErasureStep}, anonymises
 *   the row, deletes its activity row and lowers the tag counts — one unit of work (CT11).
 *
 * Failure modes:
 * - `404 contact_not_found` / `channel_account_not_found`; `404 team_organization_required` /
 *   `422` on a personal organization; `409 record_changed`; `422 contact_tag_limit`,
 *   `contact_bulk_too_many`; `503 contact_bulk_action_unavailable` until the bulk job's row (R46).
 *
 * Side effects:
 * - Writes the three contact tables; the erase and the pause also run the registered steps' writes.
 *   The audit entries are the controller's, after commit (CT10).
 *
 * Notes:
 * - Only this service writes contacts (CT1). Nothing here logs a contact's personal data — log
 *   lines carry public ids and counts (CT4).
 */
export class ContactService {
  private readonly pauseSteps: readonly ContactPauseStep[];

  constructor(
    private readonly contactRepository: ContactRepository,
    private readonly organizationService: OrganizationService,
    private readonly erasureSteps: readonly ContactErasureStep[],
    private readonly automationFilterResolver: ContactAutomationFilterResolver,
    private readonly ports: ContactServicePorts = {},
  ) {
    this.pauseSteps = ports.pauseSteps ?? [];
  }

  /**
   * One page of one account's live contacts (route 18, CT2, CT12), with the capped total on the
   * first page.
   *
   * @remarks
   * Algorithm: one unit of work — the team check; the account read back inside the organization
   * (an unknown one → an empty page); the `automation_id` and `first_automation_id` filters
   * resolved through the automation sub-domain (none → an empty page); then the repository list with
   * the sort and order resolved (default `last_message_received_at`, newest first; `username` A→Z).
   * Failure modes: `404 team_organization_required` on a personal organization; a search past its
   * 2 s timeout fails the request (S6). Side effects: none.
   */
  async listContacts({ scope, query }: ContactListInput): Promise<ContactPageOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        const channelAccountId = await this.contactRepository.findChannelAccountId({
          organizationId: organization.id,
          channelAccountPublicId: query.channelAccountPublicId,
        });
        if (channelAccountId === null) return emptyContactPage(query.limit);
        const filterIds = await this.resolveFilterAutomations({
          scope,
          organizationId: organization.id,
          filter: query,
        });
        const sort = query.sort ?? CONTACT_DEFAULT_SORT;
        const page = await this.contactRepository.list({
          organizationId: organization.id,
          query: {
            ...query,
            ...filterIds,
            sort,
            order: query.order ?? defaultContactOrder(sort),
            channelAccountId,
          },
        });
        const now = new Date();
        return {
          ...page,
          items: page.items.map((row) => serializeContact({ contact: row, now })),
        };
      },
    });
  }

  /**
   * Opens one contact (route 19, CT13): the Contact detail.
   *
   * @remarks
   * Algorithm: one unit of work — the team check, the detail read (her first automation's name and
   * open-run count in the same statement), the pausing user's public id. Failure modes:
   * `404 contact_not_found`, `404 team_organization_required`. Side effects: none.
   */
  async getContact({ scope, contactPublicId }: ContactDeleteInput): Promise<ContactDetailOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        return this.readDetail({ organizationId: organization.id, contactPublicId });
      },
    });
  }

  /**
   * Her live contact's id and her channel's sending port (routes 24–26): the team check (a read's
   * `404 team_organization_required`, a write's `422`), the live contact (`404 contact_not_found`).
   */
  private async resolveContactMessages({
    scope,
    contactPublicId,
    isWrite,
  }: {
    scope: ContactCaller['scope'];
    contactPublicId: string;
    isWrite: boolean;
  }): Promise<{ organizationId: number; contactId: number; port: ChannelSendingPort | undefined }> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        if (isWrite) assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        else assertTeamOrganizationForRead({ organization });
        const contact = await this.contactRepository.findLiveKeyByPublicId({
          organizationId: organization.id,
          contactPublicId,
        });
        if (contact === null) throw contactNotFoundError();
        return {
          organizationId: organization.id,
          contactId: contact.id,
          port: this.ports.sendingPorts?.[contact.channel as keyof ChannelSendingPorts],
        };
      },
    });
  }

  /**
   * "What happened" (route 24, CT14, D46, D50): our messages of about the last 30 days and her runs'
   * history, merged newest first — never her own text, never a collected value.
   *
   * @remarks
   * Algorithm: the contact read, then each source reads `limit + 1` after the keyset `(occurred_at,
   * source, id)`; the merge sorts and `finishKeysetPage` cuts and mints the next cursor (its
   * `sort_value` is the source). Failure modes: `404 contact_not_found`, `404
   * team_organization_required`. Side effects: none.
   */
  async listContactActivity({
    scope,
    contactPublicId,
    query,
  }: {
    scope: ContactCaller['scope'];
    contactPublicId: string;
    query: { limit: number; after: string | undefined };
  }): Promise<ContactActivityPageOutput> {
    const { organizationId, contactId, port } = await this.resolveContactMessages({
      scope,
      contactPublicId,
      isWrite: false,
    });
    const parsed = parseListCursor(query.after);
    const after: ChannelActivityCursor | null =
      parsed?.id !== undefined &&
      (parsed.sort_value === 'message' || parsed.sort_value === 'run_event')
        ? { occurredAt: parsed.created_at, source: parsed.sort_value, id: parsed.id }
        : null;
    const read = { scope, organizationId, contactId, after, limit: query.limit + 1 };
    const messages = (await port?.listContactMessages(read)) ?? [];
    const events = (await this.ports.runEventReader?.(read)) ?? [];
    type Entry = {
      id: number;
      cursor_created_at: string;
      source: 'message' | 'run_event';
      item: ContactActivityItemOutput;
    };
    const entries: Entry[] = [
      ...messages.map((message) => ({
        id: message.id,
        cursor_created_at: message.occurredAt,
        source: 'message' as const,
        item: {
          id: message.publicId,
          source: 'message' as const,
          occurred_at: message.occurredAt,
          automation: message.automation,
          automation_run_id: message.automationRunPublicId,
          broadcast_id: message.broadcastPublicId,
          message_type: message.messageType,
          message_number: message.messageNumber,
          status: message.status,
          reason: message.reason,
          channel: message.channel,
        },
      })),
      ...events.map((event) => ({
        id: event.id,
        cursor_created_at: event.cursor_created_at,
        source: 'run_event' as const,
        item: {
          id: null,
          source: 'run_event' as const,
          occurred_at: event.cursor_created_at,
          automation: { id: event.automation_public_id, name: event.automation_name },
          automation_run_id: event.automation_run_public_id,
          broadcast_id: null,
          event_type: event.event_type,
          status: event.status,
        },
      })),
    ];
    // Newest first: time, then `run_event` before `message`, then the higher id.
    entries.sort(
      (left, right) =>
        right.cursor_created_at.localeCompare(left.cursor_created_at) ||
        right.source.localeCompare(left.source) ||
        right.id - left.id,
    );
    const page = finishKeysetPage({
      rows: entries.slice(0, query.limit + 1),
      args: { limit: query.limit, sortValueFor: (entry) => entry.source },
    });
    return {
      items: page.items.map((entry) => entry.item),
      limit: page.limit,
      has_more: page.has_more,
      next_cursor: page.next_cursor,
      messageHorizonDays: CONTACT_MESSAGE_HORIZON_DAYS,
    };
  }

  /**
   * Her failed messages of about the last 30 days, counted (route 25, CT15) — changes nothing.
   *
   * @remarks
   * Algorithm: the contact read, then her channel's summary. Failure modes: `404
   * contact_not_found`. Side effects: none. Notes: a channel without a port counts nothing.
   */
  async summarizeContactFailedMessages({
    scope,
    contactPublicId,
  }: {
    scope: ContactCaller['scope'];
    contactPublicId: string;
  }): Promise<FailedMessagesSummaryOutput> {
    const { organizationId, contactId, port } = await this.resolveContactMessages({
      scope,
      contactPublicId,
      isWrite: false,
    });
    const target = { scope, organizationId, by: 'contact' as const, id: contactId };
    const summary = await port?.summarizeFailedMessages(target);
    return serializeFailedMessagesSummary(summary ?? emptyFailedMessagesSummary());
  }

  /**
   * Retries her failed messages (route 26, CT15, D72): the allowed ones go back to `waiting`, each at
   * most once; an opted-out or paused contact has none allowed, so nothing goes. Answers the object
   * and the press (the controller's audit counts).
   *
   * @remarks
   * Algorithm: the contact read (a write's team check), then her channel's retry. Failure modes:
   * `404 contact_not_found`, `422` for a personal organization. Side effects: the channel's.
   */
  async retryContactFailedMessages({
    caller,
    contactPublicId,
  }: {
    caller: ContactCaller;
    contactPublicId: string;
  }): Promise<{ data: FailedMessagesRetryOutput; retry: ChannelFailedMessagesRetry }> {
    const { organizationId, contactId, port } = await this.resolveContactMessages({
      scope: caller.scope,
      contactPublicId,
      isWrite: true,
    });
    const retry = (await port?.retryFailedMessages({
      scope: caller.scope,
      organizationId,
      by: 'contact',
      id: contactId,
    })) ?? { summary: emptyFailedMessagesSummary(), expectedRetryCount: 0, isQueued: false };
    return { data: serializeFailedMessagesRetry(retry), retry };
  }

  /**
   * The owner's change of one contact (route 20, CT5, D46, D71): note, tags, pause — in one commit
   * with its tag counts, tag events and pause steps.
   *
   * @remarks
   * Algorithm: one unit of work — the team check (`422`); the live contact locked `FOR NO KEY
   * UPDATE` (`404 contact_not_found`); `expected_updated_at` older than the row → `409
   * record_changed`; the tags removed then added (a held tag is not added twice, an absent one not
   * removed), more than 50 → `422 contact_tag_limit`; the note; the pause — on: `automations_off_at`
   * now and the user, then each pause step with `contact_excluded`; off: both cleared, nothing
   * restarted. A change writes the row once, moves the tag counts (S7) and hands one event per tag
   * change to the tag-event port (3.B, `source` `owner`). A body that changes nothing writes
   * nothing. Failure modes: as listed; a step that throws rolls everything back. Side effects: the
   * contact, the counts, the steps' and the port's writes.
   */
  async updateContact({
    caller,
    contactPublicId,
    input,
  }: {
    caller: ContactCaller;
    contactPublicId: string;
    input: ContactUpdateInput;
  }): Promise<ContactUpdateResult> {
    return withAppDatabaseContext({
      scope: caller.scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          caller.scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const organizationId = organization.id;
        const contact = await this.contactRepository.lockLiveByPublicId({
          organizationId,
          contactPublicId,
          strength: 'no key update',
        });
        if (contact === null) throw contactNotFoundError();
        await assertRecordNotChangedSince({
          row: { updated_at: contact.updated_at, updated_by_user_id: null },
          expected: input.expectedUpdatedAt?.toISOString(),
          resolveUserPublicId: async () => null,
        });
        const tagChange = applyOwnerTagChange({
          heldTags: contact.tags,
          addTags: input.addTags,
          removeTags: input.removeTags,
        });
        if (tagChange.tags.length > CONTACT_TAGS_MAX_COUNT) {
          throw new UnprocessableEntityError('errors:contactTagLimit', {
            max: CONTACT_TAGS_MAX_COUNT,
          }).withReason('contact_tag_limit');
        }
        const changedFields: string[] = [];
        const values: {
          note?: string | null;
          tags?: string[];
          automations_off_at?: Date | null;
          automations_off_by_user_id?: number | null;
        } = {};
        if (input.note !== undefined && input.note !== contact.note) {
          values.note = input.note;
          changedFields.push('note');
        }
        if (tagChange.added.length > 0 || tagChange.removed.length > 0) {
          values.tags = tagChange.tags;
          changedFields.push('tags');
        }
        let pauseChange: ContactUpdateResult['pauseChange'] = null;
        const isPaused = contact.automations_off_at !== null;
        if (input.isAutomationsPaused === true && !isPaused) {
          values.automations_off_at = new Date();
          values.automations_off_by_user_id =
            await this.organizationService.resolveUserInternalIdByPublicId(caller.userPublicId);
          pauseChange = 'pause';
        } else if (input.isAutomationsPaused === false && isPaused) {
          values.automations_off_at = null;
          values.automations_off_by_user_id = null;
          pauseChange = 'resume';
        }
        if (pauseChange !== null) changedFields.push('is_automations_paused');
        if (changedFields.length > 0) {
          await this.contactRepository.updateOwnerFields({
            organizationId,
            contactId: contact.id,
            values,
          });
        }
        await this.recordTagChanges({
          contact,
          added: tagChange.added,
          removed: tagChange.removed,
          source: 'owner',
          sourceAutomationId: null,
          chainNumber: 0,
        });
        if (pauseChange === 'pause') {
          await this.runPauseSteps({
            organizationId,
            contactId: contact.id,
            reason: 'contact_excluded',
          });
        }
        return {
          contact: await this.readDetail({ organizationId, contactPublicId }),
          changedFields,
          pauseChange,
        };
      },
    });
  }

  /**
   * One tag or pause on many contacts of one account (route 21, CT7, P66): counts the selection and
   * queues the bulk job.
   *
   * @remarks
   * Algorithm: one unit of work — the team check (`422`); the account read back inside the
   * organization (`404 channel_account_not_found`); the filter's automation ids resolved; the live
   * contacts the ids or the filter select counted up to 100,001 — more than 100,000 → `422
   * contact_bulk_too_many`; then, after commit, the job enqueued through the bulk-action port with the
   * organization's and account's public ids, the action and the selection. The job works in pieces of
   * 500 (WC-36, R46). Failure modes: as listed; `503 contact_bulk_action_unavailable` while no queue
   * port is wired (until ROUTE row R46). Side effects: one queued job.
   */
  async startBulkAction({
    caller,
    input,
  }: {
    caller: ContactCaller;
    input: ContactBulkActionInput;
  }): Promise<ContactBulkActionOutput> {
    const matchedCount = await withAppDatabaseContext({
      scope: caller.scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          caller.scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const channelAccountId = await this.contactRepository.findChannelAccountId({
          organizationId: organization.id,
          channelAccountPublicId: input.channelAccountPublicId,
        });
        if (channelAccountId === null) throw channelAccountNotFoundError();
        const filter =
          input.filter === null
            ? null
            : {
                ...input.filter,
                ...(await this.resolveFilterAutomations({
                  scope: caller.scope,
                  organizationId: organization.id,
                  filter: input.filter,
                })),
              };
        return this.contactRepository.countBulkSelection({
          organizationId: organization.id,
          channelAccountId,
          contactPublicIds: input.contactPublicIds,
          filter,
          cap: CONTACT_BULK_ACTION_MATCH_MAX_COUNT + 1,
        });
      },
    });
    if (matchedCount > CONTACT_BULK_ACTION_MATCH_MAX_COUNT) {
      throw new UnprocessableEntityError('errors:contactBulkTooMany', {
        max: CONTACT_BULK_ACTION_MATCH_MAX_COUNT,
      }).withReason('contact_bulk_too_many');
    }
    const queue = this.ports.bulkActionQueue;
    if (queue === undefined) {
      throw new ServiceUnavailableError('errors:contactBulkActionUnavailable').withReason(
        'contact_bulk_action_unavailable',
      );
    }
    await queue.enqueueContactBulkAction({
      organizationPublicId: caller.scope.organizationPublicId,
      channelAccountPublicId: input.channelAccountPublicId,
      action: input.action,
      tag: input.tag,
      contactPublicIds: input.contactPublicIds,
      filter: input.filter,
      actorUserPublicId: caller.userPublicId,
    });
    return { action: input.action, matched_count: matchedCount, is_queued: true };
  }

  /**
   * One account's tags with how many live contacts hold each (route 22, CT8, S7): most first, then
   * A→Z, up to `limit`.
   *
   * @remarks
   * Algorithm: one unit of work — the team check; the account read back inside the organization
   * (`404 channel_account_not_found`, CTQ1); one index range read of `app.contact_tag_counts`, kept
   * in every tag commit — so a change shows at once (no cache: S7 replaces CT8's 60 s copy, P123).
   * Failure modes: as listed. Side effects: none.
   */
  async listContactTags({
    scope,
    channelAccountPublicId,
    limit,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
    limit: number;
  }): Promise<ContactTagCountOutput[]> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        const channelAccountId = await this.contactRepository.findChannelAccountId({
          organizationId: organization.id,
          channelAccountPublicId,
        });
        if (channelAccountId === null) throw channelAccountNotFoundError();
        const rows = await this.contactRepository.listTagCounts({
          organizationId: organization.id,
          channelAccountId,
          limit,
        });
        return rows.map(serializeContactTagCount);
      },
    });
  }

  /**
   * Erases one contact (route 23, CT11): locks the live contact, runs every registered erasure step,
   * then clears its personal data, deletes its activity row and lowers the account's tag counts —
   * all in one transaction. Returns the contact's public id for the controller's audit entry.
   *
   * @remarks
   * Algorithm: one unit of work — the team check (`422`), `SELECT … FOR UPDATE` of the live contact
   * (`404 contact_not_found`), each step in registration order with `{ organizationId, contactId,
   * instagramUserId }` (4.B's run copies and cancels; 3.B's tag events and 6's waiting messages
   * register at their rows), the anonymising update, the count deltas. Failure modes: `404
   * contact_not_found` when absent, another organization's or already erased (a repeat); a step
   * that throws rolls everything back. Side effects: the contact rows, the counts and the steps'
   * writes. No restore: the data is gone.
   */
  async deleteContact({
    scope,
    contactPublicId,
  }: ContactDeleteInput): Promise<{ contactPublicId: string }> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
        const contact = await this.contactRepository.lockLiveByPublicId({
          organizationId: organization.id,
          contactPublicId,
        });
        if (contact?.instagram_user_id == null) throw contactNotFoundError();
        for (const erasureStep of this.erasureSteps) {
          await erasureStep({
            organizationId: organization.id,
            contactId: contact.id,
            instagramUserId: contact.instagram_user_id,
          });
        }
        const erased = await this.contactRepository.erase({
          organizationId: organization.id,
          contactId: contact.id,
        });
        if (erased === null) throw contactNotFoundError();
        await this.contactRepository.applyTagCountDeltas({
          organizationId: organization.id,
          channelAccountId: contact.channel_account_id,
          deltas: contact.tags.map((tag) => ({ tag, delta: -1 })),
        });
        return { contactPublicId: erased.public_id };
      },
    });
  }

  /** The Contact detail of a live contact, inside the caller's unit (`404 contact_not_found`). */
  private async readDetail({
    organizationId,
    contactPublicId,
  }: {
    organizationId: number;
    contactPublicId: string;
  }): Promise<ContactDetailOutput> {
    const row = await this.contactRepository.findDetailByPublicId({
      organizationId,
      contactPublicId,
    });
    if (row === null) throw contactNotFoundError();
    const pausedBy = row.automations_off_by_user_id;
    const userPublicIds =
      pausedBy === null
        ? new Map<number, string>()
        : await this.organizationService.resolveUserPublicIdsByInternalIds([pausedBy]);
    return serializeContactDetail({
      contact: row,
      automations_paused_by_user_public_id:
        pausedBy === null ? null : (userPublicIds.get(pausedBy) ?? null),
      now: new Date(),
    });
  }

  /** The `automation_id` and `first_automation_id` filters as internal ids (CT5, CT12). */
  private async resolveFilterAutomations({
    scope,
    organizationId,
    filter,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    filter: Pick<ContactBulkActionFilter, 'automationPublicId' | 'firstAutomationPublicId'>;
  }): Promise<{
    automationId: number | null | undefined;
    firstAutomationId: number | null | undefined;
  }> {
    const resolve = async (automationPublicId: string | undefined) =>
      automationPublicId === undefined
        ? undefined
        : this.automationFilterResolver({ scope, organizationId, automationPublicId });
    return {
      automationId: await resolve(filter.automationPublicId),
      firstAutomationId: await resolve(filter.firstAutomationPublicId),
    };
  }

  /**
   * One contact's tag change in the caller's unit: the account's tag counts moved (S7) and one event
   * per tag handed to the tag-event port (3.B — `ContactTagEventService`, in the same unit).
   */
  private async recordTagChanges({
    contact,
    added,
    removed,
    source,
    sourceAutomationId,
    chainNumber,
    databaseHandle,
  }: {
    contact: Pick<ContactRow, 'id' | 'organization_id' | 'channel_account_id'>;
    added: readonly string[];
    removed: readonly string[];
    source: ContactTagChangeEvent['source'];
    sourceAutomationId: number | null;
    chainNumber: number;
    databaseHandle?: WorkerDatabaseHandle;
  }): Promise<void> {
    if (added.length === 0 && removed.length === 0) return;
    const repository =
      databaseHandle === undefined
        ? this.contactRepository
        : createWorkerContactRepository(databaseHandle);
    await repository.applyTagCountDeltas({
      organizationId: contact.organization_id,
      channelAccountId: contact.channel_account_id,
      deltas: tagCountDeltas({ added, removed }),
    });
    const toEvent = ({
      tag,
      kind,
    }: {
      tag: string;
      kind: ContactTagChangeEvent['kind'];
    }): ContactTagChangeEvent => ({
      organizationId: contact.organization_id,
      channelAccountId: contact.channel_account_id,
      contactId: contact.id,
      tag,
      kind,
      source,
      sourceAutomationId,
      chainNumber,
    });
    await this.ports.tagEventRecorder?.recordContactTagEvents({
      events: [
        ...added.map((tag) => toEvent({ tag, kind: 'added' })),
        ...removed.map((tag) => toEvent({ tag, kind: 'removed' })),
      ],
      ...(databaseHandle === undefined ? {} : { databaseHandle }),
    });
  }

  /** Every registered pause step, in registration order, inside the caller's unit (CTC4). */
  private async runPauseSteps(input: {
    organizationId: number;
    contactId: number;
    reason: ContactPauseReason;
    databaseHandle?: WorkerDatabaseHandle;
  }): Promise<void> {
    for (const pauseStep of this.pauseSteps) {
      await pauseStep(input);
    }
  }

  /**
   * Creates the contact of one processed comment, DM, story reply or button click, or touches the
   * live one (2.10, CT13) — says whether this event created it, so sub-domain 4 reads the Instagram
   * profile for a new contact only (CQ3).
   *
   * @remarks
   * Algorithm: one upsert on `(organization_id, channel_account_id, instagram_user_id)` on the
   * job's handle, then one on its activity row (S5): a new contact's first-seen and last-message
   * times are the event's; an existing one takes the event's username when it carries one and moves
   * its message times forward (`greatest`); every kind but `comment` also moves
   * `last_direct_message_received_at`. Failure
   * modes: throws on an Instagram user id that is not digits (a caller bug). Side effects: one
   * insert or update. An erased contact is never matched — its Instagram user id is gone (CT9).
   */
  async recordContactInteraction(
    input: RecordContactInteractionInput,
  ): Promise<ContactInteractionResult> {
    if (!INSTAGRAM_USER_ID.test(input.instagramUserId)) {
      throw new Error('recordContactInteraction: the Instagram user id must be digits only');
    }
    const { contact, isInserted } = await createWorkerContactRepository(
      input.databaseHandle,
    ).upsertInteraction({
      organizationId: input.organizationId,
      channelAccountId: input.channelAccountId,
      instagramUserId: input.instagramUserId,
      username: normalizeContactUsername(input.username),
      occurredAt: input.occurredAt,
      isDirectMessage: input.interactionKind !== CONTACT_INTERACTION_KIND.COMMENT,
    });
    return { contact, isNewContact: isInserted };
  }

  /**
   * Saves what one Instagram profile read or follow check found (2.10, CQ3) on a live contact: the
   * fields given — username, full name, picture, followers — and a follow answer with its check
   * time. Returns the contact, or `null` once erased.
   *
   * @remarks
   * Algorithm: the given fields normalised (a username never blanked, a picture only on
   * `https://`, a count only when a whole number ≥ 0), then one guarded update; nothing given → the
   * live contact as is. Failure modes: none of its own. Side effects: one update.
   */
  async recordContactProfile({
    databaseHandle,
    organizationId,
    contactId,
    profile,
    checkedAt,
  }: ContactWorkerKey & {
    profile: ContactProfileInput;
    checkedAt: Date;
  }): Promise<ContactRow | null> {
    const repository = createWorkerContactRepository(databaseHandle);
    const values = toContactProfileValues({ profile, checkedAt });
    if (Object.keys(values).length === 0) {
      return repository.findLiveById({ organizationId, contactId });
    }
    return repository.updateProfile({ organizationId, contactId, values });
  }

  /**
   * Saves the email a contact typed (the email step, 2.10, CT10) — or answers `invalid` so the run
   * asks again; `null` once the contact is erased.
   *
   * @remarks
   * Algorithm: the live contact first (`null` when erased); `trimmedEmail()` as is (trimmed, lower
   * case, an email's shape, no Gmail plus address); a valid one saved with its time in one guarded
   * update. Failure modes: none of its own. Side effects: one update.
   */
  async recordContactEmail({
    databaseHandle,
    organizationId,
    contactId,
    email,
    collectedAt,
  }: ContactWorkerKey & {
    email: string;
    collectedAt: Date;
  }): Promise<ContactCollectedValueResult | null> {
    const repository = createWorkerContactRepository(databaseHandle);
    if ((await repository.findLiveById({ organizationId, contactId })) === null) return null;
    const normalized = normalizeContactEmail(email);
    if (normalized === null) return { outcome: 'invalid' };
    const contact = await repository.recordEmail({
      organizationId,
      contactId,
      email: normalized,
      collectedAt,
    });
    return contact === null ? null : { outcome: 'saved', contact };
  }

  /**
   * Saves the phone number a contact typed (the phone step, 2.10, CT10) — or answers `invalid` so
   * the run keeps waiting; `null` once the contact is erased.
   *
   * @remarks
   * Algorithm: the live contact first (`null` when erased); spaces, dashes, dots and brackets
   * dropped, a leading `+` kept, then an optional `+` and 10–15 digits; a valid one saved with its
   * time in one guarded update. Failure modes: none of its own. Side effects: one update.
   */
  async recordContactPhone({
    databaseHandle,
    organizationId,
    contactId,
    phone,
    collectedAt,
  }: ContactWorkerKey & {
    phone: string;
    collectedAt: Date;
  }): Promise<ContactCollectedValueResult | null> {
    const repository = createWorkerContactRepository(databaseHandle);
    if ((await repository.findLiveById({ organizationId, contactId })) === null) return null;
    const normalized = normalizeContactPhone(phone);
    if (normalized === null) return { outcome: 'invalid' };
    const contact = await repository.recordPhone({
      organizationId,
      contactId,
      phone: normalized,
      collectedAt,
    });
    return contact === null ? null : { outcome: 'saved', contact };
  }

  /**
   * Adds a run's tags to a live contact (the tag step, 3.A.10, CT9): the ones it does not hold yet,
   * in order, up to 50 — past 50 a new tag is dropped and logged, and the run still completes. Moves
   * the account's tag counts and hands one tag event per added tag to the tag-event port (`source`
   * `automation`) in the same unit. Returns the contact, or `null` once erased.
   *
   * @remarks
   * Algorithm: the live contact's tags, merged in memory (`mergeContactTags`), then one guarded
   * update when a tag was added, the counts (S7) and the events (3.B, R11). Event processing handles
   * one account's events in order (D15), so no other write races this one; route 23's erase wins
   * through the live guard. Failure modes: none of its own — never fails the run. Side effects: one
   * update, the counts, the events; one warning log line (counts and public ids only) when tags were
   * dropped.
   */
  async addContactTags({
    databaseHandle,
    organizationId,
    contactId,
    tags,
    sourceAutomationId = null,
    chainNumber = 0,
  }: ContactWorkerKey & {
    tags: readonly string[];
    /** The automation of the tag step (`source_automation_id`). */
    sourceAutomationId?: number | null;
    /** How many tag starts led here (3.B's chain number). */
    chainNumber?: number;
  }): Promise<ContactRow | null> {
    const repository = createWorkerContactRepository(databaseHandle);
    const contact = await repository.findLiveById({ organizationId, contactId });
    if (contact === null) return null;
    const merged = mergeContactTags({ heldTags: contact.tags, newTags: tags });
    if (merged.droppedTags.length > 0) {
      logger.warn(
        { contactPublicId: contact.public_id, droppedTagCount: merged.droppedTags.length },
        'app.contact.tags_dropped_over_limit',
      );
    }
    if (merged.addedTags.length === 0) return contact;
    const updated = await repository.replaceTags({ organizationId, contactId, tags: merged.tags });
    if (updated === null) return null;
    await this.recordTagChanges({
      contact,
      added: merged.addedTags,
      removed: [],
      source: 'automation',
      sourceAutomationId,
      chainNumber,
      databaseHandle,
    });
    return updated;
  }

  /**
   * Records a DM sent to a live contact (2.10): `last_message_sent_at` moves forward to `sentAt`
   * (`greatest`) — the 24-hour opening-DM rule reads it. Returns the contact, or `null` once erased.
   *
   * @remarks
   * Algorithm: one guarded update. Failure modes: none of its own. Side effects: one update.
   */
  async recordContactMessageSent({
    databaseHandle,
    organizationId,
    contactId,
    sentAt,
  }: ContactWorkerKey & { sentAt: Date }): Promise<ContactRow | null> {
    return createWorkerContactRepository(databaseHandle).recordMessageSent({
      organizationId,
      contactId,
      sentAt,
    });
  }

  /**
   * Her stop word (CT6, D49): `opted_out_at` set (an earlier one kept) and, in the same unit, every
   * pause step with reason `opted_out` — her waiting messages `skipped`, her open runs `cancelled`.
   * Called by intake (sub-domain 5) on the job's handle. Returns the contact, or `null` once erased.
   *
   * @remarks
   * Algorithm: one guarded update, then the steps. Failure modes: a step that throws rolls the
   * unit back. Side effects: the update and the steps' writes. No route sets or clears it (AC-5.10).
   */
  async recordContactOptOut({
    databaseHandle,
    organizationId,
    contactId,
    optedOutAt,
  }: ContactWorkerKey & { optedOutAt: Date }): Promise<ContactRow | null> {
    const contact = await createWorkerContactRepository(databaseHandle).setOptedOut({
      organizationId,
      contactId,
      at: optedOutAt,
    });
    if (contact === null) return null;
    await this.runPauseSteps({ organizationId, contactId, reason: 'opted_out', databaseHandle });
    return contact;
  }

  /**
   * Clears her opt-out (CT6) — only intake calls it, on her own new action of the kinds D49 lists,
   * in the commit that starts that run. Returns the contact, or `null` once erased.
   *
   * @remarks
   * Algorithm: one guarded update. Failure modes: none of its own. Side effects: one update.
   */
  async clearContactOptOut({
    databaseHandle,
    organizationId,
    contactId,
  }: ContactWorkerKey): Promise<ContactRow | null> {
    return createWorkerContactRepository(databaseHandle).setOptedOut({
      organizationId,
      contactId,
      at: null,
    });
  }

  /**
   * One comment of hers (3.A.10): `last_comment_at` moves forward, `comment_count` + 1 — on the
   * activity row (S5). Returns the contact, or `null` once erased.
   *
   * @remarks
   * Algorithm: one guarded update of the activity row. Failure modes: none. Side effects: one update.
   */
  async recordContactComment({
    databaseHandle,
    organizationId,
    contactId,
    occurredAt,
  }: ContactWorkerKey & { occurredAt: Date }): Promise<ContactRow | null> {
    return createWorkerContactRepository(databaseHandle).recordActivity({
      organizationId,
      contactId,
      change: { kind: 'comment', at: occurredAt },
    });
  }

  /**
   * A story reply or mention of hers (3.A.10): `last_story_activity_at` moves forward. Returns the
   * contact, or `null` once erased.
   *
   * @remarks
   * Algorithm: one guarded update of the activity row. Failure modes: none. Side effects: one update.
   */
  async recordContactStoryActivity({
    databaseHandle,
    organizationId,
    contactId,
    occurredAt,
  }: ContactWorkerKey & { occurredAt: Date }): Promise<ContactRow | null> {
    return createWorkerContactRepository(databaseHandle).recordActivity({
      organizationId,
      contactId,
      change: { kind: 'story', at: occurredAt },
    });
  }

  /**
   * Her first DM in the chat (3.A.10): `first_message_at`, set once. Returns the contact, or `null`
   * once erased.
   *
   * @remarks
   * Algorithm: one guarded update (`coalesce` keeps the first). Failure modes: none. Side effects:
   * one update.
   */
  async recordContactFirstMessage({
    databaseHandle,
    organizationId,
    contactId,
    occurredAt,
  }: ContactWorkerKey & { occurredAt: Date }): Promise<ContactRow | null> {
    return createWorkerContactRepository(databaseHandle).recordActivity({
      organizationId,
      contactId,
      change: { kind: 'first_message', at: occurredAt },
    });
  }

  /**
   * Her first run (3.A.10, 4.B): `first_automation_id`, `came_in_via` and `came_in_ref`, once — a
   * contact that has them keeps them. Returns the contact, or `null` once erased.
   *
   * @remarks
   * Algorithm: one update guarded on `came_in_via IS NULL`, then the read. Failure modes: none of
   * its own. Side effects: at most one update.
   */
  async recordContactFirstRun({
    databaseHandle,
    organizationId,
    contactId,
    automationId,
    cameInVia,
    cameInRef,
  }: ContactWorkerKey & {
    automationId: number;
    cameInVia: string;
    cameInRef: string | null;
  }): Promise<ContactRow | null> {
    return createWorkerContactRepository(databaseHandle).recordFirstRun({
      organizationId,
      contactId,
      automationId,
      cameInVia,
      cameInRef,
    });
  }

  /**
   * An opening DM to her `sent` or `unknown` (3.A.10, sub-domain 6): `last_opening_message_at` moves
   * forward. Returns the contact, or `null` once erased.
   *
   * @remarks
   * Algorithm: one guarded update of the activity row. Failure modes: none. Side effects: one update.
   */
  async recordContactOpeningMessage({
    databaseHandle,
    organizationId,
    contactId,
    sentAt,
  }: ContactWorkerKey & { sentAt: Date }): Promise<ContactRow | null> {
    return createWorkerContactRepository(databaseHandle).recordActivity({
      organizationId,
      contactId,
      change: { kind: 'opening_message', at: sentAt },
    });
  }

  /**
   * A broadcast message to her `sent` (3.A.10, sub-domain 7): `last_broadcast_at` moves forward.
   * Returns the contact, or `null` once erased.
   *
   * @remarks
   * Algorithm: one guarded update of the activity row. Failure modes: none. Side effects: one update.
   */
  async recordContactBroadcastSent({
    databaseHandle,
    organizationId,
    contactId,
    sentAt,
  }: ContactWorkerKey & { sentAt: Date }): Promise<ContactRow | null> {
    return createWorkerContactRepository(databaseHandle).recordActivity({
      organizationId,
      contactId,
      change: { kind: 'broadcast', at: sentAt },
    });
  }

  /**
   * What every send's gate re-reads (3.A.10): erased, opted out, paused and her last DM time.
   *
   * @remarks
   * Algorithm: one read on the job's handle; an erased or absent contact answers `isErased`.
   * Failure modes: none. Side effects: none.
   */
  async findContactSendState({
    databaseHandle,
    organizationId,
    contactId,
  }: ContactWorkerKey): Promise<ContactSendState> {
    const contact = await createWorkerContactRepository(databaseHandle).findLiveById({
      organizationId,
      contactId,
    });
    if (contact === null) {
      return {
        isErased: true,
        isOptedOut: false,
        isAutomationsPaused: false,
        lastDirectMessageReceivedAt: null,
      };
    }
    return {
      isErased: false,
      isOptedOut: contact.opted_out_at !== null,
      isAutomationsPaused: contact.automations_off_at !== null,
      lastDirectMessageReceivedAt: contact.last_direct_message_received_at,
    };
  }

  /**
   * The live contact, or `null` once erased (2.10) — read before each run step and each send, so a
   * run that raced an erase stops before it messages anyone (CT9).
   *
   * @remarks
   * Algorithm: one read on the job's handle. Failure modes: none of its own. Side effects: none.
   */
  async findLiveContact({
    databaseHandle,
    organizationId,
    contactId,
  }: ContactWorkerKey): Promise<ContactRow | null> {
    return createWorkerContactRepository(databaseHandle).findLiveById({
      organizationId,
      contactId,
    });
  }

  /**
   * The live contact, locked until the caller's unit of work ends, or `null` once erased — the first
   * thing every unit of the run engine does, before it locks or writes a run or a comment log of the
   * contact, which copy what the person wrote (CT8, CT9).
   *
   * @remarks
   * Algorithm: one read on the job's handle, locked `FOR KEY SHARE`: an erase (route 10, which locks
   * the contact and then its runs) either waits for the unit and clears what it wrote, or went first
   * and the unit writes nothing — so no personal copy outlives an erase, and the two never block
   * each other. Failure modes: none of its own. Side effects: the row lock.
   */
  async lockLiveContact({
    databaseHandle,
    organizationId,
    contactId,
  }: ContactWorkerKey): Promise<ContactRow | null> {
    return createWorkerContactRepository(databaseHandle).lockLiveById({
      organizationId,
      contactId,
    });
  }
}
