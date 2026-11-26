import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { ChannelFeature } from '@/domains/app/sub-domains/channel-account/channel-account-capabilities.constants.js';
import type { EntitlementSnapshot } from '@/domains/billing/sub-domains/entitlement/entitlement.types.js';
import type {
  AutomationChannelAccount,
  ChannelFeatureCheckResult,
} from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import type { SegmentConditions } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';
import type { BroadcastMode, BroadcastSortField } from './broadcast.constants.js';
import type { BroadcastMessages } from './broadcast.dto.js';

/** Route 70's query as the service reads it (7.A.8). */
export interface BroadcastListQuery {
  /** `cha_…` — required (BC5). */
  channelAccountPublicId: string;
  statuses: readonly string[];
  mode?: BroadcastMode | undefined;
  q?: string | undefined;
  sort?: BroadcastSortField | undefined;
  order?: 'asc' | 'desc' | undefined;
  limit: number;
  after?: string | undefined;
}

/** Route 70's query as the repository reads it: the account resolved, sort and order chosen. */
export interface BroadcastRepositoryListQuery {
  channelAccountId: number;
  statuses: readonly string[];
  mode?: BroadcastMode | undefined;
  q?: string | undefined;
  sort: BroadcastSortField;
  order: 'asc' | 'desc';
  limit: number;
  after?: string | undefined;
}

/**
 * The fields a person writes on a broadcast (routes 71, 73): `undefined` leaves a field as it is on
 * route 73, `null` clears it.
 */
export interface BroadcastWritableInput {
  name?: string | undefined;
  /** `seg_…`, or `null` to clear. */
  segmentPublicId?: string | null | undefined;
  conditions?: SegmentConditions | null | undefined;
  messages?: BroadcastMessages | undefined;
  /** `aut_…`, or `null` to clear. */
  startAutomationPublicId?: string | null | undefined;
}

/** Route 71's body as the service reads it. */
export interface BroadcastCreateInput extends BroadcastWritableInput {
  channelAccountPublicId: string;
  name: string;
}

/** Route 73's body as the service reads it. */
export interface BroadcastUpdateInput extends BroadcastWritableInput {
  expectedUpdatedAt?: string | undefined;
}

/** Route 75's body as the service reads it (BC10). */
export type BroadcastSendInput =
  | { mode: 'now' }
  | { mode: 'scheduled'; scheduledAt: Date }
  | { mode: 'when_chat_opens'; openWaitDays: number };

/** The six numbers of a broadcast (BC8). */
export interface BroadcastNumbersOutput {
  matched: number;
  sent: number;
  skipped: number;
  failed: number;
  replies: number;
  taps: number;
}

/** The Broadcast object (7.A.6). */
export interface BroadcastOutput {
  /** `brc_…`. */
  id: string;
  /** `cha_…`. */
  channel_account_id: string;
  name: string;
  status: string;
  mode: string;
  /** `seg_…` of the saved audience, or `null`. */
  segment_id: string | null;
  /** The one-off conditions in a draft; the copy once sent. */
  conditions: SegmentConditions | null;
  messages: BroadcastMessages;
  /** `aut_…` of the automation its button starts, or `null` (BC8). */
  start_automation_id: string | null;
  scheduled_at: string | null;
  ends_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  numbers: BroadcastNumbersOutput;
  /** `usr_…` of who made it, or `null` (an API key, or a removed user). */
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/** One page of route 70. */
export interface BroadcastPageOutput {
  items: BroadcastOutput[];
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
  /** The capped total on the first page; `null` on the next ones. */
  total: number | null;
}

/** The caller of a write route: its organization scope and user. */
export interface BroadcastCaller {
  scope: OrganizationPrincipalDatabaseScope;
  /** `usr_…` of the signed-in user; empty for an API key. */
  userPublicId: string;
}

/**
 * 1B's one feature check (CA11, P50) as the broadcast service asks it — the `broadcasts` switch
 * (BC3). The app container passes `ChannelAccountService.canChannelAccountUseFeature`.
 */
export type BroadcastFeatureCheck = (options: {
  scope: OrganizationPrincipalDatabaseScope;
  organizationId: number;
  channelAccountId: number;
  feature: ChannelFeature;
  /** The route guard's snapshot on the send (K2); without one the check resolves once. */
  entitlement?: EntitlementSnapshot | undefined;
}) => Promise<ChannelFeatureCheckResult>;

/**
 * The channel account as the broadcasts read it (BC5, BC10): by public id (route 71) or internal id
 * (send), with its connection's status — `ChannelAccountService.readAutomationAccount`.
 */
export type BroadcastAccountRead = (options: {
  scope: OrganizationPrincipalDatabaseScope;
  organizationId: number;
  account: { channelAccountPublicId: string } | { channelAccountId: number };
}) => Promise<AutomationChannelAccount | null>;

/**
 * Sub-domain 6's month count as route 75 asks it (BC10): this month's numbers when the
 * organization's DMs are used up, else `null` — `MessageMonthCountService.readMonthLimitReached`
 * (R18), reading the ceiling from the request's entitlement snapshot (change-plan-gates AP4, P6).
 */
export interface BroadcastMonthLimitPort {
  readMonthLimitReached(input: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    /** The route guard's snapshot (K2); without one the month count resolves once. */
    entitlement?: EntitlementSnapshot | undefined;
  }): Promise<{ limit: number; used: number; resetsOn: string } | null>;
}

/** The upload domain's usable-file read (R12) — a message's file at send (BC10, D58). */
export interface BroadcastMessageFilePort {
  findUsableMessageFile(input: {
    scope: OrganizationPrincipalDatabaseScope;
    uploadPublicId: string;
  }): Promise<{ upload_public_id: string; content_type: string } | null>;
}

/** What one sent broadcast hands the background work after route 75's commit (BC10). */
export interface BroadcastSentKey {
  /** `org_…` — the jobs are tenant jobs (be-workers-events). */
  organizationPublicId: string;
  /** `brc_…`. */
  broadcastPublicId: string;
  /** `cha_…`. */
  channelAccountPublicId: string;
}

/**
 * The background work route 75 starts after its commit (BC10) — the `broadcast-audience` task
 * (WC-40) for `now` and the `segment-count` task (WC-39) for `matched` of `when_chat_opens`, both on
 * `instagram-tasks`, built by ROUTE row R46. `scheduled` starts nothing: the start duty (WC-28, ROUTE
 * row R47) moves it to `sending` at its time and adds the audience task then.
 *
 * @remarks
 * Notes: until R46 passes it, the service has none — the broadcast stays `sending` with no
 * recipients (R23) and the end duty (R47) is not there to end it; a send is still recorded.
 */
export interface BroadcastSendQueuePort {
  /** Adds the `broadcast-audience` task (WC-40), deduplicated by the broadcast. */
  enqueueBroadcastAudience(key: BroadcastSentKey): Promise<void>;
  /** Adds the `segment-count` task (WC-39) that fills `matched` of a waiting broadcast. */
  enqueueBroadcastMatchedCount(key: BroadcastSentKey): Promise<void>;
}

/**
 * The ports the broadcast service reads (KICKOFF build-order rule): the month count (R18), the
 * usable-file read (R12) and the send's background work (R46).
 *
 * @remarks
 * Notes: all optional — no month count checks no month limit, no file read checks no file, no send
 * queue starts no background work (a unit test passes none).
 */
export interface BroadcastServicePorts {
  monthLimit?: BroadcastMonthLimitPort | undefined;
  messageFilePort?: BroadcastMessageFilePort | undefined;
  sendQueue?: BroadcastSendQueuePort | undefined;
}
