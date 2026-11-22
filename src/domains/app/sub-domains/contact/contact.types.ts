import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import type { ContactInteractionKind, ContactSortField } from './contact.constants.js';
import type { ContactRow } from './contact.repository.js';

/**
 * The contact object every route returns (routes-final § 2.6): its public id, its Instagram
 * account's public id and every stored field — never the internal ids or `deleted_at` (an erased
 * contact is never returned at all).
 */
export interface ContactOutput {
  /** `con_…`. */
  id: string;
  /** `iga_…` — the account the contact came from (CT13). */
  instagram_account_id: string;
  instagram_user_id: string;
  username: string | null;
  full_name: string | null;
  profile_picture_url: string | null;
  followers_count: number | null;
  /** `null` = never checked. */
  is_following_account: boolean | null;
  follow_checked_at: string | null;
  email: string | null;
  email_collected_at: string | null;
  phone: string | null;
  phone_collected_at: string | null;
  tags: string[];
  first_seen_at: string;
  /** Never null (CT10). */
  last_message_received_at: string;
  last_direct_message_received_at: string | null;
  last_message_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The contact list's parsed query (route 9, routes-final § 2.8) as the service reads it. */
export interface ContactListQuery {
  limit: number;
  after: string | undefined;
  q: string | undefined;
  sort: ContactSortField | undefined;
  order: 'asc' | 'desc' | undefined;
  /** Every one must be held (`tags @> …`); empty = no tag filter. */
  tags: readonly string[];
  hasEmail: boolean | undefined;
  hasPhone: boolean | undefined;
  /** `true` = following, `false` = checked and not following; never-checked matches neither. */
  isFollowingAccount: boolean | undefined;
  /** Inclusive lower bound on `first_seen_at`. */
  firstSeenFrom: Date | undefined;
  /** Exclusive upper bound on `first_seen_at`. */
  firstSeenTo: Date | undefined;
  /** `iga_…` — one account's contacts (CT13); an unknown one gives an empty page. */
  instagramAccountPublicId: string | undefined;
  /** `aut_…` — the contacts that had a run of this automation (CT5); an unknown one gives an empty page. */
  automationPublicId: string | undefined;
}

/** What the repository's list takes: the query with the sort and order already resolved. */
export interface ContactRepositoryListQuery extends Omit<ContactListQuery, 'sort' | 'order'> {
  sort: ContactSortField;
  order: 'asc' | 'desc';
  /**
   * The internal id `automationPublicId` names (CT5): `undefined` = no automation filter; `null` =
   * no such automation in the organization, so the page is empty.
   */
  automationId: number | null | undefined;
}

/** One page of contacts as the service returns it to the controller. */
export interface ContactPageOutput {
  items: ContactOutput[];
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
  /** The capped total on the first page; `null` after it. */
  total: number | null;
}

/**
 * What one registered erasure step receives (routes-final § 2.10, CT8): the erased contact, inside
 * route 10's transaction, before the row itself is anonymised.
 */
export interface ContactErasureStepInput {
  /** `tenancy.organizations.id`. */
  organizationId: number;
  /** `app.contacts.id`. */
  contactId: number;
  /** The contact's Instagram user id, still set when the step runs (cleared right after). */
  instagramUserId: string;
}

/**
 * A step another sub-domain registers through the app container to erase its copies of a
 * contact's personal data in the same transaction as the contact (CT8) — sub-domain 3's comment
 * logs and run trigger text. It runs inside route 10's unit of work, so its repository calls join
 * that transaction; a throw rolls the whole erase back.
 */
export type ContactErasureStep = (input: ContactErasureStepInput) => Promise<void>;

/**
 * The contacts list's automation lookup (routes-final § 3.B.8, CT5): the internal id of the
 * organization's automation with this public id — deleted ones included, their runs stay — or
 * `null`. The app container fills it with sub-domain 3's `findAutomationIdForFilter`, so contacts
 * never import the automation sub-domain (CT8's hook pattern); it runs inside the list's unit of
 * work.
 */
export type ContactAutomationFilterResolver = (input: {
  scope: OrganizationPrincipalDatabaseScope;
  /** `tenancy.organizations.id` of the scope's organization. */
  organizationId: number;
  /** `aut_…` from the query. */
  automationPublicId: string;
}) => Promise<number | null>;

/** The organization and the job's database handle every worker-side contact operation runs on (CT2). */
export interface ContactWorkerTarget {
  /** The handle of the caller's organization-scoped job (`runOrganizationScopedWorkerJob`). */
  databaseHandle: WorkerDatabaseHandle;
  /** `tenancy.organizations.id` — every statement names it (be-rls-tenant-isolation-guard). */
  organizationId: number;
}

/** One live contact of the job's organization (CT2). */
export interface ContactWorkerKey extends ContactWorkerTarget {
  /** `app.contacts.id`. */
  contactId: number;
}

/** Input of `recordContactInteraction` (routes-final § 2.10). */
export interface RecordContactInteractionInput extends ContactWorkerTarget {
  /** `app.instagram_accounts.id` — the account the event came to (CT13). */
  instagramAccountId: number;
  /** The webhook's `sender.id` / `from.id`. */
  instagramUserId: string;
  /** The username the event carried, when it carried one. */
  username: string | null;
  /** The event's own time. */
  occurredAt: Date;
  interactionKind: ContactInteractionKind;
}

/** The result of `recordContactInteraction`: the live contact and whether this event created it. */
export interface ContactInteractionResult {
  contact: ContactRow;
  /** `true` when the event created the contact — sub-domain 4 reads the profile then (CQ3). */
  isNewContact: boolean;
}

/** What one Instagram profile read or follow check found; a field left `undefined` is not touched. */
export interface ContactProfileInput {
  username?: string | null;
  fullName?: string | null;
  profilePictureUrl?: string | null;
  followersCount?: number | null;
  /** The follow check's answer; sets `follow_checked_at` too. */
  isFollowingAccount?: boolean;
}

/** The answer of `recordContactEmail` / `recordContactPhone` for a live contact. */
export type ContactCollectedValueResult =
  | { outcome: 'saved'; contact: ContactRow }
  | { outcome: 'invalid' };

/** Input of route 9's service call. */
export interface ContactListInput {
  scope: OrganizationPrincipalDatabaseScope;
  query: ContactListQuery;
}

/** Input of route 10's service call. */
export interface ContactDeleteInput {
  scope: OrganizationPrincipalDatabaseScope;
  /** `con_…` from the path. */
  contactPublicId: string;
}
