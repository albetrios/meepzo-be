import type {
  ChannelActivityCursor,
  ChannelInboundEventKind,
} from '@/domains/app/app.channel-ports.js';
import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import type {
  ContactBulkAction,
  ContactInteractionKind,
  ContactPauseReason,
  ContactSortField,
} from './contact.constants.js';
import type { ContactRow } from './contact.repository.js';

/**
 * The Contact object (routes-final § 3.A.6, route 18): its public id, its channel account's public id,
 * every stored identity field, her activity times and the owner's and her own choices — never the
 * internal ids, the note (the detail's) or `deleted_at` (an erased contact is never returned).
 */
export interface ContactOutput {
  /** `con_…`. */
  id: string;
  /** `cha_…` — the account the contact came from (CT2). */
  channel_account_id: string;
  /** `instagram` (D27). */
  channel: string;
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
  /** She wrote a stop word (CT6). */
  is_opted_out: boolean;
  opted_out_at: string | null;
  /** The team paused automations for her (CT5). */
  is_automations_paused: boolean;
  automations_paused_at: string | null;
  /** The way to start of her first run, or `null`. */
  came_in_via: string | null;
  came_in_ref: string | null;
  /** `aut_…` of her first run's automation, or `null`. */
  first_automation_id: string | null;
  first_seen_at: string;
  /** Never null. */
  last_message_received_at: string;
  last_direct_message_received_at: string | null;
  last_message_sent_at: string | null;
  first_message_at: string | null;
  last_comment_at: string | null;
  comment_count: number;
  last_story_activity_at: string | null;
  last_broadcast_at: string | null;
  /** Her last DM, story reply or tap + 24 h − 15 min is still ahead. */
  is_chat_open: boolean;
  created_at: string;
  updated_at: string;
}

/** The Contact detail object (routes 19, 20): the Contact plus the owner-only fields (CT13). */
export interface ContactDetailOutput extends ContactOutput {
  note: string | null;
  /** `usr_…` of who paused her, or `null`. */
  automations_paused_by_user_id: string | null;
  last_opening_message_at: string | null;
  /** Her first run's automation — a deleted one keeps its name until purged — or `null`. */
  first_automation: { id: string; name: string } | null;
  /** Her `running` and `waiting` runs. */
  open_run_count: number;
}

/** One row of route 22 (CT8). */
export interface ContactTagCountOutput {
  tag: string;
  contact_count: number;
}

/** Route 21's answer (CT7). */
export interface ContactBulkActionOutput {
  action: ContactBulkAction;
  matched_count: number;
  /** Always `true`: the job is queued. */
  is_queued: true;
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
  /** `cha_…` — the account whose contacts are listed (CT2, required); an unknown one gives an empty page. */
  channelAccountPublicId: string;
  /** `aut_…` — the contacts that had a run of this automation (CT5); an unknown one gives an empty page. */
  automationPublicId: string | undefined;
  /** Opted out (`true`) or not (`false`) (CT12). */
  isOptedOut: boolean | undefined;
  /** Automations paused (`true`) or not (`false`) (CT12). */
  isAutomationsPaused: boolean | undefined;
  /** One or more ways to start of her first run; empty = no filter (CT12). */
  cameInVia: readonly string[];
  /** `aut_…` of her first run's automation (CT12); an unknown one gives an empty page. */
  firstAutomationPublicId: string | undefined;
}

