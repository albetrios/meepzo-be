import { withAppDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  assertTeamOrganization,
  assertTeamOrganizationForRead,
} from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import { NotFoundError } from '@/shared/errors/index.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  CONTACT_DEFAULT_SORT,
  CONTACT_FULL_NAME_MAX_LENGTH,
  CONTACT_INTERACTION_KIND,
  CONTACT_USERNAME_MAX_LENGTH,
  type ContactSortField,
} from './contact.constants.js';
import {
  type ContactProfileValues,
  type ContactRepository,
  type ContactRow,
  createWorkerContactRepository,
} from './contact.repository.js';
import { serializeContact } from './contact.serializer.js';
import type {
  ContactAutomationFilterResolver,
  ContactCollectedValueResult,
  ContactDeleteInput,
  ContactErasureStep,
  ContactInteractionResult,
  ContactListInput,
  ContactPageOutput,
  ContactProfileInput,
  ContactWorkerKey,
  RecordContactInteractionInput,
} from './contact.types.js';
import {
  mergeContactTags,
  normalizeContactEmail,
  normalizeContactPhone,
} from './contact.validator.js';

/** An Instagram user id as the webhook sends it: digits only (`chk_contacts_instagram_user_id`). */
const INSTAGRAM_USER_ID = /^\d{1,64}$/;

/** `404 contact_not_found` — absent, another organization's, or already erased (K1, CT9). */
function contactNotFoundError(): NotFoundError {
  return new NotFoundError('Contact').withReason('contact_not_found');
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
 * The contact service (routes-final § 2): the list (route 9) and the erase (route 10) for the team,
 * and the operations event processing (sub-domain 4) and the run engine (sub-domain 3) write
 * contacts through (2.10, CT2).
 *
 * @remarks
 * Algorithm:
 * - Routes run in the caller's organization scope (`withAppDatabaseContext`), team-only (CT3): the
 *   list answers `404 team_organization_required` on a personal organization
 *   (`assertTeamOrganizationForRead`), the erase `422` (`assertTeamOrganization`, capability
 *   `INSTAGRAM`) — the second line behind the permission gate.
 * - The worker operations run on the caller's organization-scoped job handle
 *   (`createWorkerContactRepository(databaseHandle)`), never open a context of their own, change a
 *   live contact only and answer `null` for an erased one, so the caller stops (CT2, CT9).
 * - The erase locks the live contact, runs every registered {@link ContactErasureStep}, then
 *   anonymises the row — one unit of work, so a failing step rolls the whole erase back (CT8).
 *
 * Failure modes:
 * - `404 contact_not_found` (route 10); `404 team_organization_required` / `422` on a personal
 *   organization. A worker operation throws only on a programming error (a malformed Instagram
 *   user id) or a database failure.
 *
 * Side effects:
 * - Writes `app.contacts`; the erase also runs the registered steps' writes. The audit entry is the
 *   controller's, after commit (CT12).
 *
 * Notes:
 * - Only event processing creates or changes a contact; no route adds or edits one (CT2).
 * - Nothing here logs a contact's personal data — log lines carry public ids and counts (K7).
 */
export class ContactService {
  constructor(
    private readonly contactRepository: ContactRepository,
    private readonly organizationService: OrganizationService,
    private readonly erasureSteps: readonly ContactErasureStep[],
    private readonly automationFilterResolver: ContactAutomationFilterResolver,
  ) {}

  /**
   * One page of the organization's live contacts (route 9, CT4, CT6), with the capped total on the
   * first page.
   *
   * @remarks
   * Algorithm: one unit of work — the team check; the `automation_id` filter's automation resolved
   * inside the organization through the automation sub-domain (CT5 — deleted ones included; none
   * → an empty page); then the repository list with the sort and order resolved (default
   * `last_message_received_at`, newest first; `username` A→Z). Failure modes:
   * `404 team_organization_required` on a personal organization. Side effects: none.
   */
  async listContacts({ scope, query }: ContactListInput): Promise<ContactPageOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        const automationId =
          query.automationPublicId === undefined
            ? undefined
            : await this.automationFilterResolver({
                scope,
                organizationId: organization.id,
                automationPublicId: query.automationPublicId,
              });
        const sort = query.sort ?? CONTACT_DEFAULT_SORT;
        const page = await this.contactRepository.list({
          organizationId: organization.id,
          query: { ...query, sort, order: query.order ?? defaultContactOrder(sort), automationId },
        });
        return {
          ...page,
          items: page.items.map((row) =>
            serializeContact({
              contact: row,
              instagram_account_public_id: row.instagram_account_public_id,
            }),
          ),
        };
      },
    });
  }

  /**
   * Erases one contact (route 10, D22, CT7, CT8): locks the live contact, runs every registered
   * erasure step, then clears its personal data and stamps `deleted_at` — all in one transaction.
   * Returns the contact's public id for the controller's audit entry.
   *
   * @remarks
   * Algorithm: one unit of work (`withAppDatabaseContext` is one transaction) — the team check
   * (`422`), `SELECT … FOR UPDATE` of the live contact (`404 contact_not_found`), each step in
   * registration order with `{ organizationId, contactId, instagramUserId }`, the anonymising
   * update. Failure modes: `404 contact_not_found` when absent, another organization's or already
   * erased (a repeat); a step that throws rolls everything back. Side effects: the contact row and
   * the steps' writes. No restore: the data is gone.
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
        return { contactPublicId: erased.public_id };
      },
    });
  }

  /**
   * Creates the contact of one processed comment, DM, story reply or button click, or touches the
   * live one (2.10, CT13) — says whether this event created it, so sub-domain 4 reads the Instagram
   * profile for a new contact only (CQ3).
   *
   * @remarks
   * Algorithm: one upsert on `(organization_id, instagram_account_id, instagram_user_id)` on the
   * job's handle: a new contact's first-seen and last-message times are the event's; an existing
   * one takes the event's username when it carries one and moves its message times forward
   * (`greatest`); every kind but `comment` also moves `last_direct_message_received_at`. Failure
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
      instagramAccountId: input.instagramAccountId,
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
   * Adds a completed run's tags to a live contact (2.10, CT10): the ones it does not hold yet, in
   * order, up to 50 — past 50 a new tag is dropped and logged, and the run still completes.
   * Returns the contact, or `null` once erased.
   *
   * @remarks
   * Algorithm: the live contact's tags, merged in memory (`mergeContactTags`), then one guarded
   * update when a tag was added. Event processing handles one account's events in order (D15), so
   * no other write races this one; route 10's erase wins through the live guard. Failure modes:
   * none — never fails the run. Side effects: one update; one warning log line (counts and public
   * ids only) when tags were dropped.
   */
  async addContactTags({
    databaseHandle,
    organizationId,
    contactId,
    tags,
  }: ContactWorkerKey & { tags: readonly string[] }): Promise<ContactRow | null> {
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
    return repository.replaceTags({ organizationId, contactId, tags: merged.tags });
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
