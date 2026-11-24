import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { ChannelFeature } from '@/domains/app/sub-domains/channel-account/channel-account-capabilities.constants.js';
import type { ChannelFeatureCheckResult } from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import type { SegmentSortField } from './broadcast-segment.constants.js';
import type { SegmentConditions } from './broadcast-segment.dto.js';

/** Route 77's query as the service reads it (7.B.8). */
export interface SegmentListQuery {
  /** `cha_…` — required (BC5). */
  channelAccountPublicId: string;
  q?: string | undefined;
  sort?: SegmentSortField | undefined;
  order?: 'asc' | 'desc' | undefined;
  limit: number;
  after?: string | undefined;
}

/** Route 77's query as the repository reads it: the account resolved, sort and order chosen. */
export interface SegmentRepositoryListQuery {
  channelAccountId: number;
  q?: string | undefined;
  sort: SegmentSortField;
  order: 'asc' | 'desc';
  limit: number;
  after?: string | undefined;
}

/** Route 78's body as the service reads it. */
export interface SegmentCreateInput {
  channelAccountPublicId: string;
  name: string;
  conditions: SegmentConditions;
}

/** Route 80's body as the service reads it (BC15). */
export interface SegmentUpdateInput {
  name?: string | undefined;
  conditions?: SegmentConditions | undefined;
  expectedUpdatedAt?: string | undefined;
}

/** Route 82's body as the service reads it (BC14): exactly one of the two is set. */
export interface SegmentAudienceCountInput {
  channelAccountPublicId: string;
  segmentPublicId?: string | undefined;
  conditions?: SegmentConditions | undefined;
}

/** The Segment object (7.B.6). */
export interface SegmentOutput {
  /** `seg_…`. */
  id: string;
  /** `cha_…`. */
  channel_account_id: string;
  name: string;
  conditions: SegmentConditions;
  /** How many conditions the tree holds, in all its groups. */
  condition_count: number;
  /** `usr_…` of who saved it, or `null` (an API key, or a removed user). */
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/** One page of route 77. */
export interface SegmentPageOutput {
  items: SegmentOutput[];
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
  /** The capped total on the first page; `null` on the next ones. */
  total: number | null;
}

/** The Audience count object (route 82, 7.B.6). */
export interface SegmentAudienceCountOutput {
  /** Live contacts the conditions match, the always-left-out ones excluded; `null` while counting. */
  matched: number | null;
  /** Of those, the ones whose chat is open now (24 hours less 15 minutes); `null` while counting. */
  can_receive_now: number | null;
  /** `true` when the count went to the background (BC14) — ask again. */
  is_counting: boolean;
  /** When the numbers were counted; `null` while counting. */
  counted_at: string | null;
}

/** The audience numbers one count finds (BC13). */
export interface SegmentAudienceCount {
  matched: number;
  canReceiveNow: number;
  countedAt: Date;
}

/** What identifies one background count (BC14): the account and a hash of its conditions. */
export interface SegmentBackgroundCountKey {
  /** `org_…` — the job is a tenant job (be-workers-events). */
  organizationPublicId: string;
  /** `cha_…`. */
  channelAccountPublicId: string;
  /** A stable hash of the conditions, the dedupe key with the account. */
  conditionsHash: string;
  conditions: SegmentConditions;
}

/**
 * The background count of route 82 (BC14, WC-39) — the `segment-count` task and its 60-second
 * organization-scoped Redis copy, built by ROUTE row R46.
 *
 * @remarks
 * Notes: until R46 passes it, the service has none — an inline count past its 2 s timeout answers
 * `503 segment_count_unavailable` instead of a background answer that nothing would fill.
 */
export interface SegmentBackgroundCountPort {
  /** The Redis copy the task wrote for this key, or `null` (a miss, expired, or Redis down). */
  readCount(key: SegmentBackgroundCountKey): Promise<SegmentAudienceCount | null>;
  /** Enqueues the task, deduplicated by the account and the hash. */
  requestCount(key: SegmentBackgroundCountKey): Promise<void>;
}

/**
 * 1B's one feature check (CA11, P50) as the segment service asks it — the `segments` switch (BC19).
 * The app container passes `ChannelAccountService.canChannelAccountUseFeature`.
 */
export type SegmentFeatureCheck = (options: {
  scope: OrganizationPrincipalDatabaseScope;
  organizationId: number;
  channelAccountId: number;
  feature: ChannelFeature;
}) => Promise<ChannelFeatureCheckResult>;

/** The caller of a write route: its organization scope and user. */
export interface SegmentCaller {
  scope: OrganizationPrincipalDatabaseScope;
  /** `usr_…` of the signed-in user; empty for an API key. */
  userPublicId: string;
}