/** What the repository's list takes: the query with the sort and order already resolved. */
export interface ContactRepositoryListQuery
  extends Omit<ContactListQuery, 'sort' | 'order' | 'channelAccountPublicId'> {
  sort: ContactSortField;
  order: 'asc' | 'desc';
  /** The internal id of the listed account (the service resolved `channelAccountPublicId`). */
  channelAccountId: number;
  /** As `automationId`, for `firstAutomationPublicId`. */
  firstAutomationId: number | null | undefined;
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

/** Input of `recordContactInteraction` (routes-final § 2.10, CT18). */
export interface RecordContactInteractionInput extends ContactWorkerTarget {
  /** `app.channel_accounts.id` — the account the event came to (CT2). */
  channelAccountId: number;
  /** The webhook's `sender.id` / `from.id`. */
  instagramUserId: string;
  /** The username the event carried, when it carried one. */
  username: string | null;
  /** The event's own time. */
  occurredAt: Date;
  interactionKind: ContactInteractionKind;
}

/**
 * Input of `recordInboundContactEvent` (routes-final § 3.A.10, CT18 — the inbound seam): one saved
 * event of a person, in channel-neutral words — the provider's person id and the normalized kind.
 */
export interface RecordInboundContactEventInput extends ContactWorkerTarget {
  /** `app.channel_accounts.id` — the account the event came to (CT2). */
  channelAccountId: number;
  /** The provider's id of the person (Instagram's `sender.id` / `from.id`) — digits. */
  providerUserId: string;
  /** The normalized kind (WH27); `owner_message` never reaches contacts. */
  kind: Exclude<ChannelInboundEventKind, 'owner_message'>;
  /** The event's own time. */
  occurredAt: Date;
  /** The username the event carried, when it carried one. */
  username: string | null;
}

/** The result of `recordInboundContactEvent`. */
export interface InboundContactEventResult extends ContactInteractionResult {
  /** `true` when this event is her first message in the chat (`first_message_at` was empty). */
  isFirstMessage: boolean;
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

/** Input of route 18's service call. */
export interface ContactListInput {
  scope: OrganizationPrincipalDatabaseScope;
  query: ContactListQuery;
}

/** Input of route 23's (and route 19's) service call. */
export interface ContactDeleteInput {
  scope: OrganizationPrincipalDatabaseScope;
  /** `con_…` from the path. */
  contactPublicId: string;
}

/**
 * What one registered pause step receives (routes-final § 3.10, CTC4): the contact whose automations
 * stop, inside the commit that sets her pause (route 20, the bulk job) or her opt-out (CT6).
 */
export interface ContactPauseStepInput {
  /** `tenancy.organizations.id`. */
  organizationId: number;
  /** `app.contacts.id`. */
  contactId: number;
  /** `contact_excluded` (the owner's pause) or `opted_out` (her stop word). */
  reason: ContactPauseReason;
  /**
   * The job's handle when the pause runs in a worker unit (the opt-out, the bulk job); `undefined`
   * on a route, whose repositories join the request's unit of work.
   */
  databaseHandle?: WorkerDatabaseHandle;
}

/**
 * A step another sub-domain registers through the app container to stop what it holds for a contact
 * whose automations are paused (CTC4, beside {@link ContactErasureStep}): 4.B cancels her open runs,
 * 6 skips her waiting messages — each with the reason given. It runs inside the pausing unit of work,
 * so a throw rolls the pause back.
 */
export type ContactPauseStep = (input: ContactPauseStepInput) => Promise<void>;

/**
 * One tag change as the tag-event recorder receives it (CT5; the table is 3.B's, ROUTE row R11).
 */
export interface ContactTagChangeEvent {
  organizationId: number;
  channelAccountId: number;
  contactId: number;
  tag: string;
  kind: 'added' | 'removed';
  /** `owner` (routes 20, 21) or `automation` (the tag step). */
  source: 'owner' | 'automation';
  /** The automation of a tag step; `null` for the owner. */
  sourceAutomationId: number | null;
  /** How many tag starts led to this change (0 for the owner). */
  chainNumber: number;
}

/**
 * The tag-event port (routes-final § 3.B, CT5, D45): writes one `app.contact_tag_events` row per
 * change inside the tag change's unit of work and hands the events to intake after commit. ROUTE
 * row R11 built it — `ContactTagEventService` (`contact/contact-tag-event/`), passed by the app
 * container as `ports.tagEventRecorder`.
 */
export interface ContactTagEventRecorder {
  /** Writes the events in the caller's unit of work (the request's, or the job's handle). */
  recordContactTagEvents(input: {
    events: readonly ContactTagChangeEvent[];
    databaseHandle?: WorkerDatabaseHandle;
  }): Promise<void>;
}

/** One bulk action as route 21 hands it to the job (CT7, WC-36). */
export interface ContactBulkActionJobInput {
  organizationPublicId: string;
  channelAccountPublicId: string;
  action: ContactBulkAction;
  /** The tag of `add_tag` / `remove_tag`; `null` for the pause actions. */
  tag: string | null;
  /** Exactly one of the two selections. */
  contactPublicIds: readonly string[] | null;
  /** The list filters (route 18's, without sort and paging), as validated. */
  filter: ContactBulkActionFilter | null;
  /** The acting user's public id — the pause's `automations_off_by_user_id`. */
  actorUserPublicId: string;
}

/**
 * One piece of a bulk action as the `contact-bulk-action` job hands it to the contact service
 * (WC-36, R46): the action and selection of route 21, and the cursor.
 */
export interface ContactBulkActionPieceInput {
  channelAccountPublicId: string;
  action: ContactBulkAction;
  tag: string | null;
  contactPublicIds: readonly string[] | null;
  filter: ContactBulkActionFilter | null;
  /** The acting user's public id — the pause's `automations_off_by_user_id`. */
  actorUserPublicId: string;
  /** The contact the previous piece ended on (`con_…`); `null` for the first piece. */
  afterContactPublicId: string | null;
}

/** What one bulk piece did (WC-36): how many contacts changed, the cursor, whether it was the last. */
export interface ContactBulkActionPieceResult {
  changedCount: number;
  /** The last contact the piece read (`con_…`) — the next piece's cursor. */
  lastContactPublicId: string | null;
  isLastPiece: boolean;
}

/** The list filters a bulk action may select by (route 21's `filter`, CT7). */
export type ContactBulkActionFilter = Omit<
  ContactListQuery,
  'limit' | 'after' | 'sort' | 'order' | 'channelAccountPublicId'
>;

/**
 * The bulk-action queue port (CT7, WC-36): enqueues the first `contact-bulk-action` job on the
 * database-heavy task queue (`instagram-database-tasks`, S19 — ROUTE row R46), after route 21's
 * count, which works the selection in pieces of 500, each piece chaining the next. The app container
 * passes it; without it (a unit test) route 21 answers `503 contact_bulk_action_unavailable`.
 */
export interface ContactBulkActionQueue {
  enqueueContactBulkAction(input: ContactBulkActionJobInput): Promise<void>;
}

/**
 * The detail's automation summary (CT13): the `{ id, name }` of her first run's automation — a
 * deleted one included until purged — or `null`.
 */
export interface ContactFirstAutomationSummary {
  id: string;
  name: string;
}

/** What `findContactSendState` answers (3.A.10): every send's gate re-reads it. */
export interface ContactSendState {
  isErased: boolean;
  isOptedOut: boolean;
  isAutomationsPaused: boolean;
  lastDirectMessageReceivedAt: Date | null;
}

/** Route 20's parsed body (CT5). */
export interface ContactUpdateInput {
  /** `undefined` = unchanged; `null` = cleared. */
  note: string | null | undefined;
  addTags: readonly string[];
  removeTags: readonly string[];
  isAutomationsPaused: boolean | undefined;
  expectedUpdatedAt: Date | undefined;
}

/** Route 21's parsed body (CT7). */
export interface ContactBulkActionInput {
  channelAccountPublicId: string;
  action: ContactBulkAction;
  tag: string | null;
  contactPublicIds: readonly string[] | null;
  filter: ContactBulkActionFilter | null;
}

/**
 * One run event of her "what happened" (routes-final § 3.A CT14, route 24), as the run engine's
 * reader answers it — the app container passes `AutomationRunService.listContactRunEvents`, so
 * contacts never import the automation sub-domain.
 */
export interface ContactRunEventEntry {
  id: number;
  /** `cursorTimestampSelection` text of the event's time. */
  cursor_created_at: string;
  event_type: string;
  status: string | null;
  automation_public_id: string;
  automation_name: string;
  automation_run_public_id: string;
}

/** The run engine's reader of her runs' history (route 24), newest first after the cursor. */
export type ContactRunEventReader = (input: {
  scope: OrganizationPrincipalDatabaseScope;
  organizationId: number;
  contactId: number;
  after: ChannelActivityCursor | null;
  limit: number;
}) => Promise<ContactRunEventEntry[]>;

/** One Contact activity item (routes-final § 3.A.6, route 24) — never her own text. */
export interface ContactActivityItemOutput {
  /** The message's `igm_…`; `null` for a run event (run events carry no public id). */
  id: string | null;
  source: 'message' | 'run_event';
  occurred_at: string;
  automation: { id: string; name: string } | null;
  automation_run_id: string | null;
  broadcast_id: string | null;
  message_type?: string;
  message_number?: number | null;
  status: string | null;
  reason?: string | null;
  channel?: string | null;
  event_type?: string;
}

/** Route 24's page: the items, the next cursor and why older entries show only run history. */
export interface ContactActivityPageOutput {
  items: ContactActivityItemOutput[];
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
  messageHorizonDays: number;
}
