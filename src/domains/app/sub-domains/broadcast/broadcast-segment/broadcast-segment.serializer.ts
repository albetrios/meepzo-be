import { countSegmentConditions, type SegmentConditions } from './broadcast-segment.dto.js';
import type {
  SegmentAudienceCount,
  SegmentAudienceCountOutput,
  SegmentOutput,
} from './broadcast-segment.types.js';

/** The columns the Segment object reads: the row and its account's public id. */
export interface SegmentSerializableRow {
  public_id: string;
  name: string;
  conditions: SegmentConditions;
  created_at: Date;
  updated_at: Date;
  /** `cha_…` of the segment's account. */
  channel_account_public_id: string;
}

/**
 * The Segment object (routes-final § 7.B.6): public ids only — never the internal ids, the editor
 * or `deleted_at`; `condition_count` counts the conditions in all groups.
 */
export function serializeSegment({
  segment,
  created_by_user_public_id,
}: {
  segment: SegmentSerializableRow;
  /** `usr_…` of who saved it, or `null`. */
  created_by_user_public_id: string | null;
}): SegmentOutput {
  return {
    id: segment.public_id,
    channel_account_id: segment.channel_account_public_id,
    name: segment.name,
    conditions: segment.conditions,
    condition_count: countSegmentConditions(segment.conditions),
    created_by_user_id: created_by_user_public_id,
    created_at: segment.created_at.toISOString(),
    updated_at: segment.updated_at.toISOString(),
  };
}

/** The Audience count object (route 82): the numbers, or the counting answer when `null` (BC14). */
export function serializeSegmentAudienceCount(
  count: SegmentAudienceCount | null,
): SegmentAudienceCountOutput {
  if (count === null) {
    return { matched: null, can_receive_now: null, is_counting: true, counted_at: null };
  }
  return {
    matched: count.matched,
    can_receive_now: count.canReceiveNow,
    is_counting: false,
    counted_at: count.countedAt.toISOString(),
  };
}
